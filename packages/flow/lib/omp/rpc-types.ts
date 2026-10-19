/**
 * The seam between the Omp RPC core (`lib/omp/rpc.ts`, `launch.ts`) and the
 * session layer (`lib/omp/session.ts`, `events.ts`, `routes.ts`). The session
 * layer codes against `OmpProcess` and is tested with a fake one; the core
 * implements it over a real `omp --mode rpc-ui` child. Types only.
 *
 * Protocol facts both sides rely on (verified against omp 18.12.2, see
 * `.planning/phases/01-discovery-engine-port/discovery/04-omp-rpc-cli.md`):
 *  - JSONL on stdio, one object per line, a `ready` frame first.
 *  - `negotiate_protocol { protocolVersion: 2 }` makes oversized objects arrive as
 *    `rpc_chunk { chunkId, index, count, byteLength, data }` frames (base64 UTF-8
 *    slices of one JSON object). The core reassembles them; the session layer never
 *    sees a chunk.
 *  - Commands carry an `id`; the response is `{ id, type: "response", command,
 *    success, data? | error, code? }`. `prompt` is acknowledged on admission and
 *    completes later with a `prompt_result` frame carrying the same `id`.
 *  - Closing stdin makes omp finish accepted work, dispose and exit 0.
 */

/** Any frame that is not a command response: events, `extension_ui_request`, `host_tool_call`, `prompt_result`, `session_settled`, `notice`, ... */
export type OmpFrame = { type: string; [key: string]: unknown }

export type RpcErrorInfo = {
  command: string
  message: string
  /** omp's machine code when it sent one (`session_busy`, `stale_cursor`, ...). */
  code?: string
}

/** A command that came back `success: false`, timed out, or lost its process. Carries `rpc`. */
export type OmpRpcError = Error & { rpc: RpcErrorInfo }

/** What to run. Produced by `buildLaunch` (`lib/omp/launch.ts`); consumed by `spawnOmp`. */
export type LaunchSpec = {
  /** Absolute binary first, then flags. Never a shell string. */
  argv: string[]
  /** Complete child environment (already filtered); nothing is inherited implicitly. */
  env: Record<string, string>
  cwd: string
  /** Files to write before spawning (role prompt, settings overlay), absolute paths, written 0600. */
  files: Array<{ path: string; content: string }>
}

export type OmpExit = { code: number | null; signal: string | null; stderrTail: string }

export interface OmpProcess {
  readonly pid: number | undefined
  /** Resolves after the `ready` frame and protocol negotiation. Rejects with the stderr tail if the process exits first. */
  readonly ready: Promise<{ protocolVersion: number }>
  /** Resolves when the process has exited, for any reason. Never rejects. */
  readonly exited: Promise<OmpExit>
  /**
   * Send one command and resolve its response `data`. Rejects with an
   * `OmpRpcError` on `success: false`, on timeout, on abort, or when the process
   * exits first. Do not use for `prompt` completion: wait for its `prompt_result`
   * frame through `onFrame`.
   */
  command<T = unknown>(
    command: { type: string } & Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>
  /** Every frame that is not a response, in stdout order. Returns the unsubscribe function. */
  onFrame(listener: (frame: OmpFrame) => void): () => void
  /** Answer an `extension_ui_request` or a `host_tool_call`; fire and forget (no response frame exists). */
  send(frame: Record<string, unknown>): void
  /**
   * Graceful stop: close stdin, wait up to `graceMs` for exit, then SIGTERM the
   * whole process group, then SIGKILL after `killMs`. Idempotent; resolves once
   * the process is gone.
   */
  close(options?: { graceMs?: number; killMs?: number }): Promise<void>
  /** Immediate SIGKILL of the whole process group. Idempotent. */
  kill(): void
}

/** The factory the session layer receives; tests pass a fake. */
export type SpawnOmp = (spec: LaunchSpec) => OmpProcess
