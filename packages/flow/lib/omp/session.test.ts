import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { BusEvent, Turn, WaitResult } from "../../shared/engine"
import { EMPTY_SWARM_COUNTS, type SwarmHost, type SwarmLaunch, type SwarmMode, type SwarmStatus, type SwarmTracker } from "../../shared/swarm"
import { HttpError } from "../host/respond"
import { DISPATCH_TOOL, FINISH_TOOL } from "../../src/graph/dispatch"
import { buildPrompt, carriedNotice, createSessionHost, type EngineHostDeps, safeSegment, SESSION_SUBDIR, type SessionHost } from "./session"
import { pruneState } from "./prune"
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

  test("off sends no subscription; a degraded swarm says why once the first prompt is accepted", async () => {
    const swarm = swarmHost({ effective: "off", problems: true })
    await boot({ swarm: swarm.host })
    const { id, proc } = await open({ ...BODY, swarm: "always" })
    expect(proc.of("set_subagent_subscription")).toEqual([])
    expect(events.filter((event) => event.type === "flow.notice")).toEqual([])
    await host.prompt(id, { text: "go" })
    const notice = events.find((event) => event.type === "flow.notice")
    expect(notice?.data?.sessionID).toBe(id)
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

hosted("pruned state", () => {
  const LATER = () => Date.now() + 60 * 24 * 60 * 60 * 1000

  test("a run with a session in the host is held until it is disposed from memory and its directory is not pruned", async () => {
    const { id } = await open()
    expect(host.holds(safeSegment("run1"))).toBe(true)
    expect(host.holds(safeSegment("other"))).toBe(false)
    expect(await pruneState({ root: h.stateRoot, now: LATER, claim: host.claim })).toEqual({ removed: [], errors: 0 })
    expect(await host.list(10)).toHaveLength(1)
    await host.releaseRun("run1")
    expect(host.holds(safeSegment("run1"))).toBe(false)
    // The files stay for resume until the prune takes them.
    expect((await host.list(10)).map((row) => row.id)).toEqual([id])
  })

  test("a pruned session is no longer listed and resuming it is the usual 404", async () => {
    const { id } = await open()
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      expect((await restarted.list(10)).map((row) => row.id)).toEqual([id])
      expect(await pruneState({ root: h.stateRoot, now: LATER, claim: restarted.claim })).toEqual({ removed: [safeSegment("run1")], errors: 0 })
      expect(await restarted.list(10)).toEqual([])
      const error = await failure(restarted.create({ ...BODY, reuse: id }))
      expect(error.status).toBe(404)
      expect(error.message).toBe(`session not found: ${id}`)
      expect(h.fake.procs).toHaveLength(1)
    } finally {
      await restarted.close()
    }
  })

  test("listing tolerates run directories vanishing while it reads", async () => {
    await open({ ...BODY, runId: "a" })
    await open({ ...BODY, runId: "b" })
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      const [rows] = await Promise.all([restarted.list(10), fs.rm(path.join(h.stateRoot, "a"), { recursive: true, force: true })])
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(await restarted.list(10)).toHaveLength(1)
    } finally {
      await restarted.close()
    }
  })

  test("a create in flight holds its run before any session is registered", async () => {
    h.fake.next({ holdReady: true })
    const pending = host.create(BODY)
    while (h.fake.procs.length === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(host.holds(safeSegment("run1"))).toBe(true)
    ;(h.fake.procs[0] as FakeProcess).release()
    await pending
  })

  test("a create for a run being pruned waits for the removal, then starts", async () => {
    const release = host.claim(safeSegment("run1"))
    expect(release).toBeDefined()
    // A create for another run needs no wait: when it is done, the one held back has had every chance to start.
    const held = host.create(BODY)
    await host.create({ ...BODY, runId: "run2" })
    expect(h.fake.procs).toHaveLength(1)
    expect(host.holds(safeSegment("run1"))).toBe(false)
    release?.()
    expect((await held).id).toBeTruthy()
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(2)
  })

  test("a run claimed for its removal cannot be claimed again, and is free once released", () => {
    const release = host.claim(safeSegment("run1"))
    expect(host.claim(safeSegment("run1"))).toBeUndefined()
    release?.()
    expect(host.claim(safeSegment("run1"))).toBeDefined()
  })

  test("a prune never starts on a run with a create in flight", async () => {
    h.fake.next({ holdReady: true })
    const pending = host.create(BODY)
    await processes(1)
    expect(await pruneState({ root: h.stateRoot, now: LATER, claim: host.claim })).toEqual({ removed: [], errors: 0 })
    expect((await fs.stat(path.join(h.stateRoot, "run1", "n1"))).isDirectory()).toBe(true)
    ;(h.fake.procs[0] as FakeProcess).release()
    await pending
    expect(host.live()).toBe(1)
  })

  test("a create that arrives while the prune is removing its run waits, and what it starts survives the removal", async () => {
    await open()
    await host.releaseRun("run1")
    const removing = Promise.withResolvers<void>()
    const removal = Promise.withResolvers<void>()
    const real = fs.rm
    const spy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      removing.resolve()
      await removal.promise
      return real(target, options)
    })
    try {
      const pruning = pruneState({ root: h.stateRoot, now: LATER, claim: host.claim })
      await removing.promise
      const creating = host.create(BODY)
      await host.create({ ...BODY, runId: "run2" })
      // Only the first session and run2's exist: the create for the run under removal has not spawned.
      expect(h.fake.procs).toHaveLength(2)
      removal.resolve()
      expect(await pruning).toEqual({ removed: [safeSegment("run1")], errors: 0 })
      const { id } = await creating
      const meta = JSON.parse(await fs.readFile(path.join(h.stateRoot, "run1", "n1", ".openflow-session.json"), "utf8")) as { id: string }
      expect(meta.id).toBe(id)
    } finally {
      spy.mockRestore()
    }
  })
})

hosted("launch notes", () => {
  const WEBFETCH_OFF = { ...BODY, card: { ...BODY.card, tools: { webfetch: false } } }
  const notices = () => events.filter((event) => event.type === "flow.notice")

  test("a toggle omp cannot enforce is announced once, as an info notice, after the session's first prompt is accepted", async () => {
    const { id } = await open(WEBFETCH_OFF)
    // The browser only learns the id from the create response: a notice before it is dropped there.
    expect(notices()).toEqual([])
    await host.prompt(id, { text: "go" })
    await host.prompt(id, { text: "and again" })
    expect(notices()).toHaveLength(1)
    expect(notices()[0]?.data).toMatchObject({ sessionID: id, level: "info" })
    expect(String(notices()[0]?.data?.message)).toContain("webfetch")
  })

  test("a refused first prompt keeps the notices for the next one", async () => {
    const { id, proc } = await open(WEBFETCH_OFF)
    proc.on("prompt", () => {
      throw rpcError("prompt", "busy")
    })
    await failure(host.prompt(id, { text: "go" }))
    expect(notices()).toEqual([])
    proc.on("prompt", {})
    await host.prompt(id, { text: "again" })
    expect(notices()).toHaveLength(1)
  })

  test("a session disposed before any prompt drops its notices without saying them", async () => {
    const { id } = await open(WEBFETCH_OFF)
    await host.dispose(id)
    expect(notices()).toEqual([])
  })

  test("a card whose toggles are all enforced says nothing", async () => {
    await open({ ...BODY, card: { ...BODY.card, tools: { bash: false, skill: false, webfetch: true } } })
    expect(notices()).toEqual([])
  })

  test("a session resumed after the idle reaper does not repeat the note", async () => {
    await boot({ idleReapMs: 1000 })
    const { id, proc } = await open(WEBFETCH_OFF)
    await host.prompt(id, { text: "first" })
    finish(proc)
    expect(notices()).toHaveLength(1)
    await host.maintain(Date.now() + 5000)
    await host.prompt(id, { text: "wake up" })
    expect(h.fake.procs).toHaveLength(2)
    expect(notices()).toHaveLength(1)
  })

  test("a session resumed by reuse never announces the card's tool notes", async () => {
    const { id } = await open(WEBFETCH_OFF)
    await host.dispose(id)
    await host.create({ ...WEBFETCH_OFF, reuse: id })
    await host.prompt(id, { text: "go on" })
    expect(notices()).toEqual([])
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
  const TITLE = "Fix the parser (builder card)"

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

  test("a title from the engine is stored in the meta file, listed, and not replaced by the first prompt", async () => {
    const a = await open({ ...BODY, title: TITLE })
    await host.prompt(a.id, { text: "# OpenFlow You are one card in an OpenFlow pipeline" })
    expect((await host.list(10))[0]?.title).toBe(TITLE)

    const meta = JSON.parse(await fs.readFile(path.join(h.stateRoot, "run1", "n1", ".openflow-session.json"), "utf8")) as { title?: string }
    expect(meta.title).toBe(TITLE)

    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      expect((await restarted.list(10)).map((row) => [row.id, row.title])).toEqual([[a.id, TITLE]])
    } finally {
      await restarted.close()
    }
  })

  test("a resumed session keeps the title it was created with", async () => {
    const a = await open({ ...BODY, title: TITLE })
    await host.dispose(a.id)
    await host.create({ ...BODY, title: "something else entirely", reuse: a.id })
    await host.prompt(a.id, { text: "continue" })
    expect((await host.list(10)).find((row) => row.id === a.id)?.title).toBe(TITLE)

    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      await restarted.create({ ...BODY, reuse: a.id })
      expect((await restarted.list(10)).find((row) => row.id === a.id)?.title).toBe(TITLE)
    } finally {
      await restarted.close()
    }
  })

  test("a title is stripped of control characters and line breaks and clipped to 120 characters", async () => {
    const dirty = await open({ ...BODY, nodeId: "dirty", title: "  Builder\u001b[31m ·\u0000 fix\n\tthe\u202e parser  " })
    const long = await open({ ...BODY, nodeId: "long", title: "x".repeat(500) })
    const rows = await host.list(10)
    expect(rows.find((row) => row.id === dirty.id)?.title).toBe("Builder · fix the parser")
    const clipped = rows.find((row) => row.id === long.id)?.title ?? ""
    expect(clipped).toHaveLength(120)
    expect(clipped.endsWith("…")).toBe(true)
  })

  test("a blank title is no title: the first prompt names the session as before", async () => {
    const a = await open({ ...BODY, title: " \n\u0000 " })
    expect((await host.list(10))[0]?.title).toBe("card-1")
    await host.prompt(a.id, { text: "write the docs" })
    expect((await host.list(10))[0]?.title).toBe("write the docs")
  })

  test("the title taken from the first prompt is cleaned like a given one: no control characters or line breaks, clipped to 80 characters", async () => {
    const dirty = await open({ ...BODY, nodeId: "dirty" })
    await host.prompt(dirty.id, { text: "  fix\u001b[31m\u0000\n\tthe\u202e parser  " })
    const long = await open({ ...BODY, nodeId: "long" })
    await host.prompt(long.id, { text: "y".repeat(500) })
    const rows = await host.list(10)
    expect(rows.find((row) => row.id === dirty.id)?.title).toBe("fix the parser")
    const clipped = rows.find((row) => row.id === long.id)?.title ?? ""
    expect(clipped).toHaveLength(80)
    expect(clipped.endsWith("…")).toBe(true)
    // The stored title (what a restart lists) is the cleaned one too.
    const meta = JSON.parse(await fs.readFile(path.join(h.stateRoot, "run1", "dirty", ".openflow-session.json"), "utf8")) as { title?: string }
    expect(meta.title).toBe("fix the parser")
  })

  test("a title that is not a string is a 400 and spawns nothing", async () => {
    const error = await failure(host.create({ ...BODY, title: 7 }))
    expect(error.status).toBe(400)
    expect(error.code).toBe("bad-request")
    expect(h.fake.procs).toHaveLength(0)
  })
})

/** Resolves once `count` processes have been spawned. */
async function processes(count: number) {
  while (h.fake.procs.length < count) await new Promise<void>((resolve) => setImmediate(resolve))
}

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

  /** A session with a turn in flight: busy until the test finishes it. */
  async function working(nodeId: string) {
    const session = await open({ ...BODY, nodeId })
    await host.prompt(session.id, { text: "go" })
    return session
  }

  test("with every session busy a create is refused once, with a status and text the engine does not take for a provider rate limit, and spawns nothing", async () => {
    await working("a")
    await working("b")
    const error = await failure(host.create({ ...BODY, nodeId: "c" }))
    expect(error.code).toBe("too-many-sessions")
    // The engine retries what its `rateLimited()` matches (`HTTP 429`, "rate limit", "too many requests") on a 20 s backoff; a full host does not clear by itself.
    expect(`${error.message} (HTTP ${error.status})`).not.toMatch(/\b429\b|rate.?limit|too many requests/i)
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(2)
  })

  test("at the limit the least recently used idle session is closed to make room, and it resumes on its next prompt", async () => {
    let clock = 1_000_000
    const now = spyOn(Date, "now").mockImplementation(() => clock)
    try {
      const a = await open({ ...BODY, nodeId: "a" })
      clock += 1000
      const b = await open({ ...BODY, nodeId: "b" })
      clock += 1000
      // Reading a session counts as use: b is now the one longest unused.
      await host.wait(a.id, {})
      clock += 1000
      const c = await open({ ...BODY, nodeId: "c" })
      expect(b.proc.exitedNow).toBe(true)
      expect(a.proc.exitedNow).toBe(false)
      expect(c.proc.exitedNow).toBe(false)
      expect(host.live()).toBe(2)
      // Closed, not lost: nobody is told it died, and it is still there.
      expect(types(events)).not.toContain("flow.session.lost")
      expect((await host.list(10)).map((row) => row.id)).toContain(b.id)

      clock += 1000
      await host.prompt(b.id, { text: "back again" })
      const resumed = h.fake.procs.at(-1) as FakeProcess
      expect(resumed).not.toBe(b.proc)
      expect(resumed.of("open_session")).toHaveLength(1)
      expect(resumed.of("prompt")).toHaveLength(1)
      // Making room for it closed the now least recently used one, a.
      expect(a.proc.exitedNow).toBe(true)
      expect(c.proc.exitedNow).toBe(false)
      expect(host.live()).toBe(2)
    } finally {
      now.mockRestore()
    }
  })

  const guarded = {
    "a turn in flight": (session: { id: string; proc: FakeProcess }) => host.prompt(session.id, { text: "go" }),
    "a permission waiting for an answer": (session: { id: string; proc: FakeProcess }) => session.proc.emit(frames.approval("r1", "Allow tool: bash")),
    "a question waiting for an answer": (session: { id: string; proc: FakeProcess }) =>
      session.proc.emit({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "a", question: "Which?", options: [{ label: "x" }] }] }),
  }
  for (const [what, hold] of Object.entries(guarded)) {
    test(`a session with ${what} is never the one closed, however long it has been unused`, async () => {
      const first = await open({ ...BODY, nodeId: "a" })
      await hold(first)
      const second = await open({ ...BODY, nodeId: "b" })
      await open({ ...BODY, nodeId: "c" })
      expect(first.proc.exitedNow).toBe(false)
      expect(second.proc.exitedNow).toBe(true)
      expect(host.live()).toBe(2)
    })
  }

  test("a session still starting is never the one closed, and counts against the limit", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    const configuring = gate()
    h.fake.setup((proc, index) => {
      if (index === 1) proc.on("set_ask_dialog", () => configuring.hold())
    })
    const starting = host.create({ ...BODY, nodeId: "b" })
    await configuring.reached
    await host.create({ ...BODY, nodeId: "c" })
    expect(a.proc.exitedNow).toBe(true)
    expect((h.fake.procs[1] as FakeProcess).exitedNow).toBe(false)
    configuring.release()
    await starting
    expect(host.live()).toBe(2)
  })

  test("creates that arrive together close different sessions, so the limit holds", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    const b = await open({ ...BODY, nodeId: "b" })
    await Promise.all([host.create({ ...BODY, nodeId: "c" }), host.create({ ...BODY, nodeId: "d" })])
    expect(a.proc.exitedNow).toBe(true)
    expect(b.proc.exitedNow).toBe(true)
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

  test("resuming a session counts: a reuse with every other session busy is refused and the session stays on disk", async () => {
    const a = await open({ ...BODY, nodeId: "a" })
    await host.dispose(a.id)
    await working("b")
    await working("c")
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

hosted("aborted creates", () => {
  const aborted = (promise: Promise<unknown>) => promise.then(() => undefined, (caught: unknown) => caught)

  test("an abort while omp is becoming ready closes it, drops the record and rejects the create", async () => {
    h.fake.next({ holdReady: true })
    const controller = new AbortController()
    const pending = aborted(host.create(BODY, controller.signal))
    await processes(1)
    controller.abort()
    expect(await pending).toBe(controller.signal.reason)
    expect((h.fake.procs[0] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
    expect(host.holds(safeSegment("run1"))).toBe(false)
    expect(host.active()).toEqual([])
    expect(await host.list(10)).toEqual([])
    // Nothing is left over to get in the way of the next create.
    await host.create(BODY)
    expect(host.live()).toBe(1)
  })

  test("an abort while a new session is being configured does the same", async () => {
    const configuring = gate()
    h.fake.setup((proc) => proc.on("set_ask_dialog", () => configuring.hold()))
    const controller = new AbortController()
    const pending = aborted(host.create(BODY, controller.signal))
    await configuring.reached
    controller.abort()
    configuring.release()
    expect(await pending).toBe(controller.signal.reason)
    expect((h.fake.procs[0] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)
    expect(await host.list(10)).toEqual([])
  })

  test("an abort while a saved session is opening closes the process and leaves the session resumable", async () => {
    const { id } = await open()
    await host.dispose(id)
    const opening = gate()
    h.fake.setup((proc) => proc.on("open_session", () => opening.hold()))
    const controller = new AbortController()
    const pending = aborted(host.create({ ...BODY, reuse: id }, controller.signal))
    await opening.reached
    controller.abort()
    opening.release()
    expect(await pending).toBe(controller.signal.reason)
    expect((h.fake.procs[1] as FakeProcess).exitedNow).toBe(true)
    expect(host.live()).toBe(0)

    h.fake.setup((proc) => proc.on("open_session", { cancelled: false, resumed: true }))
    expect(await host.create({ ...BODY, reuse: id })).toEqual({ id })
    expect(host.live()).toBe(1)
  })

  test("a signal that is already aborted spawns nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await aborted(host.create(BODY, controller.signal))).toBe(controller.signal.reason)
    expect(h.fake.procs).toHaveLength(0)
    expect(host.holds(safeSegment("run1"))).toBe(false)
  })

  test("an abort after the session is live changes nothing", async () => {
    const controller = new AbortController()
    const { id } = await host.create(BODY, controller.signal)
    controller.abort()
    await processes(1)
    const proc = h.fake.procs[0] as FakeProcess
    expect(proc.exitedNow).toBe(false)
    expect(proc.closeCalls).toBe(0)
    expect(host.live()).toBe(1)
    await host.prompt(id, { text: "still here" })
    expect(proc.of("prompt")).toHaveLength(1)
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

/** A turn of conversation as omp streams it, then the prompt's result. */
async function converse(id: string, proc: FakeProcess, question: string, answer: string) {
  await host.prompt(id, { text: question })
  proc.emit(frames.userMessage(`u-${question}`, question))
  proc.emit(frames.messageEnd(`m-${question}`, assistantMessage({ texts: [answer] })))
  finish(proc)
}

const nodeDir = (run: string, node = "n1") => path.join(h.stateRoot, safeSegment(run), safeSegment(node))

hosted("resume from another run", () => {
  test("a session saved under one run resumes from its own directory when a newer run asks for it", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await converse(a.id, a.proc, "first question", "first answer")
    await host.releaseRun("runA")

    const resumed = await host.create({ ...BODY, runId: "runB", reuse: a.id })
    expect(resumed).toEqual({ id: a.id })
    const proc = h.fake.procs[1] as FakeProcess
    // omp's JSONL lives where the first run wrote it: that is the directory it is asked to open.
    expect(proc.of("open_session")[0]?.sessionDir).toBe(path.join(nodeDir("runA"), SESSION_SUBDIR))
    expect(h.launches[1]?.stateDir).toBe(nodeDir("runA"))
    // New work belongs to the new run.
    expect(h.launches[1]?.session.runId).toBe("runB")
    expect(host.live()).toBe(1)
    expect((await host.list(10)).filter((row) => row.id === a.id)).toHaveLength(1)
    await expect(fs.stat(nodeDir("runB"))).rejects.toThrow()
    // The metadata keeps naming the run that wrote it.
    await host.prompt(a.id, { text: "second question" })
    await host.releaseRun("runB")
    expect(JSON.parse(await fs.readFile(path.join(nodeDir("runA"), ".openflow-session.json"), "utf8"))).toMatchObject({ id: a.id, runId: "runA", nodeId: "n1" })
  })

  test("what was said before the resume stays in front of the new turns until omp pages the history in", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await converse(a.id, a.proc, "first question", "first answer")
    await host.releaseRun("runA")
    await host.create({ ...BODY, runId: "runB", reuse: a.id })
    const proc = h.fake.procs[1] as FakeProcess
    await converse(a.id, proc, "second question", "second answer")
    const expected: Turn[] = [
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer" },
    ]
    expect(await host.turns(a.id, 10)).toEqual(expected)
    // And on disk, so a later host reads the whole conversation rather than only the resumed part.
    await host.releaseRun("runB")
    expect(await host.turns(a.id, 10)).toEqual(expected)
  })

  test("the history omp pages in replaces the saved turns instead of doubling them", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await converse(a.id, a.proc, "q", "a")
    await host.releaseRun("runA")
    h.fake.setup((proc) => {
      proc.on("open_session", { cancelled: false, resumed: true })
      proc.on("get_messages_page", { messages: [{ role: "user", content: "q", timestamp: 1 }, assistantMessage({ texts: ["a"] })] })
    })
    await host.create({ ...BODY, runId: "runB", reuse: a.id })
    expect(await host.turns(a.id, 10)).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ])
  })

  test("the directory it lives in is held while the resumed session is, so a prune cannot take its files", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await host.releaseRun("runA")
    expect(host.holds(safeSegment("runA"))).toBe(false)
    await host.create({ ...BODY, runId: "runB", reuse: a.id })
    expect(host.holds(safeSegment("runA"))).toBe(true)
    expect(host.claim(safeSegment("runA"))).toBeUndefined()
    await host.releaseRun("runB")
    expect(host.holds(safeSegment("runA"))).toBe(false)
  })

  test("a run being pruned cannot be adopted: the usual 404, and nothing is spawned", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await host.releaseRun("runA")
    const release = host.claim(safeSegment("runA"))
    expect(release).toBeDefined()
    const error = await failure(host.create({ ...BODY, runId: "runB", reuse: a.id }))
    release?.()
    expect(error.status).toBe(404)
    expect(h.fake.procs).toHaveLength(1)
  })

  test("a session id only matches by its metadata: an id that is a path is a plain 404", async () => {
    await open({ ...BODY, runId: "runA" })
    for (const reuse of ["../run1", "..", "run1/n1", "s_000000000000"]) {
      expect((await failure(host.create({ ...BODY, runId: "runB", reuse }))).status).toBe(404)
    }
    expect(h.fake.procs).toHaveLength(1)
  })

  test("two concurrent resumes of one saved session from different runs share one process", async () => {
    const a = await open({ ...BODY, runId: "runA" })
    await host.releaseRun("runA")
    const both = await Promise.all([host.create({ ...BODY, runId: "runB", reuse: a.id }), host.create({ ...BODY, runId: "runC", reuse: a.id })])
    expect(both).toEqual([{ id: a.id }, { id: a.id }])
    expect(h.fake.procs).toHaveLength(2)
    expect(host.live()).toBe(1)
  })
})

hosted("history of finished sessions", () => {
  async function released() {
    const a = await open()
    await converse(a.id, a.proc, "do it", "done")
    await host.releaseRun("run1")
    return a.id
  }

  test("a released session is listed and its conversation can be read, without starting a process", async () => {
    const id = await released()
    expect((await host.list(10)).map((row) => row.id)).toEqual([id])
    expect(await host.turns(id, 10)).toEqual([
      { role: "user", text: "do it" },
      { role: "assistant", text: "done" },
    ])
    expect(await host.turns(id, 1)).toEqual([{ role: "assistant", text: "done" }])
    // The engine's own reads (final, steps, calls) still end with the release: only the Sessions panel reads a finished conversation.
    expect((await failure(host.final(id))).status).toBe(404)
    expect(h.fake.procs).toHaveLength(1)
    expect(host.live()).toBe(0)
  })

  test("it survives a host restart", async () => {
    const id = await released()
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      expect((await restarted.list(10)).map((row) => row.id)).toEqual([id])
      expect((await restarted.turns(id, 10)).map((turn) => turn.text)).toEqual(["do it", "done"])
      expect(h.fake.procs).toHaveLength(1)
    } finally {
      await restarted.close()
    }
  })

  test("a process that died keeps its conversation readable after a restart too", async () => {
    const a = await open()
    await converse(a.id, a.proc, "q", "partial")
    a.proc.exit(1)
    await a.proc.exited
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      expect((await restarted.turns(a.id, 10)).map((turn) => turn.text)).toEqual(["q", "partial"])
    } finally {
      await restarted.close()
    }
  })

  test("a session whose history is gone is not listed and answers a clean 404", async () => {
    const id = await released()
    await fs.rm(path.join(nodeDir("run1"), ".openflow-turns.json"))
    expect(await host.list(10)).toEqual([])
    const error = await failure(host.turns(id, 10))
    expect(error.status).toBe(404)
    expect(error.code).toBe("session-not-found")
  })

  test("a pruned session answers 404", async () => {
    const id = await released()
    await fs.rm(path.join(h.stateRoot, safeSegment("run1")), { recursive: true })
    expect((await failure(host.turns(id, 10))).status).toBe(404)
    expect(await host.list(10)).toEqual([])
  })

  test("a damaged turns file is a 404, not a crash", async () => {
    const id = await released()
    await fs.writeFile(path.join(nodeDir("run1"), ".openflow-turns.json"), "{not json")
    expect((await failure(host.turns(id, 10))).status).toBe(404)
  })

  test("the saved history is clipped and private to the user", async () => {
    const a = await open()
    await converse(a.id, a.proc, "q", "x".repeat(100_000))
    await host.releaseRun("run1")
    const file = path.join(nodeDir("run1"), ".openflow-turns.json")
    expect((await fs.stat(file)).mode & 0o077).toBe(0)
    const turns = await host.turns(a.id, 10)
    expect(turns[1]?.text.length).toBeLessThan(100_000)
  })

  test("the latest conversation replaces the earlier one: reading after more turns shows them", async () => {
    const a = await open()
    await converse(a.id, a.proc, "one", "1")
    await converse(a.id, a.proc, "two", "2")
    await host.releaseRun("run1")
    expect((await host.turns(a.id, 10)).map((turn) => turn.text)).toEqual(["one", "1", "two", "2"])
  })
})

hosted("shutdown", () => {
  /** Holds the first call of an fs function whose target satisfies `match`; every other call goes straight through. */
  function hold(name: "mkdir" | "stat", match: (target: string) => boolean) {
    const held = gate()
    const real = fs[name] as (...args: unknown[]) => Promise<unknown>
    let used = false
    const spy = spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
      if (!used && match(String(args[0]))) {
        used = true
        await held.hold()
      }
      return real(...args)
    }) as never)
    return { held, spy }
  }

  test("a create parked in its first mkdir does not launch after close returns", async () => {
    const { held, spy } = hold("mkdir", (target) => target.startsWith(h.stateRoot))
    try {
      const creating = failure(host.create(BODY))
      await held.reached
      await host.close()
      held.release()
      const error = await creating
      expect(error.status).toBe(409)
      expect(error.code).toBe("session-closed")
      expect(h.fake.procs).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("a create still parsing its request does not launch after close returns", async () => {
    const { held, spy } = hold("stat", (target) => target === h.project)
    try {
      const creating = failure(host.create(BODY))
      await held.reached
      await host.close()
      held.release()
      expect((await creating).code).toBe("session-closed")
      expect(h.fake.procs).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("after close every create and reuse is refused", async () => {
    const { id } = await open()
    await host.dispose(id)
    await host.close()
    expect((await failure(host.create(BODY))).code).toBe("session-closed")
    expect((await failure(host.create({ ...BODY, reuse: id }))).code).toBe("session-closed")
    expect(h.fake.procs).toHaveLength(1)
    expect(host.live()).toBe(0)
  })

  test("a reuse parked while its metadata is read does not launch after close returns", async () => {
    const { id } = await open()
    await host.dispose(id)
    const { held, spy } = hold("stat", (target) => target.endsWith(".openflow-turns.json"))
    try {
      const resuming = failure(host.create({ ...BODY, runId: "runB", reuse: id }))
      await held.reached
      await host.close()
      held.release()
      expect((await resuming).code).toBe("session-closed")
      expect(h.fake.procs).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})

hosted("a resumed session follows the request that resumes it", () => {
  const FAR = 24 * 60 * 60_000

  async function directories() {
    const elsewhere = path.join(h.dir, "elsewhere")
    const other = path.join(h.dir, "other")
    await fs.mkdir(elsewhere)
    await fs.mkdir(other)
    return { elsewhere, other }
  }

  test("a reaped session reused by a new run launches with the new model, permissions, run and directory, and keeps its id and files", async () => {
    const { elsewhere, other } = await directories()
    const { id } = await open({ ...BODY, directory: elsewhere, permissions: "auto" })
    await host.maintain(Date.now() + FAR)
    expect(host.live()).toBe(0)

    await host.create({ ...BODY, runId: "run2", model: "anthropic/claude-other", permissions: "manual", directory: other, reuse: id })

    expect(h.launches.at(-1)?.session).toMatchObject({ runId: "run2", model: "anthropic/claude-other", permissions: "manual", directory: other })
    expect(h.launches.at(-1)?.stateDir).toBe(nodeDir("run1"))
    expect((h.fake.procs[1] as FakeProcess).of("open_session")[0]?.sessionDir).toBe(path.join(nodeDir("run1"), SESSION_SUBDIR))
    // The session now belongs to the run that resumed it: that run's release finds it, the old run's does not.
    expect(host.holds(safeSegment("run2"))).toBe(true)
    expect(await host.releaseRun("run1")).toBe(0)
    expect(host.live()).toBe(1)
    expect(await host.releaseRun("run2")).toBe(1)
    expect(host.live()).toBe(0)
  })

  test("a lost session reused by a new run is resumed with the new request too", async () => {
    const { id, proc } = await open({ ...BODY, permissions: "auto" })
    proc.exit(1)
    await proc.exited
    await host.create({ ...BODY, runId: "run2", permissions: "manual", swarm: "off", reuse: id })
    expect(h.launches.at(-1)?.session).toMatchObject({ runId: "run2", permissions: "manual" })
    expect(await host.releaseRun("run2")).toBe(1)
  })

  test("a session resumed from its files works in the NEW request's directory, with its files where they were; the old directory is named once, only while it exists and differs", async () => {
    const { elsewhere, other } = await directories()
    const { id } = await open({ ...BODY, directory: elsewhere })
    await host.dispose(id)
    await host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    expect(h.launches.at(-1)?.session.directory).toBe(other)
    expect(h.launches.at(-1)?.stateDir).toBe(nodeDir("run1"))
    await host.prompt(id, { text: "carry on" })
    const carried = events.filter((event) => event.type === "flow.notice" && String(event.data?.message).includes(elsewhere))
    expect(carried).toHaveLength(1)
    expect(String(carried[0]?.data?.message)).toContain("may not have been merged")

    // A second resume of the same session does not repeat it (its start has said it once).
    await host.dispose(id)
    events.length = 0
    await host.create({ ...BODY, runId: "run3", directory: other, reuse: id })
    await host.prompt(id, { text: "again" })
    expect(events.filter((event) => event.type === "flow.notice" && String(event.data?.message).includes(elsewhere))).toEqual([])
  })

  test("no notice when the old directory is gone or is the new one", async () => {
    const { elsewhere, other } = await directories()
    const gone = await open({ ...BODY, directory: elsewhere })
    await host.dispose(gone.id)
    await fs.rm(elsewhere, { recursive: true })
    await host.create({ ...BODY, runId: "run2", directory: other, reuse: gone.id })
    await host.prompt(gone.id, { text: "x" })

    const same = await open({ ...BODY, nodeId: "n2", directory: other })
    await host.maintain(Date.now() + FAR)
    await host.create({ ...BODY, nodeId: "n2", runId: "run3", directory: other, reuse: same.id })
    await host.prompt(same.id, { text: "x" })
    expect(events.filter((event) => event.type === "flow.notice" && String(event.data?.message).includes("git -C"))).toEqual([])
  })

  const said = (where: string) => events.filter((event) => event.type === "flow.notice" && String(event.data?.message).includes(where))

  test("a session still live when the new run reuses it relaunches in the new directory, and says so once", async () => {
    const { elsewhere, other } = await directories()
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    expect(host.live()).toBe(1)

    await host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    expect(proc.closeCalls).toBe(1)
    expect(h.fake.procs).toHaveLength(2)
    expect(h.launches.at(-1)?.session.directory).toBe(other)
    expect(host.live()).toBe(1)
    await host.prompt(id, { text: "carry on" })
    const notices = said(elsewhere)
    expect(notices).toHaveLength(1)
    expect(String(notices[0]?.data?.message)).toBe(`Work it did there before then may not have been merged into this run. Inspect it with: git -C "${elsewhere}" status`)
    // The files stayed where they were, and the session still answers to its id.
    expect(h.launches.at(-1)?.stateDir).toBe(nodeDir("run1"))
  })

  test("a live session resumed in the same directory under a new run belongs to the new run: it is released with it, saved under it, and never respawned", async () => {
    const { elsewhere } = await directories()
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    await host.create({ ...BODY, runId: "run2", directory: elsewhere, model: "anthropic/claude-other", reuse: id })
    expect(proc.closeCalls).toBe(0)
    expect(h.fake.procs).toHaveLength(1)
    expect(said("git -C")).toEqual([])
    expect(host.holds(safeSegment("run2"))).toBe(true)
    // The metadata is written asynchronously by the save the reuse queued: wait for the file, not for a number of turns.
    const file = path.join(nodeDir("run1"), ".openflow-session.json")
    const deadline = Date.now() + 10_000
    let saved = JSON.parse(await fs.readFile(file, "utf8")).request?.runId
    while (saved !== "run2" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      saved = JSON.parse(await fs.readFile(file, "utf8")).request?.runId
    }
    expect(saved).toBe("run2")
    expect(await host.releaseRun("run1")).toBe(0)
    expect(host.live()).toBe(1)
    expect(await host.releaseRun("run2")).toBe(1)
    expect(host.live()).toBe(0)
  })

  test("a live session reused with the same directory is left running, and one whose old directory is gone is not relaunched or announced", async () => {
    const { elsewhere, other } = await directories()
    const same = await open({ ...BODY, directory: elsewhere })
    await host.create({ ...BODY, runId: "run2", directory: elsewhere, reuse: same.id })
    expect(same.proc.closeCalls).toBe(0)
    expect(h.fake.procs).toHaveLength(1)

    const lost = await open({ ...BODY, nodeId: "n2", directory: other })
    await fs.rm(other, { recursive: true })
    const kept = path.join(h.dir, "kept")
    await fs.mkdir(kept)
    await host.create({ ...BODY, nodeId: "n2", runId: "run3", directory: kept, reuse: lost.id })
    await host.prompt(lost.id, { text: "x" })
    expect(said("git -C")).toEqual([])
  })

  test("the notice survives an interruption before the first prompt: the next resume still says it, once, and then it is spent", async () => {
    const { elsewhere, other } = await directories()
    const { id } = await open({ ...BODY, directory: elsewhere })
    await host.dispose(id)
    const first = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    await first.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    // The resumed run is interrupted before it sent a prompt: the host goes away with the notice unsaid.
    await first.close()
    expect(said(elsewhere)).toEqual([])

    const second = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      await second.create({ ...BODY, runId: "run3", directory: other, reuse: id })
      await second.prompt(id, { text: "go" })
      expect(said(elsewhere)).toHaveLength(1)
      await second.maintain(Date.now() + FAR)
      await second.create({ ...BODY, runId: "run4", directory: other, reuse: id })
      await second.prompt(id, { text: "again" })
      expect(said(elsewhere)).toHaveLength(1)
    } finally {
      await second.close()
    }
    const meta = JSON.parse(await fs.readFile(path.join(nodeDir("run1"), ".openflow-session.json"), "utf8"))
    expect(meta.carried).toBeUndefined()
  })

  test("a persisted directory is repeated in the notice only when it is safe to paste into a command, and then in double quotes", async () => {
    const hostile = [
      "relative/dir",
      "/tmp/it's",
      '/tmp/say "hi"',
      "/tmp/$(id)",
      "/tmp/`id`",
      "/tmp/a;b",
      "/tmp/a|b",
      "/tmp/a&b",
      "/tmp/a<b>c",
      "/tmp/(a){b}",
      "/tmp/bad\nname",
      "/tmp/zero\u200bwidth",
      "/tmp/bidi\u202eflip",
      "/tmp/bom\ufeff",
      `/tmp/${"y".repeat(240)}`,
    ]
    for (const directory of hostile) {
      const message = carriedNotice(directory)
      expect(message).not.toContain("git -C")
      expect(message).not.toContain(directory)
      expect(message).toContain("previous working directory")
    }
    expect(carriedNotice("/work/my project/tree-1.x@2+3:4~5")).toBe('Work it did there before then may not have been merged into this run. Inspect it with: git -C "/work/my project/tree-1.x@2+3:4~5" status')
  })

  test("a hostile directory that really was persisted gives the command-free notice end to end", async () => {
    const { other } = await directories()
    const odd = path.join(h.dir, "it's here")
    await fs.mkdir(odd)
    const { id } = await open({ ...BODY, directory: odd })
    await host.dispose(id)
    await host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    await host.prompt(id, { text: "go" })
    const message = String(events.find((event) => event.type === "flow.notice" && String(event.data?.message).includes("may not have been merged"))?.data?.message)
    expect(message).not.toContain("git -C")
  })

  test("the pending notice is written by the reuse itself, before the resumed process says anything", async () => {
    const { elsewhere, other } = await directories()
    const { id } = await open({ ...BODY, directory: elsewhere })
    await host.dispose(id)
    await host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    // Nothing else writes the metadata between the resume and the first prompt: the file must already owe the notice. (Reads are bounded retries: the write is queued, not awaited.)
    const file = path.join(nodeDir("run1"), ".openflow-session.json")
    let owed: string | undefined
    // No event to await for a queued file write: poll against a generous deadline, not a fixed number of turns.
    const deadline = Date.now() + 10_000
    while (owed === undefined && Date.now() < deadline) {
      owed = JSON.parse(await fs.readFile(file, "utf8")).carried
      if (owed === undefined) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(owed).toBe(elsewhere)
  })

  /** Makes the next `close()` of a process wait until released: the window in which a live session is being stopped for a relaunch. */
  function slowClose(proc: FakeProcess) {
    const closing = gate()
    const real = proc.close.bind(proc)
    proc.close = async (options) => {
      await closing.hold()
      return real(options)
    }
    return closing
  }

  /** Every process spawned so far that is not gone, counted from the fake: a leaked one never had `close()` or `kill()` called. */
  const running = () => h.fake.procs.filter((proc) => proc.closeCalls === 0 && proc.killCalls === 0)

  test("two overlapping reuses of one session leave exactly one live process, and none leaked", async () => {
    const { elsewhere, other } = await directories()
    const { id } = await open({ ...BODY, directory: elsewhere })
    await host.maintain(Date.now() + FAR)
    const both = await Promise.all([host.create({ ...BODY, runId: "run2", directory: other, reuse: id }), host.create({ ...BODY, runId: "run3", directory: other, reuse: id })])
    expect(both).toEqual([{ id }, { id }])
    expect(host.live()).toBe(1)
    expect(running()).toHaveLength(1)
  })

  test("overlapping reuses of a live session, with a new directory each, never run two processes at once", async () => {
    const { elsewhere, other } = await directories()
    const third = path.join(h.dir, "third")
    await fs.mkdir(third)
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    const closing = slowClose(proc)
    const first = host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    // The first reuse is inside its stop (so it is the one being served) before the second is issued: the queue order is the test's, not the scheduler's.
    await closing.reached
    const second = host.create({ ...BODY, runId: "run3", directory: third, reuse: id })
    closing.release()
    await Promise.all([first, second])
    expect(host.live()).toBe(1)
    expect(running()).toHaveLength(1)
    expect(h.launches.at(-1)?.session.directory).toBe(third)
  })

  test("a prompt arriving while the live session is being stopped for a relaunch waits for it: one process, and it is the new one", async () => {
    const { elsewhere, other } = await directories()
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    const closing = slowClose(proc)
    const reusing = host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    await closing.reached
    const prompting = host.prompt(id, { text: "stray" })
    closing.release()
    await Promise.all([reusing, prompting])
    expect(host.live()).toBe(1)
    expect(running()).toHaveLength(1)
    expect(h.fake.procs).toHaveLength(2)
    expect(h.launches.at(-1)?.session.directory).toBe(other)
    expect(JSON.stringify((h.fake.procs[1] as FakeProcess).of("prompt")[0]?.message)).toContain("stray")
  })

  test("a session released while it is being stopped for a relaunch is not relaunched: the usual 404, nothing spawned", async () => {
    const { elsewhere, other } = await directories()
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    const closing = slowClose(proc)
    const reusing = failure(host.create({ ...BODY, runId: "run2", directory: other, reuse: id }))
    await closing.reached
    expect(await host.releaseRun("run1")).toBe(1)
    closing.release()
    expect((await reusing).status).toBe(404)
    expect(h.fake.procs).toHaveLength(1)
    expect(host.live()).toBe(0)
  })

  test("an old directory removed while the session is being stopped is neither announced nor an obstacle: the session relaunches in the new one", async () => {
    const { elsewhere, other } = await directories()
    const { id, proc } = await open({ ...BODY, directory: elsewhere })
    const closing = slowClose(proc)
    const reusing = host.create({ ...BODY, runId: "run2", directory: other, reuse: id })
    await closing.reached
    await fs.rm(elsewhere, { recursive: true })
    closing.release()
    expect(await reusing).toEqual({ id })
    await host.prompt(id, { text: "go" })
    expect(h.launches.at(-1)?.session.directory).toBe(other)
    expect(said("git -C")).toEqual([])
  })
})

hosted("a prompt for a session this host holds no record of", () => {
  const FAR = 24 * 60 * 60_000

  test("after a restart it resumes the session as it was launched instead of answering 404", async () => {
    const card = { key: "card-1", role: "Builder", prompt: "be brief", tools: { bash: false } }
    const { id } = await open({ ...BODY, card, permissions: "manual" })
    await host.close()
    const restarted = createSessionHost(h.deps, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    try {
      await restarted.prompt(id, { text: "carry on" })
      const proc = h.fake.procs[1] as FakeProcess
      expect(proc.of("open_session")).toHaveLength(1)
      expect(JSON.stringify(proc.of("prompt")[0]?.message)).toContain("carry on")
      expect(h.launches.at(-1)?.session).toMatchObject({ model: "anthropic/claude-test", permissions: "manual", card })
      expect(restarted.live()).toBe(1)
    } finally {
      await restarted.close()
    }
  })

  test("a session whose files are gone, and one disposed on purpose, are still the usual 404", async () => {
    const { id } = await open()
    await host.dispose(id)
    expect((await failure(host.prompt(id, { text: "x" }))).status).toBe(404)
    expect((await failure(host.prompt("s_000000000000", { text: "x" }))).status).toBe(404)
    expect(h.fake.procs).toHaveLength(1)
  })

  test("records past the limit are dropped by last activity, never by age of creation, and a dropped one resumes on its next prompt", async () => {
    await boot({}, { maxLive: 200 })
    const base = Date.now()
    const ids: string[] = []
    try {
      for (let index = 0; index < 70; index++) {
        setSystemTime(new Date(base + index * 1000))
        ids.push((await open({ ...BODY, nodeId: `n${index}` })).id)
      }
      // The oldest card is the one in use: its record is the most recently active.
      setSystemTime(new Date(base + 500_000))
      await host.wait(ids[0] as string, {})
    } finally {
      setSystemTime()
    }
    await host.maintain(base + FAR)
    expect(host.live()).toBe(0)

    expect(await host.wait(ids[0] as string, {})).toEqual({ status: "idle", result: "completed" })
    expect(await host.wait(ids[1] as string, {})).toEqual({ status: "missing" })
    expect(await host.wait(ids[69] as string, {})).toEqual({ status: "idle", result: "completed" })

    await host.prompt(ids[1] as string, { text: "still there?" })
    expect(host.live()).toBe(1)
    expect((h.fake.procs.at(-1) as FakeProcess).of("open_session")).toHaveLength(1)
  })
})

hosted("session files and project capture", () => {
  test("the metadata and turns files are written aside and renamed into place, privately, leaving nothing behind", async () => {
    const spy = spyOn(fs, "writeFile")
    try {
      const { id } = await open()
      await host.prompt(id, { text: "hello" })
      await host.dispose(id)
      const targets = spy.mock.calls.map((call) => String(call[0]))
      expect(targets.some((target) => target.endsWith(".openflow-session.json") || target.endsWith(".openflow-turns.json"))).toBe(false)
      expect(targets.filter((target) => target.includes(".openflow-session.json.") && target.endsWith(".tmp")).length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
    for (const name of [".openflow-session.json", ".openflow-turns.json"]) expect((await fs.stat(path.join(nodeDir("run1"), name))).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(nodeDir("run1"))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a create reads the project once: a switch while it parses cannot split a card's directory from its state", async () => {
    const other = path.join(h.dir, "project-b")
    await fs.mkdir(other)
    let current = h.project
    const rootOf = (project: string) => path.join(h.stateRoot, project === h.project ? "a" : "b")
    const switching = createSessionHost({ ...h.deps, project: () => current, stateRoot: () => rootOf(current) }, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    // The canvas switches folders while the request is being checked.
    const real = fs.stat as (...args: unknown[]) => Promise<unknown>
    const spy = spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
      current = other
      return real(...args)
    }) as never)
    try {
      await switching.create({ runId: "run1", nodeId: "n1", card: { key: "card-1", role: "Builder" } })
    } finally {
      spy.mockRestore()
      await switching.close()
    }
    expect(h.launches[0]?.session.directory).toBe(h.project)
    expect(h.launches[0]?.stateDir).toBe(path.join(rootOf(h.project), "run1", "n1"))
  })

  test("every live session holds the project, idle between turns included, and is named; a reaped or disposed one does not", async () => {
    expect(host.working()).toBe(false)
    const { id, proc } = await open()
    expect(host.working()).toBe(true)
    expect(host.holders()).toEqual([id])

    await host.prompt(id, { text: "go" })
    finish(proc)
    expect(host.working()).toBe(true)
    expect(host.holders()).toEqual([id])

    await host.maintain(Date.now() + 24 * 60 * 60_000)
    expect(host.live()).toBe(0)
    expect(host.working()).toBe(false)
    expect(host.holders()).toEqual([])
    await host.prompt(id, { text: "wake up" })
    expect(host.working()).toBe(true)
    await host.dispose(id)
    expect(host.working()).toBe(false)
    expect(host.holders()).toEqual([])
  })

  test("a session waiting on a dialog is among the holders", async () => {
    const { id, proc } = await open({ ...BODY, permissions: "manual" })
    await host.prompt(id, { text: "go" })
    proc.emit(frames.approval("r1", "Allow tool: bash\ncommand: ls"))
    expect(host.holders()).toEqual([id])
    host.replyPermission(id, "r1", "once")
    finish(proc)
    expect(host.holders()).toEqual([id])
  })

  test("a create is counted from its first line: while its request is still being parsed the project is already held, and nobody is named", async () => {
    const parsing = gate()
    const real = fs.stat as (...args: unknown[]) => Promise<unknown>
    const spy = spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === h.project) await parsing.hold()
      return real(...args)
    }) as never)
    try {
      const creating = host.create(BODY)
      await parsing.reached
      expect(host.working()).toBe(true)
      expect(host.holders()).toEqual([])
      parsing.release()
      await creating
    } finally {
      spy.mockRestore()
    }
    expect(host.working()).toBe(true)
  })

  test("a create that fails while parsing releases the count", async () => {
    expect((await failure(host.create({ ...BODY, permissions: "yolo" }))).status).toBe(400)
    expect(host.working()).toBe(false)
  })

  test("working is true while a create is still starting its process", async () => {
    const opening = gate()
    h.fake.setup((proc) => proc.on("set_ask_dialog", opening.hold))
    const creating = host.create(BODY)
    await opening.reached
    expect(host.working()).toBe(true)
    opening.release()
    await creating
  })
})

hosted("finding persisted sessions under a bounded scan", () => {
  const DAY = 24 * 60 * 60_000

  /** Directories in the state root that sort first in readdir order and are all older than any real session. */
  async function fillWithOldRuns(count: number) {
    const old = new Date(Date.now() - 40 * DAY)
    for (let index = 0; index < count; index++) {
      const node = path.join(h.stateRoot, `a-old-${index}`, "n1")
      await fs.mkdir(node, { recursive: true })
      await fs.utimes(node, old, old)
      await fs.utimes(path.dirname(node), old, old)
    }
  }

  test("a recent conversation is listed and resumable even when more old run directories than the bound sort before it", async () => {
    await boot({}, { scan: { runs: 3, nodes: 3 } })
    const { id } = await open({ ...BODY, runId: "recent" })
    await host.dispose(id)
    await fillWithOldRuns(8)

    expect((await host.list(10)).map((row) => row.id)).toContain(id)
    expect(await host.create({ ...BODY, runId: "next", reuse: id })).toEqual({ id })
    expect(h.fake.procs).toHaveLength(2)
  })

  test("the card bound picks the newest cards across the chosen runs, not the first ones in directory order", async () => {
    await boot({}, { scan: { runs: 10, nodes: 1 } })
    const first = await open({ ...BODY, runId: "run-a", nodeId: "n1" })
    await host.dispose(first.id)
    const old = new Date(Date.now() - 40 * DAY)
    await fs.utimes(nodeDir("run-a"), old, old)
    const second = await open({ ...BODY, runId: "run-b", nodeId: "n1" })
    await host.dispose(second.id)

    expect((await host.list(10)).map((row) => row.id)).toEqual([second.id])
  })

  test("a session in use again keeps its old run directory ranked as recent: still listed and resumable under a bound below the number of runs", async () => {
    let clock = 1_000_000
    await boot({}, { scan: { runs: 3, nodes: 10 }, now: () => clock })
    const { id } = await open({ ...BODY, runId: "old-run" })
    // Reaped, not disposed: the record stays, as for a card between turns.
    await host.maintain(Date.now() + DAY)
    const runDir = path.dirname(nodeDir("old-run"))
    const long = new Date(Date.now() - 40 * DAY)
    await fs.utimes(runDir, long, long)
    const recent = new Date(Date.now() - DAY)
    for (let index = 0; index < 5; index++) {
      const other = path.join(h.stateRoot, `b-run-${index}`, "n1")
      await fs.mkdir(other, { recursive: true })
      await fs.utimes(path.dirname(other), recent, recent)
    }

    clock += 10_000
    await host.create({ ...BODY, runId: "next", reuse: id })
    await host.dispose(id)
    clock += 10_000

    expect((await host.list(10)).map((row) => row.id)).toContain(id)
    expect(await host.create({ ...BODY, runId: "after", reuse: id })).toEqual({ id })
  })

  test("the run directory is touched at most once a second however often the session saves", async () => {
    let clock = 1_000_000
    await boot({}, { now: () => clock })
    const runDir = path.dirname(nodeDir("run1"))
    const spy = spyOn(fs, "utimes")
    const touches = () => spy.mock.calls.filter((call) => String(call[0]) === runDir).length
    try {
      const { id } = await open()
      await host.prompt(id, { text: "hello" })
      await host.dispose(id)
      expect(touches()).toBe(1)
      clock += 1_500
      await host.create({ ...BODY, reuse: id })
      expect(touches()).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})

hosted("sessions of another project", () => {
  /** A host whose project (and so state root) can be switched, as the canvas does when nothing is working. */
  function switchable() {
    const current = { project: h.project, root: path.join(h.stateRoot, "a") }
    const other = { project: path.join(h.dir, "project-b"), root: path.join(h.stateRoot, "b") }
    const hosted = createSessionHost({ ...h.deps, project: () => current.project, stateRoot: () => current.root }, { emit: (event) => events.push(event), tickMs: 3_600_000 })
    return {
      host: hosted,
      async switchToB() {
        await fs.mkdir(other.project, { recursive: true })
        current.project = other.project
        current.root = other.root
      },
      switchToA() {
        current.project = h.project
        current.root = path.join(h.stateRoot, "a")
      },
    }
  }

  test("after a project switch the old project's sessions are neither listed nor readable, and are again once it is current", async () => {
    const scoped = switchable()
    try {
      const { id } = await scoped.host.create(BODY)
      const proc = h.fake.procs.at(-1) as FakeProcess
      await scoped.host.prompt(id, { text: "secret of project A" })
      proc.emit(frames.messageEnd("m1", assistantMessage({ texts: ["answer in A"] })))
      finish(proc)
      expect((await scoped.host.list(10)).map((row) => row.id)).toEqual([id])

      await scoped.switchToB()
      expect(await scoped.host.list(10)).toEqual([])
      expect((await failure(scoped.host.turns(id, 10))).status).toBe(404)
      expect((await failure(scoped.host.final(id))).status).toBe(404)
      expect((await failure(scoped.host.steps(id))).status).toBe(404)
      expect((await failure(scoped.host.calls(id, 10))).status).toBe(404)
      expect((await failure(scoped.host.prompt(id, { text: "x" }))).status).toBe(404)
      expect(await scoped.host.wait(id, {})).toEqual({ status: "missing" })
      expect((await failure(scoped.host.create({ ...BODY, runId: "other", directory: h.project, reuse: id }))).status).toBe(404)

      scoped.switchToA()
      expect((await scoped.host.list(10)).map((row) => row.id)).toEqual([id])
      expect((await scoped.host.turns(id, 10)).map((turn) => turn.text)).toContain("answer in A")
    } finally {
      await scoped.host.close()
    }
  })
})

hosted("transient sessions", () => {
  test("a transient session writes no metadata or turns, is never listed or resumable, and its state directory is gone once it is disposed", async () => {
    const { id } = await open({ ...BODY, transient: true })
    await host.prompt(id, { text: "is this model alive?" })
    expect((await host.list(10)).map((row) => row.id)).not.toContain(id)
    expect(await fs.readdir(nodeDir("run1"))).not.toContain(".openflow-session.json")
    expect(await fs.readdir(nodeDir("run1"))).not.toContain(".openflow-turns.json")

    await host.dispose(id)
    expect(await fs.stat(nodeDir("run1")).then(() => true, () => false)).toBe(false)
    // The run directory this create made goes with it.
    expect(await fs.stat(path.dirname(nodeDir("run1"))).then(() => true, () => false)).toBe(false)
    expect(await host.list(10)).toEqual([])
    expect((await failure(host.prompt(id, { text: "again" }))).status).toBe(404)
    expect((await failure(host.create({ ...BODY, runId: "run2", reuse: id }))).status).toBe(404)
  })

  test("releasing the run removes a transient session's directory too, and a reaped one is ended rather than left unresumable", async () => {
    const reaped = await open({ ...BODY, runId: "r1", transient: true })
    await host.maintain(Date.now() + 24 * 60 * 60_000)
    expect(await host.wait(reaped.id, {})).toEqual({ status: "missing" })
    expect(await fs.stat(nodeDir("r1")).then(() => true, () => false)).toBe(false)

    await open({ ...BODY, runId: "r2", transient: true })
    expect(await host.releaseRun("r2")).toBe(1)
    expect(await fs.stat(nodeDir("r2")).then(() => true, () => false)).toBe(false)
  })

  test("a directory that already held a session is never removed by a transient one that shared it", async () => {
    const kept = await open({ ...BODY, runId: "shared" })
    await host.dispose(kept.id)
    const { id } = await open({ ...BODY, runId: "shared", transient: true })
    await host.dispose(id)
    expect(await fs.readdir(nodeDir("shared"))).toContain(".openflow-session.json")
  })

  test.each([["yes"], [1], [null]])("transient %p is a 400, and so is transient with reuse", async (value) => {
    expect((await failure(host.create({ ...BODY, transient: value }))).status).toBe(400)
    expect((await failure(host.create({ ...BODY, transient: true, reuse: "s_000000000000" }))).status).toBe(400)
    expect(h.fake.procs).toHaveLength(0)
  })
})
