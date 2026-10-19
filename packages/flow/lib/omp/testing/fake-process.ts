import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../../shared/omp"
import type { SwarmHost } from "../../../shared/swarm"
import type { BuildLaunch, LaunchInput, LaunchSpec, OmpExit, OmpFrame, OmpProcess, OmpRpcError, SpawnOmp } from "../rpc-types"
import type { EngineHostDeps } from "../session"

/**
 * An in-memory `OmpProcess` for the session layer's tests: scriptable command
 * responses, frames on demand, every sent frame and command recorded, and an
 * exit you trigger.
 */

export type Command = { type: string } & Record<string, unknown>

export type Responder = (command: Command) => unknown | Promise<unknown>

export interface FakeProcess extends OmpProcess {
  /** Every command, in order. */
  readonly commands: Command[]
  /** Every frame the host answered with (`extension_ui_response`, `host_tool_result`). */
  readonly sent: Array<Record<string, unknown>>
  /** Times `close()` was called and times `kill()` was. */
  closeCalls: number
  killCalls: number
  readonly exitedNow: boolean
  /** Deliver one frame to the host. */
  emit(frame: OmpFrame): void
  /** Script the data one command type answers with; a function may be async, and may throw `rpcError(...)`. Default `{}`. */
  on(type: string, responder: Responder): void
  on(type: string, data: unknown): void
  /** Exit as if the process died on its own. */
  exit(code?: number | null, stderrTail?: string, signal?: string | null): void
  /** Commands of one type, in order. */
  of(type: string): Command[]
}

export function rpcError(command: string, message: string, code?: string): OmpRpcError {
  return Object.assign(new Error(message), { rpc: { command, message, ...(code ? { code } : {}) } }) as OmpRpcError
}

export type FakeProcessOptions = {
  /** `ready` rejects with this message (the stderr tail) instead of resolving. */
  readyFails?: string
  pid?: number
}

export function createFakeProcess(options: FakeProcessOptions = {}): FakeProcess {
  const listeners = new Set<(frame: OmpFrame) => void>()
  const responders = new Map<string, Responder | unknown>()
  const commands: Command[] = []
  const sent: Array<Record<string, unknown>> = []
  const gone = Promise.withResolvers<OmpExit>()
  let exitedNow = false

  const ready = options.readyFails === undefined ? Promise.resolve({ protocolVersion: 2 }) : Promise.reject(new Error(options.readyFails))
  ready.catch(() => undefined)

  function exit(code: number | null = 0, stderrTail = "", signal: string | null = null) {
    if (exitedNow) return
    exitedNow = true
    gone.resolve({ code, signal, stderrTail })
  }

  const proc: FakeProcess = {
    pid: options.pid ?? 4242,
    ready,
    exited: gone.promise,
    commands,
    sent,
    closeCalls: 0,
    killCalls: 0,
    get exitedNow() {
      return exitedNow
    },

    async command<T = unknown>(command: Command): Promise<T> {
      if (exitedNow) throw rpcError(command.type, "omp exited before answering")
      commands.push(command)
      const responder = responders.get(command.type)
      const data = typeof responder === "function" ? await (responder as Responder)(command) : responder
      return (data === undefined ? {} : data) as T
    },

    onFrame(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    send(frame) {
      sent.push(frame)
    },

    async close() {
      proc.closeCalls++
      exit(0)
      await gone.promise
    },

    kill() {
      proc.killCalls++
      exit(null, "", "SIGKILL")
    },

    emit(frame) {
      for (const listener of [...listeners]) listener(frame)
    },

    on(type: string, responder: unknown) {
      responders.set(type, responder)
    },

    exit,

    of(type) {
      return commands.filter((command) => command.type === type)
    },
  }
  return proc
}

export type FakeSpawn = {
  spawn: SpawnOmp
  /** Every process spawned, in order. */
  procs: FakeProcess[]
  /** The spec each one was spawned with. */
  specs: LaunchSpec[]
  /** Called with each new process before `spawn` returns, to script it. */
  setup(configure: (proc: FakeProcess, index: number) => void): void
  /** Options for the next spawns (e.g. `readyFails`). */
  next(options: FakeProcessOptions): void
}

export function createFakeSpawn(): FakeSpawn {
  const procs: FakeProcess[] = []
  const specs: LaunchSpec[] = []
  let configure: (proc: FakeProcess, index: number) => void = () => undefined
  let pending: FakeProcessOptions | undefined
  return {
    procs,
    specs,
    setup(next) {
      configure = next
    },
    next(options) {
      pending = options
    },
    spawn(spec) {
      const proc = createFakeProcess(pending)
      pending = undefined
      procs.push(proc)
      specs.push(spec)
      configure(proc, procs.length - 1)
      return proc
    },
  }
}

/* ---------------------------------------------------------------- harness */

export type Harness = {
  /** Temp root; removed by `cleanup()`. */
  dir: string
  project: string
  stateRoot: string
  settings: OmpSettings
  fake: FakeSpawn
  /** Every `LaunchInput` the session layer built a launch from. */
  launches: LaunchInput[]
  launch: BuildLaunch
  deps: EngineHostDeps
  cleanup(): Promise<void>
}

/**
 * Temp project and state directories, a real executable that answers
 * `--version` (so `checkOmp` runs for real), and a launch builder that records
 * its input. `binary: false` points settings at a path that does not exist.
 */
export async function createHarness(options: { binary?: boolean; swarm?: SwarmHost; idleReapMs?: number } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-omp-test-"))
  const project = path.join(dir, "project")
  const stateRoot = path.join(dir, "state")
  await fs.mkdir(project)
  const binary = path.join(dir, "omp")
  if (options.binary !== false) {
    await fs.writeFile(binary, "#!/bin/sh\necho omp/99.0.0\n")
    await fs.chmod(binary, 0o755)
  }
  const settings: OmpSettings = { ...DEFAULT_OMP_SETTINGS, binary }
  const fake = createFakeSpawn()
  const launches: LaunchInput[] = []
  const launch: BuildLaunch = (input) => {
    launches.push(input)
    return { argv: [input.binary, "--mode", "rpc-ui"], env: {}, cwd: input.session.directory, files: [] }
  }
  return {
    dir,
    project,
    stateRoot,
    settings,
    fake,
    launches,
    launch,
    deps: {
      project: () => project,
      stateRoot: () => stateRoot,
      settings: async () => settings,
      spawn: fake.spawn,
      launch,
      env: { PATH: process.env.PATH },
      ...(options.swarm ? { swarm: options.swarm } : {}),
      ...(options.idleReapMs === undefined ? {} : { idleReapMs: options.idleReapMs }),
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/* ----------------------------------------------------------------- frames */

export const USAGE = { input: 100, output: 20, cacheRead: 5, cacheWrite: 7, totalTokens: 132, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } }

export type AssistantOptions = {
  texts?: string[]
  tools?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  usage?: typeof USAGE
  stopReason?: string
  errorMessage?: string
  errorStatus?: number
}

/** An omp `AssistantMessage` as it arrives in `message_end`. */
export function assistantMessage(options: AssistantOptions = {}) {
  return {
    role: "assistant",
    content: [
      ...(options.texts ?? []).map((text) => ({ type: "text", text })),
      ...(options.tools ?? []).map((tool) => ({ type: "toolCall", ...tool })),
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-test",
    usage: options.usage ?? USAGE,
    stopReason: options.stopReason ?? "stop",
    timestamp: 1,
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    ...(options.errorStatus ? { errorStatus: options.errorStatus } : {}),
  }
}

/** Frames as omp writes them with `messageUpdates: "delta"`. */
export const frames = {
  agentStart: (): OmpFrame => ({ type: "agent_start" }),
  messageStart: (messageId: string, role = "assistant"): OmpFrame => ({ type: "message_start", messageId, message: { role } }),
  textDelta: (messageId: string, contentIndex: number, delta: string): OmpFrame => ({
    type: "message_update",
    messageId,
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex, delta },
  }),
  update: (messageId: string, assistantMessageEvent: Record<string, unknown>): OmpFrame => ({
    type: "message_update",
    messageId,
    message: { role: "assistant" },
    assistantMessageEvent,
  }),
  messageEnd: (messageId: string, message: Record<string, unknown>): OmpFrame => ({ type: "message_end", messageId, message }),
  userMessage: (messageId: string, text: string): OmpFrame => ({ type: "message_end", messageId, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } }),
  toolStart: (toolCallId: string, toolName: string, args: unknown): OmpFrame => ({ type: "tool_execution_start", toolCallId, toolName, args }),
  toolEnd: (toolCallId: string, toolName: string, text: string, isError = false): OmpFrame => ({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { content: [{ type: "text", text }] },
    isError,
  }),
  promptResult: (id: string, status: "completed" | "aborted" | "error", extra: Record<string, unknown> = {}): OmpFrame => ({
    type: "prompt_result",
    id,
    agentInvoked: true,
    status,
    sessionSettled: false,
    ...extra,
  }),
  settled: (): OmpFrame => ({ type: "session_settled" }),
  approval: (id: string, title: string, options: string[] = ["Approve", "Approve bash for this session", "Deny"]): OmpFrame => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options,
  }),
}
