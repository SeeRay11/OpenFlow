import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { rpcError, spawnOmp } from "./rpc"
import type { LaunchSpec, OmpFrame, OmpProcess, OmpRpcError } from "./rpc-types"

const STUB = path.join(import.meta.dir, "testing", "stub-omp.ts")

const spawned: OmpProcess[] = []
const dirs: string[] = []
const grandchildren: number[] = []

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-rpc-test-"))
  dirs.push(dir)
  return dir
}

function launch(env: Record<string, string> = {}, extra: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    argv: [process.execPath, STUB, "--mode", "rpc-ui"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    cwd: scratch(),
    files: [],
    ...extra,
  }
}

function start(env: Record<string, string> = {}, extra: Partial<LaunchSpec> = {}) {
  const proc = spawnOmp(launch(env, extra))
  spawned.push(proc)
  return proc
}

function collect(proc: OmpProcess) {
  const frames: OmpFrame[] = []
  proc.onFrame((frame) => frames.push(frame))
  return frames
}

function frameOfType(proc: OmpProcess, type: string) {
  const box = Promise.withResolvers<OmpFrame>()
  const off = proc.onFrame((frame) => {
    if (frame.type !== type) return
    off()
    box.resolve(frame)
  })
  return box.promise
}

async function rejection(promise: Promise<unknown>): Promise<OmpRpcError> {
  try {
    await promise
  } catch (error) {
    return error as OmpRpcError
  }
  throw new Error("expected a rejection")
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The OS announces no event when an unrelated pid disappears, so this one wait polls kill(pid, 0).
async function gone(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(25)
  }
  return !alive(pid)
}

afterEach(async () => {
  for (const proc of spawned.splice(0)) {
    proc.kill()
    await proc.exited
  }
  for (const pid of grandchildren.splice(0)) {
    if (alive(pid)) process.kill(pid, "SIGKILL")
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("spawnOmp: startup", () => {
  test("ready resolves after the ready frame and a v2 negotiation", async () => {
    const proc = start()
    const frames = collect(proc)
    expect(await proc.ready).toEqual({ protocolVersion: 2 })
    expect(proc.pid).toBeGreaterThan(0)
    expect(frames[0]?.type).toBe("ready")
  })

  test("a v1-only omp resolves ready at v1 and the limit is announced once", async () => {
    const proc = start({ STUB_OMP_V1_ONLY: "1" })
    const frames = collect(proc)
    expect(await proc.ready).toEqual({ protocolVersion: 1 })
    expect(frames.filter((frame) => frame.type === "flow_protocol_v1")).toHaveLength(1)
  })

  test("the process exiting before ready rejects with the last stderr line", async () => {
    const proc = start({ STUB_OMP_FAIL: "warming up\nerror: unknown flag --nope" })
    const error = await rejection(proc.ready)
    expect(error.message.endsWith("error: unknown flag --nope")).toBe(true)
    const exit = await proc.exited
    expect(exit.code).toBe(3)
    expect(exit.stderrTail).toContain("warming up")
  })

  test("a binary that cannot be spawned fails ready and still resolves exited", async () => {
    const proc = spawnOmp({ ...launch(), argv: [path.join(scratch(), "no-such-omp")] })
    spawned.push(proc)
    expect((await rejection(proc.ready)).message).toContain("ENOENT")
    const exit = await proc.exited
    expect(exit.code).toBeNull()
    expect(exit.stderrTail).toContain("ENOENT")
  })

  test("files are written first, parents created, mode 0600", async () => {
    const dir = scratch()
    const file = path.join(dir, "nested", "deeper", "role.md")
    const existing = path.join(dir, "overlay.yml")
    writeFileSync(existing, "old", { mode: 0o644 })
    const proc = start({}, { files: [{ path: file, content: "role text" }, { path: existing, content: "{}" }] })
    await proc.ready
    expect(readFileSync(file, "utf8")).toBe("role text")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(existing, "utf8")).toBe("{}")
    expect(statSync(existing).mode & 0o777).toBe(0o600)
  })

  test("a file that cannot be written fails the process instead of throwing", async () => {
    const blocker = path.join(scratch(), "blocker")
    writeFileSync(blocker, "a file, not a directory")
    const proc = start({}, { files: [{ path: path.join(blocker, "child.md"), content: "x" }] })
    expect((await rejection(proc.ready)).message).toContain("omp exited before it was ready")
    expect((await proc.exited).stderrTail).toMatch(/EEXIST|ENOTDIR|not a directory/i)
  })

  test("many spawns add no exit listeners", async () => {
    const first = start()
    await first.ready
    const before = process.listenerCount("exit")
    for (let index = 0; index < 3; index++) await start().ready
    expect(process.listenerCount("exit")).toBe(before)
  })
})

describe("spawnOmp: commands", () => {
  test("ids are c1, c2, ... and the response data comes back", async () => {
    const proc = start()
    await proc.ready // negotiation used c1
    const first = await proc.command<{ requestId: string; sessionId: string }>({ type: "get_state" })
    const second = await proc.command<{ requestId: string }>({ type: "get_state" })
    expect(first.requestId).toBe("c2")
    expect(first.sessionId).toBe("stub-session")
    expect(second.requestId).toBe("c3")
  })

  test("success:false rejects with rpc info, code included", async () => {
    const proc = start()
    await proc.ready
    const error = await rejection(proc.command({ type: "stub_fail", error: "no such thing", code: "stale_cursor" }))
    expect(error.message).toBe("no such thing")
    expect(error.rpc).toEqual({ command: "stub_fail", message: "no such thing", code: "stale_cursor" })
    const unknown = await rejection(proc.command({ type: "nope" }))
    expect(unknown.rpc).toEqual({ command: "nope", message: "Unknown command: nope" })
  })

  test("a command that never answers times out, and the process keeps working", async () => {
    const proc = start()
    await proc.ready
    const error = await rejection(proc.command({ type: "stub_hang" }, { timeoutMs: 50 }))
    expect(error.rpc.code).toBe("timeout")
    expect(error.rpc.command).toBe("stub_hang")
    expect((await proc.command<{ sessionId: string }>({ type: "get_state" })).sessionId).toBe("stub-session")
  })

  test("an abort signal rejects with code aborted; an already aborted one never sends", async () => {
    const proc = start()
    await proc.ready
    const controller = new AbortController()
    const pending = rejection(proc.command({ type: "stub_hang" }, { signal: controller.signal }))
    controller.abort()
    expect((await pending).rpc.code).toBe("aborted")

    const aborted = AbortSignal.abort()
    // stub_exit would end the process if it were sent.
    expect((await rejection(proc.command({ type: "stub_exit", code: 9 }, { signal: aborted }))).rpc.code).toBe("aborted")
    expect((await proc.command<{ sessionId: string }>({ type: "get_state" })).sessionId).toBe("stub-session")
  })

  test("the process exiting mid-command rejects it with code exited", async () => {
    const proc = start()
    await proc.ready
    const error = await rejection(proc.command({ type: "stub_exit", code: 7 }))
    expect(error.rpc.code).toBe("exited")
    expect(error.message).toContain("code 7")
    expect((await proc.exited).code).toBe(7)
  })

  test("commands after the exit reject at once", async () => {
    const proc = start()
    await proc.ready
    await proc.close()
    expect((await rejection(proc.command({ type: "get_state" }))).rpc.code).toBe("exited")
  })

  test("a late response to a timed out command is ignored", async () => {
    const proc = start()
    await proc.ready
    const frames = collect(proc)
    const error = await rejection(proc.command({ type: "stub_hang" }, { timeoutMs: 20 }))
    expect(error.rpc.code).toBe("timeout")
    await proc.command({ type: "get_state" })
    expect(frames).toEqual([])
  })

  test("a response larger than the frame limit arrives reassembled, multibyte intact", async () => {
    const proc = start({ STUB_OMP_MAX_FRAME_BYTES: "300" })
    expect(await proc.ready).toEqual({ protocolVersion: 2 })
    const frames = collect(proc)
    const data = await proc.command<{ text: string }>({ type: "stub_big", bytes: 4_000, char: "é" })
    expect(data.text).toBe("é".repeat(4_000))
    // Callers never see a chunk.
    expect(frames.filter((frame) => frame.type === "rpc_chunk")).toEqual([])
  })

  test("a large model catalog survives the default 1 MiB limit", async () => {
    const proc = start({ STUB_OMP_MODELS: "40", STUB_OMP_MODEL_PAD: "40000" })
    await proc.ready
    const data = await proc.command<{ models: Array<{ id: string; pad: string }> }>({ type: "get_available_models" })
    expect(data.models).toHaveLength(40)
    expect(data.models[39].pad).toHaveLength(40_000)
  })

  test("a reassembled frame over the advertised limit is reported and its command can be abandoned", async () => {
    const proc = start({ STUB_OMP_MAX_FRAME_BYTES: "300", STUB_OMP_MAX_REASSEMBLED: "1000" })
    await proc.ready
    const reported = frameOfType(proc, "parse_error")
    const controller = new AbortController()
    const pending = rejection(proc.command({ type: "stub_big", bytes: 5_000 }, { signal: controller.signal }))
    expect(await reported).toMatchObject({ type: "parse_error", reason: expect.stringContaining("oversize") })
    controller.abort()
    expect((await pending).rpc.code).toBe("aborted")
  })

  test("an oversized response on a v1 connection is an ordinary failure", async () => {
    const proc = start({ STUB_OMP_V1_ONLY: "1", STUB_OMP_MAX_FRAME_BYTES: "300" })
    await proc.ready
    const error = await rejection(proc.command({ type: "stub_big", bytes: 4_000 }))
    expect(error.message).toBe("RPC response exceeded the transport limit")
  })
})

describe("spawnOmp: frames", () => {
  test("non-response frames reach listeners in stdout order, interleaved parse errors included", async () => {
    const proc = start()
    await proc.ready
    const frames = collect(proc)
    await proc.command({ type: "stub_emit", frames: [{ type: "a", n: 1 }, { type: "b", n: 2 }, { type: "c", n: 3 }] })
    expect(frames.map((frame) => frame.type)).toEqual(["a", "b", "c"])
  })

  test("a throwing listener neither starves the others nor stops the reader", async () => {
    const proc = start()
    await proc.ready
    proc.onFrame(() => {
      throw new Error("listener bug")
    })
    const frames = collect(proc)
    await proc.command({ type: "stub_emit", frames: [{ type: "a" }, { type: "b" }] })
    await proc.command({ type: "stub_emit", frames: [{ type: "c" }] })
    expect(frames.map((frame) => frame.type)).toEqual(["a", "b", "c"])
  })

  test("unsubscribing stops delivery", async () => {
    const proc = start()
    await proc.ready
    const seen: string[] = []
    const off = proc.onFrame((frame) => seen.push(frame.type))
    await proc.command({ type: "stub_emit", frames: [{ type: "a" }] })
    off()
    await proc.command({ type: "stub_emit", frames: [{ type: "b" }] })
    expect(seen).toEqual(["a"])
  })

  test("send writes one JSON line the process receives, in order with commands", async () => {
    const log = path.join(scratch(), "log.jsonl")
    const proc = start({ STUB_OMP_LOG: log })
    await proc.ready
    proc.send({ type: "extension_ui_response", id: "ui-1", value: "Approve" })
    proc.send({ type: "host_tool_result", id: "t-1", result: { ok: true } })
    // The ordered round trip proves the stub read both lines before it answered.
    await proc.command({ type: "get_state" })
    const lines = readFileSync(log, "utf8").trim().split("\n").map((text) => JSON.parse(text))
    expect(lines).toEqual([
      { type: "extension_ui_response", id: "ui-1", value: "Approve" },
      { type: "host_tool_result", id: "t-1", result: { ok: true } },
    ])
  })

  test("send after close is ignored, not thrown", async () => {
    const proc = start()
    await proc.ready
    await proc.close()
    expect(() => proc.send({ type: "extension_ui_response", id: "late" })).not.toThrow()
  })

  test("a prompt is acknowledged, then its script plays out with the prompt id substituted", async () => {
    const dir = scratch()
    const script = path.join(dir, "script.json")
    writeFileSync(
      script,
      JSON.stringify([
        { type: "agent_start" },
        { delayMs: 5 },
        { type: "message_update", text: "hi" },
        { type: "prompt_result", id: "$promptId", agentInvoked: true, status: "completed", sessionSettled: true },
        { type: "session_settled" },
      ]),
    )
    const proc = start({ STUB_OMP_SCRIPT: script })
    await proc.ready
    const frames = collect(proc)
    const settled = frameOfType(proc, "session_settled")
    await proc.command({ type: "prompt", message: "go" })
    await settled
    expect(frames.map((frame) => frame.type)).toEqual(["agent_start", "message_update", "prompt_result", "session_settled"])
    expect(frames[2]).toMatchObject({ id: "c2", status: "completed" })
  })

  test("a script can wait for the host's answer to an approval request", async () => {
    const dir = scratch()
    const script = path.join(dir, "script.json")
    const log = path.join(dir, "log.jsonl")
    writeFileSync(
      script,
      JSON.stringify([
        { type: "extension_ui_request", id: "ui-9", method: "select", title: "Allow tool: bash" },
        { waitFor: "extension_ui_response" },
        { type: "prompt_result", id: "$promptId", agentInvoked: true, status: "completed", sessionSettled: true },
        { type: "session_settled" },
      ]),
    )
    const proc = start({ STUB_OMP_SCRIPT: script, STUB_OMP_LOG: log })
    await proc.ready
    const request = frameOfType(proc, "extension_ui_request")
    const settled = frameOfType(proc, "session_settled")
    await proc.command({ type: "prompt", message: "go" })
    const asked = await request
    proc.send({ type: "extension_ui_response", id: asked.id, value: "Approve" })
    await settled
    expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual({ type: "extension_ui_response", id: "ui-9", value: "Approve" })
  })

  test("stderr keeps a bounded tail", async () => {
    const proc = start()
    await proc.ready
    await proc.command({ type: "stub_stderr", text: `${"x".repeat(30_000)}\nlast line\n` })
    await proc.close()
    const { stderrTail } = await proc.exited
    expect(stderrTail.length).toBeLessThanOrEqual(8 * 1024)
    expect(stderrTail.endsWith("last line")).toBe(true)
  })
})

describe("spawnOmp: shutdown", () => {
  test("close ends stdin, the process exits 0, and a second close is the same promise", async () => {
    const proc = start()
    await proc.ready
    const first = proc.close()
    expect(proc.close()).toBe(first)
    await first
    expect(await proc.exited).toMatchObject({ code: 0, signal: null })
  })

  test("close keeps reading stdout: a response in flight when stdin closes still arrives", async () => {
    const proc = start()
    await proc.ready
    const big = proc.command<{ text: string }>({ type: "stub_big", bytes: 3_000_000 })
    const closing = proc.close()
    expect((await big).text).toHaveLength(3_000_000)
    await closing
    expect((await proc.exited).code).toBe(0)
  })

  test("an omp that ignores EOF is sent SIGTERM", async () => {
    const proc = start({ STUB_OMP_IGNORE_EOF: "1" })
    await proc.ready
    await proc.close({ graceMs: 100, killMs: 3_000 })
    expect(await proc.exited).toMatchObject({ code: null, signal: "SIGTERM" })
  })

  test("an omp that ignores EOF and SIGTERM is sent SIGKILL", async () => {
    const proc = start({ STUB_OMP_IGNORE_EOF: "1", STUB_OMP_IGNORE_TERM: "1" })
    await proc.ready
    await proc.close({ graceMs: 50, killMs: 100 })
    expect(await proc.exited).toMatchObject({ code: null, signal: "SIGKILL" })
  })

  test("kill SIGKILLs the whole group: the grandchild is gone, and kill is idempotent", async () => {
    const proc = start({ STUB_OMP_SPAWN_CHILD: "1" })
    const announced = frameOfType(proc, "stub_child")
    await proc.ready
    const pid = Number((await announced).pid)
    grandchildren.push(pid)
    expect(alive(pid)).toBe(true)
    proc.kill()
    proc.kill()
    expect(await proc.exited).toMatchObject({ signal: "SIGKILL" })
    expect(await gone(pid)).toBe(true)
  })

  test("a graceful close also sweeps what the process left running", async () => {
    const proc = start({ STUB_OMP_SPAWN_CHILD: "1" })
    const announced = frameOfType(proc, "stub_child")
    await proc.ready
    const pid = Number((await announced).pid)
    grandchildren.push(pid)
    await proc.close()
    expect((await proc.exited).code).toBe(0)
    expect(await gone(pid)).toBe(true)
  })

  test("a crash leaves no orphan either", async () => {
    const proc = start({ STUB_OMP_SPAWN_CHILD: "1" })
    const announced = frameOfType(proc, "stub_child")
    await proc.ready
    const pid = Number((await announced).pid)
    grandchildren.push(pid)
    await rejection(proc.command({ type: "stub_exit", code: 1 }))
    expect(await gone(pid)).toBe(true)
  })
})

describe("rpcError", () => {
  test("carries the command, message and optional code", () => {
    const error = rpcError("get_state", "boom", "session_busy")
    expect(error).toBeInstanceOf(Error)
    expect(error.rpc).toEqual({ command: "get_state", message: "boom", code: "session_busy" })
    expect(rpcError("x", "y").rpc).toEqual({ command: "x", message: "y" })
  })
})
