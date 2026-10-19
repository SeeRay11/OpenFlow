import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { BusEvent, WaitResult } from "../../shared/engine"
import { EMPTY_SWARM_COUNTS, type SwarmHost, type SwarmLaunch, type SwarmMode, type SwarmStatus, type SwarmTracker } from "../../shared/swarm"
import { HttpError } from "../host/respond"
import { DISPATCH_TOOL, FINISH_TOOL } from "../../src/graph/dispatch"
import { buildPrompt, createSessionHost, type EngineHostDeps, safeSegment, SESSION_SUBDIR, type SessionHost } from "./session"
import { assistantMessage, createHarness, frames, rpcError, type FakeProcess, type Harness } from "./testing/fake-process"

// The harness' omp is a `#!/bin/sh` script the host executes for its version probe; Windows cannot run that.
const hosted = describe.skipIf(process.platform === "win32")

let h: Harness
let events: BusEvent[]
let host: SessionHost

async function boot(options: Parameters<typeof createHarness>[0] = {}, deps: Partial<EngineHostDeps> = {}) {
  await host?.close()
  await h?.cleanup()
  h = await createHarness(options)
  events = []
  h.fake.setup((proc) => proc.on("open_session", { cancelled: false, resumed: true, sessionId: "omp-session" }))
  host = createSessionHost({ ...h.deps, ...deps }, { emit: (event) => events.push(event), tickMs: 3_600_000 })
}

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await host.close()
  await h.cleanup()
})

const BODY = { runId: "run1", nodeId: "n1", card: { key: "card-1", role: "Builder" }, model: "anthropic/claude-test" }

async function open(body: Record<string, unknown> = BODY) {
  const { id } = await host.create(body)
  return { id, proc: h.fake.procs.at(-1) as FakeProcess }
}

/** Completes the latest prompt the way omp does: `prompt_result`, then `session_settled`. */
function finish(proc: FakeProcess, status: "completed" | "aborted" | "error" = "completed", extra: Record<string, unknown> = {}) {
  proc.emit(frames.promptResult(String(proc.of("prompt").at(-1)?.id), status, extra))
  proc.emit(frames.settled())
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(HttpError)
  return error as HttpError
}

function types(list: BusEvent[]) {
  return list.map((event) => event.type)
}

hosted("create", () => {
  test("starts omp, then configures it in a fixed order", async () => {
    const { id, proc } = await open()
    expect(typeof id).toBe("string")
    expect(h.fake.procs).toHaveLength(1)
    expect(proc.commands).toEqual([
      { type: "set_ask_dialog", enabled: true },
      { type: "set_event_filter", events: null, messageUpdates: "delta" },
    ])
    expect(host.live()).toBe(1)
  })

  test("launches omp from the resolved binary, with a state directory of its own, and spawns what the builder returned", async () => {
    await open()
    const input = h.launches[0]
    expect(input?.binary).toBe(await fs.realpath(path.join(h.dir, "omp")))
    expect(input?.stateDir).toBe(path.join(h.stateRoot, "run1", "n1"))
    expect(h.fake.specs[0]?.argv[0]).toBe(input?.binary)
  })

  test("the card runs in the project unless the request names another directory", async () => {
    const elsewhere = path.join(h.dir, "elsewhere")
    await fs.mkdir(elsewhere)
    await open()
    await open({ ...BODY, nodeId: "n2", directory: elsewhere })
    expect(h.launches.map((launch) => launch.session.directory)).toEqual([h.project, elsewhere])
  })

  test("a dispatch card gets the two host tools; others do not", async () => {
    const { proc } = await open({ ...BODY, card: { ...BODY.card, dispatch: true } })
    const command = proc.of("set_host_tools")[0]
    expect((command?.tools as Array<{ name: string; loadMode: string }>).map((tool) => [tool.name, tool.loadMode])).toEqual([
      [DISPATCH_TOOL, "essential"],
      [FINISH_TOOL, "essential"],
    ])
    const plain = await open({ ...BODY, nodeId: "n2" })
    expect(plain.proc.of("set_host_tools")).toEqual([])
  })

  test("state directory segments are sanitised: never .., never a separator", async () => {
    await open({ ...BODY, runId: "../../etc", nodeId: "a/b" })
    const dir = h.launches[0]?.stateDir as string
    expect(path.relative(h.stateRoot, dir).startsWith("..")).toBe(false)
    expect(dir.split(path.sep)).not.toContain("..")
    expect(safeSegment("plain-id_1")).toBe("plain-id_1")
    expect(safeSegment("a/b")).not.toBe(safeSegment("a_b"))
    expect(safeSegment("..")).not.toBe("..")
  })

  test("writes resume metadata next to the session directory", async () => {
    const { id } = await open()
    const meta = JSON.parse(await fs.readFile(path.join(h.stateRoot, "run1", "n1", ".openflow-session.json"), "utf8"))
    expect(meta).toMatchObject({ id, runId: "run1", nodeId: "n1", key: "card-1", model: "anthropic/claude-test" })
  })

  test("a second create for the same node replaces the first session, closing its process", async () => {
    const first = await open()
    const second = await open()
    expect(first.proc.closeCalls).toBe(1)
    expect(second.proc.closeCalls).toBe(0)
    expect(host.live()).toBe(1)
    expect(await host.wait(first.id, {})).toEqual({ status: "missing" })
  })

  test("omp that is not usable is a 503 omp-unavailable with the fix in the text, and nothing is spawned", async () => {
    await boot({ binary: false })
    const error = await failure(host.create(BODY))
    expect(error.status).toBe(503)
    expect(error.code).toBe("omp-unavailable")
    expect(error.message).toContain("omp was not found")
    expect(h.fake.procs).toHaveLength(0)
  })

  test("a process that exits before ready is a 502 with its last stderr line, and is closed", async () => {
    h.fake.next({ readyFails: "warming up\nerror: profile 'openflow' has no credentials" })
    const error = await failure(host.create(BODY))
    expect(error.status).toBe(502)
    expect(error.message).toBe("omp failed to start: error: profile 'openflow' has no credentials")
    expect(h.fake.procs[0]?.closeCalls).toBe(1)
    expect(host.live()).toBe(0)
  })

  test("a failing startup command is a 502 and closes the process", async () => {
    h.fake.setup((proc) =>
      proc.on("set_event_filter", () => {
        throw rpcError("set_event_filter", "messageUpdates must be full or delta")
      }),
    )
    const error = await failure(host.create(BODY))
    expect(error.status).toBe(502)
    expect(error.message).toContain("messageUpdates must be full or delta")
    expect(h.fake.procs[0]?.closeCalls).toBe(1)
    expect(host.live()).toBe(0)
  })

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["runId", { ...BODY, runId: 3 }, "runId"],
    ["nodeId", { ...BODY, nodeId: "" }, "nodeId"],
    ["card", { ...BODY, card: undefined }, "card.key"],
    ["card key", { ...BODY, card: { role: "x" } }, "card.key"],
    ["model shape", { ...BODY, model: "claude" }, "provider/id"],
    ["model that looks like a flag", { ...BODY, model: "--cwd=/x/y" }, "provider/id"],
    ["relative directory", { ...BODY, directory: "relative/dir" }, "absolute"],
    ["missing directory", { ...BODY, directory: "/definitely/not/here" }, "does not exist"],
    ["permissions", { ...BODY, permissions: "yolo" }, "permissions"],
    ["swarm", { ...BODY, swarm: "maybe" }, "swarm"],
    ["tools", { ...BODY, card: { ...BODY.card, tools: { bash: "yes" } } }, "card.tools"],
  ]
  for (const [name, body, text] of bad) {
    test(`rejects a bad ${name} with a 400 that names it`, async () => {
      const error = await failure(host.create(body))
      expect(error.status).toBe(400)
      expect(error.message).toContain(text)
      expect(h.fake.procs).toHaveLength(0)
    })
  }

  test("a body that is not an object is a 400", async () => {
    expect((await failure(host.create("nope"))).status).toBe(400)
    expect((await failure(host.create(null))).status).toBe(400)
  })
})

hosted("swarm", () => {
  function swarmHost(options: { effective?: SwarmMode; problems?: boolean } = {}) {
    const status = (updatedAt: number): SwarmStatus => ({ mode: "auto", active: true, counts: { ...EMPTY_SWARM_COUNTS, running: 1 }, agents: [], updatedAt })
    const record = {
      launches: [] as Array<{ mode: SwarmMode; stateDir: string; runId: string; nodeId: string }>,
      trackers: [] as Array<{ mode: SwarmMode; stateDir: string }>,
      observed: [] as Array<{ type: string }>,
      polls: 0,
      disposed: 0,
      silent: false,
    }
    const tracker: SwarmTracker = {
      observe(frame) {
        record.observed.push(frame)
        return frame.type === "subagent_lifecycle" ? status(1) : undefined
      },
      snapshot: () => status(0),
      async poll() {
        record.polls++
        return record.polls === 1 ? status(2) : undefined
      },
      dispose() {
        record.disposed++
        return record.disposed === 1 && !record.silent ? { ...status(9), active: false } : undefined
      },
    }
    const host: SwarmHost = {
      async launch(input) {
        record.launches.push({ mode: input.mode, stateDir: input.stateDir, runId: input.runId, nodeId: input.nodeId })
        const effective = options.effective ?? input.mode
        const launch: SwarmLaunch = {
          effective,
          args: effective === "off" ? [] : ["-e", "/swarm/omp"],
          env: {},
          overlay: {},
          systemPrompt: "",
          stateDir: path.join(input.stateDir, "swarm"),
          preflight: {
            ok: !options.problems,
            effective,
            requested: input.mode,
            problems: options.problems ? [{ code: "no-signing-key", message: "No signing key is set.", fix: "Export SWARM_ED25519_KEY." }] : [],
          },
        }
        return launch
      },
      tracker(input) {
        record.trackers.push(input)
        return tracker
      },
    }
    return { host, record }
  }

  test("the mode is the request's, else the settings default; subscription is on unless off", async () => {
    const swarm = swarmHost()
    await boot({ swarm: swarm.host })
    h.settings.swarm.mode = "auto"
    const first = await open({ ...BODY, swarm: "always" })
    expect(swarm.record.launches[0]).toMatchObject({ mode: "always", runId: "run1", nodeId: "n1" })
    expect(h.launches[0]?.swarm?.args).toEqual(["-e", "/swarm/omp"])
    expect(first.proc.of("set_subagent_subscription")).toEqual([{ type: "set_subagent_subscription", level: "progress" }])
    const second = await open({ ...BODY, nodeId: "n2" })
    expect(swarm.record.launches[1]?.mode).toBe("auto")
    expect(second.proc.of("set_subagent_subscription")).toHaveLength(1)
  })

  test("off sends no subscription; a degraded swarm says why", async () => {
    const swarm = swarmHost({ effective: "off", problems: true })
    await boot({ swarm: swarm.host })
    const { proc } = await open({ ...BODY, swarm: "always" })
    expect(proc.of("set_subagent_subscription")).toEqual([])
    const notice = events.find((event) => event.type === "flow.notice")
    expect(notice?.data?.message).toContain("swarm is off for this card")
    expect(notice?.data?.message).toContain("Export SWARM_ED25519_KEY.")
  })

  test("every frame is fed to the tracker and a returned status becomes flow.swarm.status", async () => {
    const swarm = swarmHost()
    await boot({ swarm: swarm.host })
    const { id, proc } = await open({ ...BODY, swarm: "auto" })
    expect(swarm.record.trackers).toEqual([{ mode: "auto", stateDir: path.join(h.stateRoot, "run1", "n1") }])
    proc.emit({ type: "agent_start" })
    proc.emit({ type: "subagent_lifecycle", payload: { id: "W", agent: "a05-backend", status: "started", index: 0 } })
    proc.emit(frames.approval("r1", "Allow tool: bash"))
    expect(swarm.record.observed.map((frame) => frame.type)).toEqual(["agent_start", "subagent_lifecycle", "extension_ui_request"])
    const statuses = events.filter((event) => event.type === "flow.swarm.status")
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.data).toMatchObject({ sessionID: id, status: { updatedAt: 1 } })
  })

  test("the tracker is polled on each tick and disposed with the session", async () => {
    const swarm = swarmHost()
    await boot({ swarm: swarm.host })
    const { id } = await open({ ...BODY, swarm: "auto" })
    await host.maintain()
    await host.maintain()
    expect(swarm.record.polls).toBe(2)
    expect(events.filter((event) => event.type === "flow.swarm.status").map((event) => event.data?.status.updatedAt)).toEqual([2])
    await host.dispose(id)
    expect(swarm.record.disposed).toBe(1)
  })

  test("disposing the session ends its swarm once, before anything else is said about the end", async () => {
    const swarm = swarmHost()
    await boot({ swarm: swarm.host })
    const { id } = await open({ ...BODY, swarm: "auto" })
    await host.dispose(id)
    await host.dispose(id).catch(() => undefined)
    const final = events.filter((event) => event.type === "flow.swarm.status")
    expect(final).toHaveLength(1)
    expect(final[0]?.data).toMatchObject({ sessionID: id, status: { active: false, updatedAt: 9 } })
  })

  test("a process that exits ends its swarm before flow.session.lost, once", async () => {
    const swarm = swarmHost()
    await boot({ swarm: swarm.host })
    const { id, proc } = await open({ ...BODY, swarm: "auto" })
    proc.exit(1)
    await proc.exited
    await host.dispose(id).catch(() => undefined)
    const names = types(events).filter((type) => type === "flow.swarm.status" || type === "flow.session.lost")
    expect(names).toEqual(["flow.swarm.status", "flow.session.lost"])
    expect(events.find((event) => event.type === "flow.swarm.status")?.data).toMatchObject({ sessionID: id, status: { active: false, updatedAt: 9 } })
  })

  test("a swarm that never showed anything ends silently", async () => {
    const swarm = swarmHost()
    swarm.record.silent = true
    await boot({ swarm: swarm.host })
    const { id } = await open({ ...BODY, swarm: "auto" })
    await host.dispose(id)
    expect(events.filter((event) => event.type === "flow.swarm.status")).toEqual([])
  })
})

describe("buildPrompt", () => {
  test("images become ImageContent; text files are inlined under a heading; the rest is noted", () => {
    const png = Buffer.from([137, 80, 78, 71]).toString("base64")
    const body = buildPrompt({
      text: "look at these",
      files: [
        { name: "shot.png", url: `data:image/png;base64,${png}`, mime: "image/png" },
        { name: "notes.md", url: `data:text/markdown;base64,${Buffer.from("# hi\n```js\nx\n```").toString("base64")}`, mime: "text/markdown" },
        { name: "plain.txt", url: `data:text/plain,hello%20world` },
        { name: "big.txt", url: `data:text/plain;base64,${Buffer.alloc(200 * 1024 + 1, 97).toString("base64")}`, mime: "text/plain" },
        { name: "blob.bin", url: `data:application/octet-stream;base64,${Buffer.from([0, 1, 2]).toString("base64")}`, mime: "application/octet-stream" },
        { name: "latin1.txt", url: `data:text/plain;base64,${Buffer.from([0xff, 0xfe, 0x41]).toString("base64")}`, mime: "text/plain" },
        { name: "remote.txt", url: "https://example.com/a.txt" },
      ],
    })
    expect(body.images).toEqual([{ type: "image", data: png, mimeType: "image/png" }])
    expect(body.message.startsWith("look at these\n\n## Attached files\n\n")).toBe(true)
    expect(body.message).toContain("### notes.md\n````\n# hi\n```js\nx\n```\n````")
    expect(body.message).toContain("### plain.txt\n```\nhello world\n```")
    expect(body.message).toContain("- big.txt (text/plain, 204801 bytes): not inlined (larger than 200 KiB)")
    expect(body.message).toContain("- blob.bin (application/octet-stream, 3 bytes): not inlined (binary)")
    expect(body.message).toContain("- latin1.txt (text/plain, 3 bytes): not inlined (binary)")
    expect(body.message).toContain("- remote.txt: not inlined (not a data: URL)")
  })

  test("images only leave the text untouched; SVG is text, not an image", () => {
    const only = buildPrompt({ text: "see", files: [{ name: "a.png", url: "data:image/png;base64,AAAA", mime: "image/png" }] })
    expect(only.message).toBe("see")
    const svg = buildPrompt({ text: "see", files: [{ name: "a.svg", url: `data:image/svg+xml,${encodeURIComponent("<svg/>")}`, mime: "image/svg+xml" }] })
    expect(svg.images).toEqual([])
    expect(svg.message).toContain("<svg/>")
  })
})

hosted("prompts", () => {
  test("plain text is a prompt command with its own id, answered once admitted", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "build it" })
    const command = proc.of("prompt")[0]
    expect(command).toMatchObject({ type: "prompt", message: "build it" })
    expect(typeof command?.id).toBe("string")
    expect(command?.images).toBeUndefined()
    expect(command?.streamingBehavior).toBeUndefined()
  })

  test("a prompt sent while a turn is active is queued as a follow-up", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "one" })
    await host.prompt(id, { text: "two" })
    expect(proc.of("prompt")[1]?.streamingBehavior).toBe("followUp")
    finish(proc)
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })
    await host.prompt(id, { text: "three" })
    expect(proc.of("prompt")[2]?.streamingBehavior).toBeUndefined()
  })

  test("a refused prompt is a 502 with omp's reason and leaves the session as it was", async () => {
    const { id, proc } = await open()
    proc.on("prompt", () => {
      throw rpcError("prompt", "Model not found: anthropic/nope")
    })
    const error = await failure(host.prompt(id, { text: "x" }))
    expect(error.status).toBe(502)
    expect(error.message).toBe("Model not found: anthropic/nope")
    expect(host.active()).toEqual([])
  })

  test("an unknown session is a 404 with the text the engine classifies as a lost session", async () => {
    const error = await failure(host.prompt("s_missing", { text: "x" }))
    expect(error.status).toBe(404)
    expect(error.message).toBe("session not found: s_missing")
  })

  test("the command carries the images", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "see", files: [{ name: "a.png", url: "data:image/png;base64,AAAA", mime: "image/png" }] })
    expect(proc.of("prompt")[0]?.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }])
  })

  test("a bad body is a 400", async () => {
    const { id } = await open()
    expect((await failure(host.prompt(id, { text: 3 as unknown as string }))).status).toBe(400)
    expect((await failure(host.prompt(id, { text: "x", files: [{ name: 1 }] as never }))).status).toBe(400)
  })
})

hosted("wait", () => {
  test("resolves only once the prompt has a result and the session settled", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    let done: WaitResult | undefined
    const waiting = host.wait(id, {}).then((result) => (done = result))
    proc.emit(frames.agentStart())
    proc.emit(frames.promptResult(String(proc.of("prompt")[0]?.id), "completed"))
    await Promise.resolve()
    expect(done).toBeUndefined()
    proc.emit(frames.settled())
    await waiting
    expect(done).toEqual({ status: "idle", result: "completed" })
  })

  test("sessionSettled on the result is enough; and a later wait resolves at once", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    proc.emit(frames.promptResult(String(proc.of("prompt")[0]?.id), "completed", { sessionSettled: true }))
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })
  })

  test("many concurrent waits all resolve", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    const waits = [host.wait(id, {}), host.wait(id, {}), host.wait(id, {})]
    finish(proc)
    expect(await Promise.all(waits)).toEqual([
      { status: "idle", result: "completed" },
      { status: "idle", result: "completed" },
      { status: "idle", result: "completed" },
    ])
  })

  test("an aborted prompt is idle/aborted, not success", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    const waiting = host.wait(id, {})
    finish(proc, "aborted")
    expect(await waiting).toEqual({ status: "idle", result: "aborted" })
  })

  test("a provider error reads Provider request failed with HTTP <status>", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    const waiting = host.wait(id, {})
    finish(proc, "error", { error: { message: "Too Many Requests", httpStatus: 429, retryable: true } })
    expect(await waiting).toEqual({ status: "idle", result: "error", error: "Provider request failed with HTTP 429: Too Many Requests" })
  })

  test("the status falls back to the assistant message's errorStatus, and is omitted when unknown", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    proc.emit(frames.messageEnd("m1", assistantMessage({ stopReason: "error", errorMessage: "overloaded", errorStatus: 529 })))
    const waiting = host.wait(id, {})
    finish(proc, "error", { error: { message: "overloaded", retryable: true } })
    expect((await waiting).error).toBe("Provider request failed with HTTP 529: overloaded")

    const other = await open({ ...BODY, nodeId: "n2" })
    await host.prompt(other.id, { text: "go" })
    const second = host.wait(other.id, {})
    finish(other.proc, "error", { error: { message: "socket closed", retryable: false } })
    expect((await second).error).toBe("Provider request failed: socket closed")
  })

  test("a prompt that never reached the agent completes at once", async () => {
    const { id, proc } = await open()
    proc.on("prompt", { agentInvoked: false })
    await host.prompt(id, { text: "/help" })
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })
    expect(host.active()).toEqual([])
  })

  test("a result for a superseded prompt is not the answer", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "one" })
    await host.prompt(id, { text: "two" })
    const [first, second] = proc.of("prompt").map((command) => String(command.id))
    const waiting = host.wait(id, {})
    proc.emit(frames.promptResult(first as string, "completed", { sessionSettled: true }))
    proc.emit(frames.settled())
    let done = false
    void waiting.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    proc.emit(frames.promptResult(second as string, "completed"))
    proc.emit(frames.settled())
    expect(await waiting).toEqual({ status: "idle", result: "completed" })
  })

  test("a new agent run after settling reopens the wait", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    finish(proc)
    expect(host.active()).toEqual([])
    proc.emit(frames.agentStart())
    let done = false
    const waiting = host.wait(id, {}).then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    proc.emit(frames.settled())
    await waiting
  })

  test("times out after timeoutMs", async () => {
    const { id } = await open()
    await host.prompt(id, { text: "go" })
    // A real 1 ms timer: the timeout itself is the behaviour under test.
    expect(await host.wait(id, { timeoutMs: 1 })).toEqual({ status: "timeout" })
  })

  test("an aborted request releases its wait", async () => {
    const { id } = await open()
    await host.prompt(id, { text: "go" })
    const controller = new AbortController()
    const waiting = host.wait(id, {}, controller.signal)
    controller.abort()
    expect(await waiting).toEqual({ status: "timeout" })
  })

  test("a signal that is already aborted releases the wait at once, not after the timeout", async () => {
    const { id } = await open()
    await host.prompt(id, { text: "go" })
    expect(await host.wait(id, {}, AbortSignal.abort())).toEqual({ status: "timeout" })
  })

  test("an unknown or disposed session is missing; waiters parked on a disposed one are released", async () => {
    expect(await host.wait("s_nope", {})).toEqual({ status: "missing" })
    const { id } = await open()
    await host.prompt(id, { text: "go" })
    const waiting = host.wait(id, {})
    await host.dispose(id)
    expect(await waiting).toEqual({ status: "missing" })
    expect(await host.wait(id, {})).toEqual({ status: "missing" })
  })

  test("with nothing prompted there is nothing to wait for", async () => {
    const { id } = await open()
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })
  })

  test("active lists exactly the sessions with a turn in flight", async () => {
    const a = await open()
    await open({ ...BODY, nodeId: "n2" })
    await host.prompt(a.id, { text: "go" })
    expect(host.active()).toEqual([a.id])
    finish(a.proc)
    expect(host.active()).toEqual([])
  })
})

hosted("events and reads", () => {
  test("frames are mapped onto the bus with the session id", async () => {
    const { id, proc } = await open()
    proc.emit(frames.messageStart("msg-1"))
    proc.emit(frames.textDelta("msg-1", 0, "hi"))
    proc.emit(frames.messageEnd("msg-1", assistantMessage({ texts: ["hi"] })))
    expect(types(events)).toEqual(["session.next.step.started", "session.next.text.started", "session.next.text.delta", "session.next.text.ended", "session.next.step.ended"])
    expect(events.every((event) => event.data?.sessionID === id)).toBe(true)
  })

  test("final, steps, calls and turns are read from the stream", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "do it" })
    proc.emit(frames.userMessage("u1", "do it"))
    proc.emit(frames.messageStart("msg-1"))
    proc.emit(frames.messageEnd("msg-1", assistantMessage({ texts: ["checking"], tools: [{ id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" })))
    proc.emit(frames.messageEnd("msg-2", assistantMessage({ texts: ["all done"] })))
    finish(proc)
    expect(await host.final(id)).toEqual({ text: "all done" })
    expect((await host.steps(id)).map((step) => step.messageID).length).toBe(2)
    expect(await host.calls(id, 10)).toEqual([{ id: "c1", name: "bash", input: { command: "ls" } }])
    expect(await host.turns(id, 10)).toEqual([
      { role: "user", text: "do it" },
      { role: "assistant", text: "checking" },
      { role: "assistant", text: "all done" },
    ])
  })

  test("a failed turn's final carries the error even when no assistant message did", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    finish(proc, "error", { error: { message: "unauthorized", httpStatus: 401, retryable: false } })
    expect(await host.final(id)).toEqual({ text: "", error: "Provider request failed with HTTP 401: unauthorized" })
  })

  test("reads of an unknown session are 404", async () => {
    expect((await failure(host.final("s_x"))).status).toBe(404)
    expect((await failure(host.steps("s_x"))).status).toBe(404)
    expect((await failure(host.calls("s_x", 1))).status).toBe(404)
    expect((await failure(host.turns("s_x", 1))).status).toBe(404)
  })

  test("a dispatch tool call is answered at once and is readable from calls", async () => {
    const { id, proc } = await open({ ...BODY, card: { ...BODY.card, dispatch: true } })
    proc.emit({ type: "host_tool_call", id: "ht1", toolCallId: "t1", toolName: DISPATCH_TOOL, arguments: { assignments: [{ card: "a", task: "do" }] } })
    expect(proc.sent[0]).toMatchObject({ type: "host_tool_result", id: "ht1" })
    expect(await host.calls(id, 5)).toEqual([{ id: "t1", name: DISPATCH_TOOL, input: { assignments: [{ card: "a", task: "do" }] } }])
  })
})

hosted("approvals and questions", () => {
  test("an approval is an event and is answered through the session", async () => {
    const { id, proc } = await open()
    proc.emit(frames.approval("r1", "Allow tool: edit\npath: a.ts"))
    expect(events).toEqual([{ type: "permission.v2.asked", data: { id: "r1", sessionID: id, action: "edit", resources: ["path: a.ts"] } }])
    host.replyPermission(id, "r1", "always")
    expect(proc.sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve bash for this session" }])
    expect(() => host.replyPermission(id, "r1", "once")).toThrow(HttpError)
  })

  test("a question is answered or rejected through the session", async () => {
    const { id, proc } = await open()
    proc.emit({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "a", question: "Which?", options: [{ label: "x" }] }] })
    host.replyQuestion(id, "q1", [["x"]])
    expect(proc.sent[0]).toEqual({ type: "extension_ui_response", id: "q1", answers: [{ id: "a", selectedOptions: ["x"] }] })
    proc.emit({ type: "extension_ui_request", id: "q2", method: "ask", questions: [{ id: "a", question: "Which?", options: [] }] })
    host.rejectQuestion(id, "q2")
    expect(proc.sent[1]).toEqual({ type: "extension_ui_response", id: "q2", cancelled: true })
  })

  test("replies to an unknown session are 404", () => {
    expect(() => host.replyPermission("s_x", "r", "once")).toThrow(HttpError)
  })

  test("pending dialogs are cancelled when the session is interrupted and when it is disposed", async () => {
    const { id, proc } = await open()
    proc.emit(frames.approval("r1", "Allow tool: bash"))
    await host.interrupt(id)
    expect(proc.sent).toEqual([{ type: "extension_ui_response", id: "r1", cancelled: true }])
    proc.emit(frames.approval("r2", "Allow tool: bash"))
    await host.dispose(id)
    expect(proc.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "r2", cancelled: true })
  })
})

hosted("interrupt, dispose, release", () => {
  test("interrupt sends abort and releases waiters as aborted; the real result still lands", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    const waiting = host.wait(id, {})
    await host.interrupt(id)
    expect(proc.of("abort")).toHaveLength(1)
    expect(await waiting).toEqual({ status: "idle", result: "aborted" })
    finish(proc, "aborted")
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "aborted" })
  })

  test("interrupt never fails: unknown session, dead process, refused abort", async () => {
    await host.interrupt("s_nope")
    const { id, proc } = await open()
    proc.on("abort", () => {
      throw rpcError("abort", "nothing to abort")
    })
    await host.interrupt(id)
    proc.exit(1)
    await host.interrupt(id)
  })

  test("dispose closes the process once, drops the record, and is idempotent", async () => {
    const { id, proc } = await open()
    await host.dispose(id)
    await host.dispose(id)
    expect(proc.closeCalls).toBe(1)
    expect(host.live()).toBe(0)
    expect((await failure(host.prompt(id, { text: "x" }))).status).toBe(404)
    expect(types(events)).not.toContain("flow.session.lost")
    expect((await fs.stat(path.join(h.stateRoot, "run1", "n1", SESSION_SUBDIR))).isDirectory()).toBe(true)
  })

  test("releaseRun disposes every session of that run only", async () => {
    const a = await open({ ...BODY, runId: "runA", nodeId: "1" })
    const b = await open({ ...BODY, runId: "runA", nodeId: "2" })
    const c = await open({ ...BODY, runId: "runB", nodeId: "1" })
    expect(await host.releaseRun("runA")).toBe(2)
    expect([a.proc.closeCalls, b.proc.closeCalls, c.proc.closeCalls]).toEqual([1, 1, 0])
    expect(host.live()).toBe(1)
    expect(await host.releaseRun("runA")).toBe(0)
  })

  test("close stops every process exactly once", async () => {
    const a = await open({ ...BODY, nodeId: "1" })
    const b = await open({ ...BODY, nodeId: "2" })
    await host.close()
    await host.close()
    expect([a.proc.closeCalls, b.proc.closeCalls]).toEqual([1, 1])
    expect(host.live()).toBe(0)
  })
})

hosted("lost processes", () => {
  test("an exit while live is flow.session.lost, releases waiters, and keeps reads working", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "go" })
    proc.emit(frames.messageEnd("msg-1", assistantMessage({ texts: ["partial"] })))
    const waiting = host.wait(id, {})
    proc.exit(137, "killed\nOut of memory")
    expect(await waiting).toEqual({ status: "missing" })
    const lost = events.find((event) => event.type === "flow.session.lost")
    expect(lost?.data).toEqual({ sessionID: id, reason: "omp exited (code 137): Out of memory" })
    expect(host.live()).toBe(0)
    expect((await host.steps(id)).length).toBe(1)
    expect(await host.wait(id, {})).toEqual({ status: "missing" })
    expect((await failure(host.prompt(id, { text: "again" }))).status).toBe(404)
    expect(proc.closeCalls).toBe(0)
  })

  test("a lost session can be resumed with reuse", async () => {
    const { id, proc } = await open()
    proc.exit(1)
    await proc.exited
    expect(await host.create({ ...BODY, reuse: id })).toEqual({ id })
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(1)
  })
})

hosted("reuse", () => {
  test("a live session is returned as is", async () => {
    const { id } = await open()
    expect(await host.create({ ...BODY, reuse: id })).toEqual({ id })
    expect(h.fake.procs).toHaveLength(1)
  })

  test("a disposed session is respawned into the same directory and resumed with open_session", async () => {
    const { id } = await open()
    await host.dispose(id)
    expect(await host.create({ ...BODY, reuse: id })).toEqual({ id })
    const proc = h.fake.procs[1] as FakeProcess
    expect(types(proc.commands.map((command) => ({ type: command.type })))).toEqual(["open_session", "set_ask_dialog", "set_event_filter"])
    expect(proc.of("open_session")[0]?.sessionDir).toBe(path.join(h.stateRoot, "run1", "n1", SESSION_SUBDIR))
    expect(h.launches[1]?.stateDir).toBe(h.launches[0]?.stateDir)
    expect(host.live()).toBe(1)
  })

  test("it works after a host restart: only the files on disk remain", async () => {
    const { id } = await open()
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      expect(await restarted.create({ ...BODY, reuse: id })).toEqual({ id })
      expect(h.fake.procs).toHaveLength(2)
    } finally {
      await restarted.close()
    }
  })

  test("an id that is not this node's session is a 404 and spawns nothing", async () => {
    await open()
    const error = await failure(host.create({ ...BODY, reuse: "s_000000000000" }))
    expect(error.status).toBe(404)
    expect(error.message).toBe("session not found: s_000000000000")
    expect(h.fake.procs).toHaveLength(1)
  })

  test("a session omp cannot resume is a 404 and its process is closed", async () => {
    const { id } = await open()
    await host.dispose(id)
    h.fake.setup((proc) => proc.on("open_session", { cancelled: false, resumed: false }))
    const error = await failure(host.create({ ...BODY, reuse: id }))
    expect(error.status).toBe(404)
    expect(h.fake.procs[1]?.closeCalls).toBe(1)
    expect(host.live()).toBe(0)
  })

  test("a resumed session reads its history from omp when nothing has streamed", async () => {
    const { id } = await open()
    await host.dispose(id)
    h.fake.setup((proc) => {
      proc.on("open_session", { cancelled: false, resumed: true })
      proc.on("get_messages_page", { messages: [{ role: "user", content: "earlier", timestamp: 1 }, assistantMessage({ texts: ["earlier answer"] })] })
    })
    await host.create({ ...BODY, reuse: id })
    expect(await host.final(id)).toEqual({ text: "earlier answer" })
    expect(await host.turns(id, 10)).toEqual([
      { role: "user", text: "earlier" },
      { role: "assistant", text: "earlier answer" },
    ])
  })
})

hosted("idle reaper", () => {
  beforeEach(async () => {
    await boot({ idleReapMs: 1000 })
  })

  test("closes an idle session once and keeps it resumable; the next prompt resumes it", async () => {
    const { id, proc } = await open()
    await host.maintain(Date.now() + 5000)
    await host.maintain(Date.now() + 6000)
    expect(proc.closeCalls).toBe(1)
    expect(host.live()).toBe(0)
    expect(types(events)).not.toContain("flow.session.lost")
    expect(await host.wait(id, {})).toEqual({ status: "idle", result: "completed" })

    await host.prompt(id, { text: "wake up" })
    expect(h.fake.procs).toHaveLength(2)
    expect(h.fake.procs[1]?.of("open_session")).toHaveLength(1)
    expect(h.fake.procs[1]?.of("prompt")[0]).toMatchObject({ message: "wake up" })
    expect(host.live()).toBe(1)
    expect(host.active()).toEqual([id])
  })

  test("a session that was just used is not reaped", async () => {
    const { proc } = await open()
    await host.maintain(Date.now())
    expect(proc.closeCalls).toBe(0)
  })

  test("a session with a turn in flight is not reaped; once settled it is", async () => {
    const { id, proc } = await open()
    await host.prompt(id, { text: "long task" })
    await host.maintain(Date.now() + 10_000)
    expect(proc.closeCalls).toBe(0)
    finish(proc)
    await host.maintain(Date.now() + 10_000)
    expect(proc.closeCalls).toBe(1)
  })

  test("a session waiting on a dialog is not reaped", async () => {
    const { proc } = await open()
    proc.emit(frames.approval("r1", "Allow tool: bash"))
    await host.maintain(Date.now() + 10_000)
    expect(proc.closeCalls).toBe(0)
  })

  test("a reaped session that cannot be resumed answers 404 and is forgotten", async () => {
    const { id } = await open()
    await host.maintain(Date.now() + 5000)
    h.fake.setup((proc) => proc.on("open_session", { cancelled: false, resumed: false }))
    expect((await failure(host.prompt(id, { text: "x" }))).status).toBe(404)
    expect(await host.wait(id, {})).toEqual({ status: "missing" })
  })
})

hosted("listing", () => {
  test("lists live sessions with the first prompt as title, plus persisted ones after a dispose, newest first", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    await host.prompt(a.id, { text: `${"long ".repeat(40)}end` })
    const rows = await host.list(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(a.id)
    expect(rows[0]?.agent).toBe("card-1")
    expect(rows[0]?.model).toBe("anthropic/claude-test")
    expect(rows[0]?.title.length).toBeLessThanOrEqual(80)
    expect(rows[0]?.title.startsWith("long long")).toBe(true)

    await host.dispose(a.id)
    const b = await open({ ...BODY, nodeId: "b" })
    const after = await host.list(10)
    expect(after.map((row) => row.id).sort()).toEqual([a.id, b.id].sort())
    expect(after.find((row) => row.id === a.id)?.title.startsWith("long long")).toBe(true)
    expect(after.find((row) => row.id === b.id)?.title).toBe("card-1")
    expect(await host.list(1)).toHaveLength(1)
  })
})

/** A command that parks until `release()`; `reached` settles when it arrives, so a test acts at exactly that point. */
function gate() {
  const reached = Promise.withResolvers<void>()
  const parked = Promise.withResolvers<void>()
  return {
    reached: reached.promise,
    release: () => parked.resolve(),
    hold: async () => {
      reached.resolve()
      await parked.promise
    },
  }
}

hosted("lifecycle races", () => {
  test("a session disposed while its resume is still opening leaves no process running", async () => {
    await boot({ idleReapMs: 1000 })
    const { id } = await open()
    await host.maintain(Date.now() + 5000)
    const opening = gate()
    h.fake.setup((proc) =>
      proc.on("open_session", async () => {
        await opening.hold()
        return { cancelled: false, resumed: true }
      }),
    )
    const prompting = failure(host.prompt(id, { text: "x" }))
    await opening.reached
    const disposing = host.dispose(id)
    opening.release()
    await disposing
    await prompting
    expect((h.fake.procs[1] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
    expect(host.active()).toEqual([])
  })

  test("a run released while a session is still being created stops it, and the create fails", async () => {
    const configuring = gate()
    h.fake.setup((proc) => proc.on("set_ask_dialog", () => configuring.hold()))
    const creating = failure(host.create(BODY))
    await configuring.reached
    const releasing = host.releaseRun("run1")
    configuring.release()
    expect(await releasing).toBe(1)
    expect((await creating).code).toBe("session-closed")
    expect((h.fake.procs[0] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
    expect(await host.list(10)).toEqual([])
  })

  test("closing the host while a session is still being created leaves no process running", async () => {
    const configuring = gate()
    h.fake.setup((proc) => proc.on("set_event_filter", () => configuring.hold()))
    const creating = failure(host.create(BODY))
    await configuring.reached
    const closing = host.close()
    configuring.release()
    await closing
    await creating
    expect(h.fake.procs.every((proc) => proc.exitedNow)).toBe(true)
    expect(host.live()).toBe(0)
  })

  test("two concurrent reuses of one session share a single process", async () => {
    const { id } = await open()
    await host.dispose(id)
    const opening = gate()
    h.fake.setup((proc) =>
      proc.on("open_session", async () => {
        await opening.hold()
        return { cancelled: false, resumed: true }
      }),
    )
    const first = host.create({ ...BODY, reuse: id })
    const second = host.create({ ...BODY, reuse: id })
    await opening.reached
    opening.release()
    expect(await Promise.all([first, second])).toEqual([{ id }, { id }])
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(1)
    await host.close()
    expect(h.fake.procs.every((proc) => proc.exitedNow)).toBe(true)
  })
})

hosted("startup deadline", () => {
  beforeEach(async () => {
    await boot({}, { readyTimeoutMs: 20 })
  })

  test("an omp that never becomes ready is killed and answered as a 502 omp-not-ready", async () => {
    h.fake.next({ holdReady: true })
    const error = await failure(host.create(BODY))
    expect(error.status).toBe(502)
    expect(error.code).toBe("omp-not-ready")
    expect((h.fake.procs[0] as FakeProcess).killCalls).toBeGreaterThan(0)
    expect((h.fake.procs[0] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
    expect(await host.list(10)).toEqual([])
    // The failure is not sticky: the next create starts normally.
    await host.create(BODY)
    expect(host.live()).toBe(1)
  })

  test("an omp that never answers open_session is killed the same way and the session stays resumable", async () => {
    const { id } = await open()
    await host.dispose(id)
    h.fake.setup((proc) => proc.on("open_session", () => Promise.withResolvers<never>().promise))
    const error = await failure(host.create({ ...BODY, reuse: id }))
    expect(error.code).toBe("omp-not-ready")
    expect((h.fake.procs[1] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
  })
})

hosted("concurrent session limit", () => {
  beforeEach(async () => {
    await boot({}, { maxLive: 2 })
  })

  test("a create over the limit is a 429 too-many-sessions and spawns nothing", async () => {
    await open({ ...BODY, nodeId: "a" })
    await open({ ...BODY, nodeId: "b" })
    const error = await failure(host.create({ ...BODY, nodeId: "c" }))
    expect(error.status).toBe(429)
    expect(error.code).toBe("too-many-sessions")
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(2)
  })

  test("a disposed session frees its place, and replacing a card's own session does not need a second one", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    await open({ ...BODY, nodeId: "b" })
    await open({ ...BODY, nodeId: "b" })
    expect(host.live()).toBe(2)
    await host.dispose(a.id)
    await open({ ...BODY, nodeId: "c" })
    expect(host.live()).toBe(2)
  })

  test("resuming a session counts: a reuse over the limit is refused and the session stays on disk", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    await host.dispose(a.id)
    await open({ ...BODY, nodeId: "b" })
    await open({ ...BODY, nodeId: "c" })
    expect((await failure(host.create({ ...BODY, nodeId: "a", reuse: a.id }))).code).toBe("too-many-sessions")
    expect(h.fake.procs).toHaveLength(3)
    expect((await host.list(10)).map((row) => row.id)).toContain(a.id)
  })

  test("sessions that are still starting count, so a burst cannot overshoot", async () => {
    await boot({}, { maxLive: 1 })
    const configuring = gate()
    h.fake.setup((proc) => proc.on("set_ask_dialog", () => configuring.hold()))
    const first = host.create({ ...BODY, nodeId: "a" })
    await configuring.reached
    expect((await failure(host.create({ ...BODY, nodeId: "b" }))).code).toBe("too-many-sessions")
    configuring.release()
    await first
    expect(host.live()).toBe(1)
  })
})

hosted("model ids", () => {
  test("every real model id shape is accepted", async () => {
    const models = ["anthropic/claude-haiku-4-5", "openrouter/inclusionai/ling-2.6-flash", "openrouter/~deepseek/deepseek-v4-flash-latest", "openrouter/openai/gpt-oss-20b:batch"]
    for (const [index, model] of models.entries()) {
      await host.create({ ...BODY, nodeId: `m${index}`, model })
      expect(h.launches.at(-1)?.session.model).toBe(model)
    }
  })

  test("an id that omp would read as a flag is a 400 and spawns nothing", async () => {
    for (const model of ["--cwd=/x/y", "-x/y", "/abs/path"]) expect((await failure(host.create({ ...BODY, model }))).status).toBe(400)
    expect(h.fake.procs).toHaveLength(0)
  })
})

hosted("private state", () => {
  // POSIX permission bits; Windows does not report them.
  test.skipIf(process.platform === "win32")("the card's state and session directories are closed to group and others", async () => {
    await open()
    const state = path.join(h.stateRoot, "run1", "n1")
    for (const dir of [h.stateRoot, path.join(h.stateRoot, "run1"), state, path.join(state, SESSION_SUBDIR)]) expect((await fs.stat(dir)).mode & 0o077).toBe(0)
    expect((await fs.stat(path.join(state, ".openflow-session.json"))).mode & 0o077).toBe(0)
  })
})
