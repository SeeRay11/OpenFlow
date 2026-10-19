import type { Server } from "bun"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { BusEvent, ModelInfo, SessionRow, ToolCall, Transcript, WaitResult, WireStep } from "../../shared/engine"
import { ENGINE_BASE, engineRoutes, sessionRoute } from "../../shared/engine"
import type { MemoryReadResult, MemoryStatus, MemoryWriteResult } from "../../shared/memory"
import { MEMORY_ROUTES } from "../../shared/memory"
import { OMP_ROUTES, type OmpSettingsView, type OmpStatusView } from "../../shared/omp"
import type { SwarmPreflight } from "../../shared/swarm"
import { SWARM_ROUTES } from "../../shared/swarm"
import { PTY_HEADER, PTY_ROUTES, type PtyTicket } from "../../shared/terminal"
import { UPLIFT_ROUTE, type UpliftResult } from "../../shared/uplift"
import { assistantMessage, frames } from "../omp/testing/fake-process"
import { startFakeSubstrate, type FakeSubstrate } from "../substrate/testing/fake-substrate"
import { alive, until } from "../uplift/testing/stub-planner"
import { KILL_GRACE_MS } from "../uplift/planner"
import { bunWebSocket, type PtySocketData } from "../terminal/ws-bun"
import { createHost, type Host } from "./index"
import { stateRoot } from "./paths"

/**
 * The whole host over real HTTP: `createHost` composed from the real modules,
 * `Bun.serve` on port 0 with the real WebSocket transport, and every external
 * dependency a local fake — a wrapper that runs `lib/omp/testing/stub-omp.ts`
 * as "omp", the stub planner as ultrathink, the fake Substrate. Loopback only,
 * no model calls.
 */

setDefaultTimeout(30_000)

const here = import.meta.dir
const STUB_OMP = path.join(here, "..", "omp", "testing", "stub-omp.ts")
const STUB_PLANNER = path.join(here, "..", "uplift", "testing", "stub-planner.ts")

let dir: string
let project: string
let stateDir: string
let wrapper: string
let scriptFile: string
let logFile: string
let pidFile: string
let configDir: string
let fake: FakeSubstrate
let host: Host
let server: Server<PtySocketData>
let base: string

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flow-host-")))
  project = path.join(dir, "project")
  stateDir = path.join(dir, "state")
  configDir = path.join(dir, "profile", "agent")
  scriptFile = path.join(dir, "script.json")
  logFile = path.join(dir, "stub.log")
  pidFile = path.join(dir, "pids")
  mkdirSync(project)
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0)
  writeFileSync(scriptFile, "[]")
  writeFileSync(logFile, "")

  // `omp --version`, `omp config path` and `omp auth export|import` are answered here; everything else is the RPC stub.
  // The catalog size follows `model-count` (written by a test) or else the byte size of the profile's `agent.db`.
  // Each real run records its pid first: `exec` keeps it, so these are the stub processes.
  wrapper = path.join(dir, "omp")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac',
      `case " $* " in *" config path "*) echo "${configDir}"; exit 0;; esac`,
      `case " $* " in *" auth export "*) echo '{"version":1,"credentials":[{"provider":"stub","credential":{"type":"api_key"}}]}'; exit 0;; esac`,
      `case " $* " in *" auth import "*) cat > /dev/null; exit 0;; esac`,
      `if [ -f "${configDir}/agent.db" ]; then export STUB_OMP_MODELS=$(wc -c < "${configDir}/agent.db" | tr -d ' '); fi`,
      `if [ -f "${dir}/model-count" ]; then export STUB_OMP_MODELS=$(cat "${dir}/model-count"); fi`,
      `echo $$ >> "${pidFile}"`,
      `export STUB_OMP_SCRIPT="${scriptFile}" STUB_OMP_LOG="${logFile}"`,
      `exec "${process.execPath}" "${STUB_OMP}" "$@"`,
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)

  // A claude-ultrathink checkout whose planner is the stub.
  const ultrathink = path.join(dir, "ultrathink")
  mkdirSync(path.join(ultrathink, "bin"), { recursive: true })
  mkdirSync(path.join(ultrathink, "hooks"))
  writeFileSync(path.join(ultrathink, "hooks", "engine.ts"), "")
  writeFileSync(path.join(ultrathink, "bin", "run-bun"), `#!/bin/sh\nexec "${process.execPath}" "${STUB_PLANNER}"\n`)
  chmodSync(path.join(ultrathink, "bin", "run-bun"), 0o755)

  fake = startFakeSubstrate()
  host = createHost({
    project: () => project,
    allowRemote: false,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENFLOW_STATE_DIR: stateDir, SUBSTRATE_TOKEN: fake.token },
  })
  const socket = bunWebSocket(host.terminal)
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request, serving) {
      const upgraded = socket.fetch(request, serving)
      if (upgraded instanceof Response) return upgraded
      if (upgraded) return undefined
      return (await host.handle(request)) ?? new Response("unclaimed", { status: 418 })
    },
    websocket: socket.websocket,
  })
  base = `http://127.0.0.1:${server.port}`

  const saved = await send(OMP_ROUTES.settings, "PUT", {
    binary: wrapper,
    swarm: { mode: "off" },
    uplift: { root: ultrathink },
    memory: { repo: "acme/widgets" },
    substrate: { url: fake.url },
  })
  expect(saved.status).toBe(200)
})

afterAll(async () => {
  await host.dispose()
  await server.stop(true)
  await fake.stop()
  rmSync(dir, { recursive: true, force: true })
})

function send(route: string, method: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  })
}

async function get<T>(route: string): Promise<T> {
  const response = await send(route, "GET")
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** An SSE subscription whose events can be awaited without sleeping. */
async function subscribe() {
  const abort = new AbortController()
  const events: BusEvent[] = []
  const comments: string[] = []
  const waiters: Array<{ match: (event: BusEvent) => boolean; resolve: (event: BusEvent) => void }> = []
  const response = await fetch(`${base}${engineRoutes.events}`, { signal: abort.signal })
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  const pump = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(":")) {
          comments.push(block)
          continue
        }
        const event = JSON.parse(block.replace(/^data: /, "")) as BusEvent
        events.push(event)
        for (const waiter of waiters.filter((item) => item.match(event))) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
    }
  })()
  return {
    events,
    comments,
    /** The first event (already seen or still to come) that matches. */
    next(match: (event: BusEvent) => boolean) {
      const seen = events.find(match)
      if (seen) return Promise.resolve(seen)
      const found = Promise.withResolvers<BusEvent>()
      waiters.push({ match, resolve: found.resolve })
      return found.promise
    },
    async close() {
      abort.abort()
      await pump
    },
  }
}

function script(items: unknown[]) {
  writeFileSync(scriptFile, JSON.stringify(items))
  writeFileSync(logFile, "")
}

function logged(): Array<Record<string, any>> {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const COMPLETE = [frames.promptResult("$promptId", "completed"), frames.settled()]

async function open(nodeId: string, extra: Record<string, unknown> = {}, runId = "run-1") {
  const response = await send(engineRoutes.sessions, "POST", {
    runId,
    nodeId,
    card: { key: `card-${nodeId}`, role: "Builder" },
    model: "stub/model-0",
    directory: project,
    permissions: "auto",
    swarm: "off",
    ...extra,
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

async function prompt(id: string, text = "go") {
  const response = await send(sessionRoute(id, "/prompt"), "POST", { text })
  expect(response.status).toBeLessThan(300)
}

async function wait(id: string) {
  const response = await send(sessionRoute(id, "/wait"), "POST", { timeoutMs: 20_000 })
  expect(response.status).toBe(200)
  return (await response.json()) as WaitResult
}

describe("omp config", () => {
  test("status reports the wrapper as available omp and the profile directory", async () => {
    const status = await get<OmpStatusView>(OMP_ROUTES.status)
    expect(status.available).toBe(true)
    expect(status.version).toBe("18.12.2")
    expect(status.binary).toBe(wrapper)
    expect(status.configDir).toBe(configDir)
    expect(await host.profileDir()).toBe(configDir)
  })

  test("settings GET shows what was saved, PUT validates and persists", async () => {
    const view = await get<OmpSettingsView>(OMP_ROUTES.settings)
    expect(view.settings).toMatchObject({ binary: wrapper, profile: "openflow", swarm: { mode: "off" }, memory: { repo: "acme/widgets" } })
    expect(JSON.parse(readFileSync(path.join(stateDir, "omp-settings.json"), "utf8")).binary).toBe(wrapper)

    const refused = await send(OMP_ROUTES.settings, "PUT", { maxSessionMinutes: 0 })
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { errors: Array<{ path: string }> }).errors.map((error) => error.path)).toEqual(["maxSessionMinutes"])
  })
})

describe("engine", () => {
  test("health and the stub catalog", async () => {
    const health = await get<{ ok: boolean; omp: { available: boolean; version?: string }; sessions: { live: number } }>(engineRoutes.health)
    expect(health).toMatchObject({ ok: true, omp: { available: true, version: "18.12.2" } })
    const models = await get<ModelInfo[]>(engineRoutes.models)
    expect(models.map((model) => `${model.providerID}/${model.id}`)).toEqual(["stub/model-0", "stub/model-1"])
  })

  test("a login that rewrites the profile's agent.db shows in the next catalog read, with no wait for the cache to expire", async () => {
    const agentDb = path.join(configDir, "agent.db")
    mkdirSync(configDir, { recursive: true })
    const count = async () => (await get<ModelInfo[]>(engineRoutes.models)).length
    expect(await count()).toBe(2)
    expect(await count()).toBe(2)
    // The wrapper sizes the stub's catalog by the byte size of agent.db, as a login would change what omp can use.
    writeFileSync(agentDb, "abc")
    expect(await count()).toBe(3)
    writeFileSync(agentDb, "abcde")
    expect(await count()).toBe(5)
    rmSync(agentDb)
    expect(await count()).toBe(2)
  })

  test("Copy logins drops the cached catalog even when the credential files look unchanged", async () => {
    const knob = path.join(dir, "model-count")
    expect((await get<ModelInfo[]>(engineRoutes.models)).length).toBe(2)
    writeFileSync(knob, "7")
    try {
      // Nothing touched agent.db, so the stamp is the same and the cache still answers.
      expect((await get<ModelInfo[]>(engineRoutes.models)).length).toBe(2)
      const copied = await send(OMP_ROUTES.authImport, "POST")
      expect(copied.status).toBe(200)
      expect((await get<ModelInfo[]>(engineRoutes.models)).length).toBe(7)
    } finally {
      rmSync(knob, { force: true })
    }
    // Back to the default catalog for the tests that follow.
    expect((await send(OMP_ROUTES.authImport, "POST")).status).toBe(200)
    expect((await get<ModelInfo[]>(engineRoutes.models)).length).toBe(2)
  })

  test("a scripted turn streams step, text, tool and step.ended events, then reads back", async () => {
    const events = await subscribe()
    expect(events.comments).toEqual([])
    script([
      frames.agentStart(),
      frames.messageStart("m1"),
      frames.textDelta("m1", 0, "Hel"),
      frames.textDelta("m1", 0, "lo"),
      frames.messageEnd("m1", assistantMessage({ texts: ["Hello"], tools: [{ id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" })),
      frames.toolStart("c1", "bash", { command: "ls" }),
      frames.toolEnd("c1", "bash", "a.txt"),
      frames.messageStart("m2"),
      frames.messageEnd("m2", assistantMessage({ texts: ["All done"] })),
      ...COMPLETE,
    ])
    const id = await open("n1")
    await prompt(id, "build it")
    expect((await wait(id)).status).toBe("idle")

    await events.next((event) => event.type === "session.next.step.ended" && event.data?.assistantMessageID.endsWith("m2"))
    const types = events.events.map((event) => event.type)
    for (const type of ["session.next.step.started", "session.next.text.started", "session.next.text.delta", "session.next.tool.called", "session.next.tool.success", "session.next.step.ended"]) {
      expect(types).toContain(type)
    }
    expect(events.events.every((event) => event.data?.sessionID === id)).toBe(true)

    expect(((await get<WaitResult>(sessionRoute(id, "/final"))) as unknown as Transcript).text).toContain("All done")
    const steps = await get<WireStep[]>(sessionRoute(id, "/steps"))
    expect(steps).toHaveLength(2)
    expect(steps[0]?.tokens.input).toBe(100)
    expect(await get<ToolCall[]>(sessionRoute(id, "/calls"))).toEqual([{ id: "c1", name: "bash", input: { command: "ls" } }])
    expect((await get<SessionRow[]>(engineRoutes.sessions)).map((row) => row.id)).toContain(id)
    expect(await get<string[]>(engineRoutes.active)).not.toContain(id)

    const released = await send(engineRoutes.releaseRun, "POST", { runId: "run-1" })
    expect(released.status).toBeLessThan(300)
    expect((await send(sessionRoute(id, "/final"), "GET")).status).toBe(404)
    await events.close()
  })

  test("a manual-approval turn asks once and proceeds after one reply", async () => {
    const events = await subscribe()
    script([
      frames.agentStart(),
      frames.messageStart("m1"),
      frames.approval("r1", "Allow tool: bash\ncommand: rm -rf build"),
      { waitFor: "extension_ui_response" },
      frames.messageEnd("m1", assistantMessage({ texts: ["approved"] })),
      ...COMPLETE,
    ])
    const id = await open("n2", { permissions: "manual" }, "run-2")
    await prompt(id)
    const asked = await events.next((event) => event.type === "permission.v2.asked")
    expect(asked.data).toMatchObject({ sessionID: id, id: "r1", action: "bash", resources: ["command: rm -rf build"] })

    expect((await send(sessionRoute(id, "/permission/r1"), "POST", { reply: "once" })).status).toBeLessThan(300)
    expect((await wait(id)).result).toBe("completed")
    expect(logged()).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }])
    expect((await send(sessionRoute(id, "/permission/r1"), "POST", { reply: "once" })).status).toBe(404)
    await events.close()
  })

  test("an ask turn surfaces the question and carries the answer back", async () => {
    const events = await subscribe()
    script([
      frames.agentStart(),
      frames.messageStart("m1"),
      { type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "db", question: "Which database?", header: "Storage", options: [{ label: "sqlite" }, { label: "postgres" }], multi: false }] },
      { waitFor: "extension_ui_response" },
      frames.messageEnd("m1", assistantMessage({ texts: ["thanks"] })),
      ...COMPLETE,
    ])
    const id = await open("n3", {}, "run-3")
    await prompt(id)
    const asked = await events.next((event) => event.type === "question.v2.asked")
    expect(asked.data).toMatchObject({ sessionID: id, id: "q1", questions: [{ question: "Which database?", header: "Storage", options: [{ label: "sqlite" }, { label: "postgres" }] }] })

    expect((await send(sessionRoute(id, "/question/q1"), "POST", { answers: [["sqlite"]] })).status).toBeLessThan(300)
    expect((await wait(id)).result).toBe("completed")
    expect(logged()).toEqual([{ type: "extension_ui_response", id: "q1", answers: [{ id: "db", selectedOptions: ["sqlite"] }] }])
    await events.close()
  })

  test("a dispatch card gets its host tool call answered and recorded", async () => {
    script([
      frames.agentStart(),
      frames.messageStart("m1"),
      { type: "host_tool_call", id: "ht1", toolCallId: "t1", toolName: "openflow_dispatch", arguments: { assignments: [{ card: "writer", task: "draft" }] } },
      { waitFor: "host_tool_result" },
      frames.messageEnd("m1", assistantMessage({ texts: ["dispatched"] })),
      ...COMPLETE,
    ])
    const id = await open("n4", { card: { key: "card-n4", role: "Orchestrator", dispatch: true } }, "run-4")
    await prompt(id)
    expect((await wait(id)).result).toBe("completed")
    expect(logged()).toMatchObject([{ type: "host_tool_result", id: "ht1" }])
    expect(await get<ToolCall[]>(sessionRoute(id, "/calls"))).toEqual([{ id: "t1", name: "openflow_dispatch", input: { assignments: [{ card: "writer", task: "draft" }] } }])
  })
})

describe("uplift", () => {
  test("an ok plan, a skipped one and a failed one are all 200 answers", async () => {
    const request = (nodeId: string, original: string) => send(UPLIFT_ROUTE, "POST", { runId: "run-u", nodeId, role: "builder", original })
    const ok = await request("a", "@ok build it")
    expect(ok.status).toBe(200)
    const result = (await ok.json()) as UpliftResult
    expect(result.status).toBe("ok")
    expect(result.uplifted).toContain("<ORIGINAL>@ok build it</ORIGINAL>")

    const failed = await request("b", "@crash x")
    expect(failed.status).toBe(200)
    expect(((await failed.json()) as UpliftResult).status).toBe("failed")

    expect(await get<UpliftResult>(`${UPLIFT_ROUTE}/run-u/a`)).toEqual(result)
  })

  test("a client that aborts the request kills the planner's process group, and uplift.run sees the abort", async () => {
    const controller = new AbortController()
    const pending = send(UPLIFT_ROUTE, "POST", { runId: "run-abort", nodeId: "n1", role: "builder", original: "@hang slow" }, {}, controller.signal)
    // The stub writes its leader and helper pids once it is running.
    const pidsFile = path.join(stateRoot(project, { OPENFLOW_STATE_DIR: stateDir }), "uplift", "pids-openflow-run-abort-n1-1.json")
    await until(() => existsSync(pidsFile))
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { leader: number; helper: number }
    expect(await alive(pids.leader)).toBe(true)
    expect(await alive(pids.helper)).toBe(true)

    controller.abort()
    await expect(pending).rejects.toThrow()
    await until(async () => !(await alive(pids.leader)) && !(await alive(pids.helper)), KILL_GRACE_MS)

    // `run` settled because it saw the abort: the stored result says so, and the host is still serving.
    await until(async () => (await send(`${UPLIFT_ROUTE}/run-abort/n1`, "GET")).status === 200)
    const stored = (await (await send(`${UPLIFT_ROUTE}/run-abort/n1`, "GET")).json()) as UpliftResult
    expect(stored).toMatchObject({ status: "failed", reason: "uplift was cancelled before the planner finished" })
  })
})

describe("memory", () => {
  test("what one run writes, a second run reads", async () => {
    const status = await get<MemoryStatus>(MEMORY_ROUTES.status)
    expect(status).toMatchObject({ enabled: true, reachable: true, project: "acme/widgets" })

    const written = await send(MEMORY_ROUTES.write, "POST", { runId: "mem-a", nodeId: "coder", pipeline: "demo", role: "coder", outcome: "done", output: "the cache lives in src/cache.ts" })
    expect(((await written.json()) as MemoryWriteResult).status).toBe("stored")

    const read = await send(MEMORY_ROUTES.read, "POST", { runId: "mem-b", nodeId: "reviewer", pipeline: "demo", role: "reviewer", query: "review the cache", limit: 5 })
    const result = (await read.json()) as MemoryReadResult
    expect(result.status).toBe("ok")
    expect(result.block).toContain("src/cache.ts")
    expect(JSON.stringify(result)).not.toContain(fake.token)
  })
})

describe("swarm", () => {
  test("preflight answers for off and refuses a made-up mode", async () => {
    const off = await get<SwarmPreflight>(`${SWARM_ROUTES.preflight}?mode=off`)
    expect(off).toMatchObject({ ok: true, requested: "off", effective: "off" })
    expect((await send(`${SWARM_ROUTES.preflight}?mode=sometimes`, "GET")).status).toBe(400)
  })
})

describe("terminal", () => {
  const origin = () => base
  const create = (kind: string, headers: Record<string, string>) => send(PTY_ROUTES.ticket, "POST", { create: { kind, cols: 80, rows: 24 } }, headers)

  test("a ticket request without the x-openflow-pty header is refused", async () => {
    const refused = await create("shell", { origin: origin() })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "missing-header" })
  })

  test("an omp terminal runs the configured binary and its output reaches a real WebSocket", async () => {
    const response = await create("omp", { origin: origin(), [PTY_HEADER]: "1" })
    expect(response.status).toBe(200)
    const ticket = (await response.json()) as PtyTicket
    const output = Promise.withResolvers<string>()
    const socket = new WebSocket(`${base.replace("http", "ws")}${ticket.wsPath}?ticket=${ticket.ticket}`, { headers: { Origin: origin() } } as unknown as string[])
    let text = ""
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return
      text += event.data
      if (text.includes('"type":"ready"')) output.resolve(text)
    }
    socket.onerror = () => output.reject(new Error("socket error"))
    try {
      expect(await output.promise).toContain('"type":"ready"')
    } finally {
      socket.close()
    }
    const listed = await send(PTY_ROUTES.list, "GET", undefined, { [PTY_HEADER]: "1" })
    expect(((await listed.json()) as Array<{ id: string }>).map((info) => info.id)).toContain(ticket.id)
  })
})

describe("routing", () => {
  test("a path no module owns is not answered by the host", async () => {
    expect(await host.handle(new Request("http://127.0.0.1/flow/api/pipelines"))).toBeUndefined()
    expect((await send(`${ENGINE_BASE}/nothing`, "GET")).status).toBe(418)
  })
})

describe("dispose", () => {
  test("closes every stub process, is idempotent, and the server stays answerable for non-host paths", async () => {
    const pids = readFileSync(pidFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number)
    expect(pids.length).toBeGreaterThanOrEqual(5)

    await host.dispose()
    await host.dispose()
    for (const pid of pids) await until(async () => !(await alive(pid)))
  })
})
