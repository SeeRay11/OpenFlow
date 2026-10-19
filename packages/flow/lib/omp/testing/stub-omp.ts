/**
 * A runnable stand-in for `omp --mode rpc-ui`, for tests that need a real child
 * process without a model: `[process.execPath, <this file>, ...<omp flags, ignored>]`.
 * Dependency-free on purpose (node: APIs only); other test files import its
 * path, never its internals.
 *
 * Behaviour
 *  - writes `ready` first (`supportedProtocolVersions` [1, 2]; [1] with STUB_OMP_V1_ONLY=1);
 *  - `negotiate_protocol` switches oversized stdout frames (over STUB_OMP_MAX_FRAME_BYTES, default
 *    1 MiB) to `rpc_chunk` runs; before negotiation an oversized response is `success:false`;
 *  - answers `get_state` (data carries `requestId`, `argv`, the flags the stub was started with, `childPid`
 *    and `env`, the names of the environment variables it received, each mapped to `true`), `get_available_models` (STUB_OMP_MODELS models, default 2, each padded with
 *    STUB_OMP_MODEL_PAD bytes), `set_host_tools`, `set_ask_dialog`, `set_event_filter`,
 *    `set_subagent_subscription`, `set_auto_retry`, `abort`; anything else is
 *    `success:false "Unknown command: <type>"`;
 *  - `prompt`: acks with `success:true`, then plays the script;
 *  - test-only commands: `stub_emit { frames }` (emit the frames, then ack), `stub_big { bytes, char? }`
 *    (respond with a string of that many `char`s), `stub_fail { error, code? }` (answer success:false),
 *    `stub_hang` (never answer), `stub_exit { code? }` (exit at once without answering),
 *    `stub_stderr { text }` (write to stderr, then ack);
 *  - frames that expect no response (`extension_ui_response`, `host_tool_result`, `host_tool_update`,
 *    `host_uri_result`, `cancel`) are appended as one JSON line each to the file named by STUB_OMP_LOG;
 *  - stdin EOF ends the process with exit 0 once stdout is flushed.
 *
 * Script (JSON file named by STUB_OMP_SCRIPT, read at each `prompt`): an ordered array whose items are
 *  - a frame object, written to stdout; every string value equal to "$promptId" becomes the prompt's id;
 *  - `{ "delayMs": n }`: wait n ms;
 *  - `{ "waitFor": "<frame type>" }`: pause until the host has sent a frame of that type (the
 *    approval and host-tool round trips);
 *  - `{ "exit": code }`: die mid-turn.
 * It should end with `prompt_result` and `session_settled` frames, as omp does. `abort` stops a
 * playing script and writes `prompt_result` (status "aborted") plus `session_settled` instead.
 *
 * Environment switches
 *  - STUB_OMP_SPAWN_CHILD=1: spawn a `sleep 300` grandchild in the stub's process group and announce
 *    it as `{ type: "stub_child", pid }` right after `ready` (no-orphan tests);
 *  - STUB_OMP_IGNORE_EOF=1: keep running after stdin EOF (escalation tests); with
 *    STUB_OMP_IGNORE_TERM=1 SIGTERM is ignored too, so only SIGKILL ends it;
 *  - STUB_OMP_FAIL=<message>: write the message to stderr and exit 3 before `ready`;
 *  - STUB_OMP_MAX_REASSEMBLED=<bytes>: the `maxReassembledFrameBytes` the ready frame advertises.
 */

import { spawn } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

const env = process.env
const maxFrameBytes = Number(env.STUB_OMP_MAX_FRAME_BYTES ?? 1_048_576)
const v1Only = env.STUB_OMP_V1_ONLY === "1"
const LOGGED = ["extension_ui_response", "host_tool_result", "host_tool_update", "host_uri_result", "cancel"]

type Frame = { type: string; [key: string]: unknown }

let negotiated = false
let chunkSequence = 0
let playing: { id: string; abort: () => void } | undefined
const received: Frame[] = []
const waiters: Array<{ type: string; resolve: () => void }> = []

function line(frame: Frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function out(frame: Frame) {
  const text = JSON.stringify(frame)
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxFrameBytes) {
    process.stdout.write(`${text}\n`)
    return
  }
  if (!negotiated) {
    if (frame.type !== "response") {
      process.stdout.write(`${text}\n`)
      return
    }
    line({ id: frame.id, type: "response", command: frame.command, success: false, error: "RPC response exceeded the transport limit" })
    return
  }
  const chunkId = `rpc-${++chunkSequence}`
  // Raw bytes, not characters: a multibyte character may straddle two chunks, as it does in omp.
  const slice = Math.max(1, Math.floor(maxFrameBytes / 2))
  const count = Math.ceil(bytes.length / slice)
  for (let index = 0; index < count; index++) {
    const data = bytes.subarray(index * slice, (index + 1) * slice).toString("base64")
    line({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data })
  }
}

function respond(id: unknown, command: string, data?: unknown) {
  out({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) })
}

function refuse(id: unknown, command: string, error: string, code?: string) {
  out({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) })
}

function sleep(ms: number) {
  const box = Promise.withResolvers<void>()
  setTimeout(box.resolve, ms)
  return box.promise
}

function substitute(value: unknown, promptId: unknown): unknown {
  if (value === "$promptId") return promptId
  if (Array.isArray(value)) return value.map((item) => substitute(item, promptId))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, promptId)]))
  }
  return value
}

async function play(id: unknown) {
  const path = env.STUB_OMP_SCRIPT
  const script: Array<Record<string, unknown>> = path ? JSON.parse(readFileSync(path, "utf8")) : []
  let aborted = false
  const key = String(id)
  playing = { id: key, abort: () => (aborted = true) }
  for (const item of script) {
    if (aborted) break
    if (typeof item.delayMs === "number") {
      await sleep(item.delayMs)
      continue
    }
    if (typeof item.exit === "number") process.exit(item.exit)
    if (typeof item.waitFor === "string") {
      const type = item.waitFor
      if (!received.some((frame) => frame.type === type)) {
        const box = Promise.withResolvers<void>()
        waiters.push({ type, resolve: box.resolve })
        await box.promise
      }
      continue
    }
    out(substitute(item, id) as Frame)
  }
  if (playing?.id === key) playing = undefined
  if (aborted) {
    out({ type: "prompt_result", id, agentInvoked: true, status: "aborted", sessionSettled: true })
    out({ type: "session_settled" })
  }
}

let grandchild: number | undefined

function handle(frame: Frame) {
  received.push(frame)
  for (const waiter of waiters.splice(0)) {
    if (waiter.type === frame.type) waiter.resolve()
    else waiters.push(waiter)
  }
  if (LOGGED.includes(frame.type)) {
    if (env.STUB_OMP_LOG) appendFileSync(env.STUB_OMP_LOG, `${JSON.stringify(frame)}\n`)
    return
  }

  const { id, type } = frame
  switch (type) {
    case "negotiate_protocol":
      if (v1Only || frame.protocolVersion !== 2) {
        refuse(id, type, `Unsupported protocol version: ${String(frame.protocolVersion)}`)
        return
      }
      respond(id, type, { protocolVersion: 2 })
      negotiated = true
      return
    case "get_state":
      respond(id, type, {
        requestId: id,
        sessionId: "stub-session",
        model: { provider: "stub", id: "stub-1" },
        isStreaming: playing !== undefined,
        isSettled: playing === undefined,
        argv: process.argv.slice(2),
        childPid: grandchild,
        // Names only, one boolean each: tests prove which variables reached the child without a value ever leaving it.
        env: Object.fromEntries(Object.keys(env).map((name) => [name, true])),
      })
      return
    case "get_available_models": {
      const count = Number(env.STUB_OMP_MODELS ?? 2)
      const pad = "x".repeat(Number(env.STUB_OMP_MODEL_PAD ?? 0))
      const models = Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, name: `Model é${index}`, provider: "stub", pad }))
      respond(id, type, { models })
      return
    }
    case "set_host_tools":
    case "set_ask_dialog":
    case "set_event_filter":
    case "set_subagent_subscription":
    case "set_auto_retry":
      respond(id, type, type === "set_auto_retry" ? undefined : { ok: true })
      return
    case "abort":
      respond(id, type)
      playing?.abort()
      return
    case "prompt":
      if (playing) {
        refuse(id, type, "Agent is already processing a prompt", "busy")
        return
      }
      respond(id, type)
      void play(id)
      return
    case "stub_emit":
      for (const item of Array.isArray(frame.frames) ? frame.frames : []) out(item as Frame)
      respond(id, type)
      return
    case "stub_big":
      respond(id, type, { text: String(frame.char ?? "a").repeat(Number(frame.bytes ?? 0)) })
      return
    case "stub_stderr":
      process.stderr.write(String(frame.text ?? ""))
      respond(id, type)
      return
    case "stub_fail":
      refuse(id, type, String(frame.error ?? "failed"), typeof frame.code === "string" ? frame.code : undefined)
      return
    case "stub_hang":
      return
    case "stub_exit":
      process.exit(typeof frame.code === "number" ? frame.code : 0)
      return
    default:
      refuse(id, String(type), `Unknown command: ${String(type)}`)
  }
}

if (env.STUB_OMP_FAIL) {
  process.stderr.write(`${env.STUB_OMP_FAIL}\n`)
  process.exit(3)
}
if (env.STUB_OMP_IGNORE_TERM === "1") process.on("SIGTERM", () => {})

line({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: v1Only ? [1] : [1, 2],
  maxFrameBytes,
  maxReassembledFrameBytes: Number(env.STUB_OMP_MAX_REASSEMBLED ?? 67_108_864),
})
if (env.STUB_OMP_SPAWN_CHILD === "1") {
  const child = spawn("sleep", ["300"], { stdio: "ignore" })
  // Unreferenced: the stub's exit must not wait for it, only the group sweep may end it.
  child.unref()
  grandchild = child.pid
  line({ type: "stub_child", pid: child.pid })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (text: string) => {
  buffer += text
  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (raw.trim().length === 0) continue
    try {
      handle(JSON.parse(raw))
    } catch {
      refuse(undefined, "parse", "Failed to parse command")
    }
  }
})
process.stdin.on("end", () => {
  if (env.STUB_OMP_IGNORE_EOF === "1") {
    // The event loop would drain and exit 0 on its own; hold it open.
    setInterval(() => {}, 1 << 30)
    return
  }
  // No process.exit: a pipe write may still be in flight, and omp exits only once its stdout is read.
  process.exitCode = 0
})
