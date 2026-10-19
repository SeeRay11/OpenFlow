import path from "node:path"
import type { OmpSettings } from "../../shared/omp"
import type { UpliftRequest, UpliftResult } from "../../shared/uplift"
import type { HostHandler } from "../host/respond"
import { createPlannerPool, KILL_GRACE_MS, locate, plannerEnv, writeControl } from "./planner"
import { interpret, isUplifted, loadStored, redact, saveStored, sessionIdFor } from "./result"
import { createRoutes } from "./routes"

/**
 * Prompt Uplift as a host module: one headless claude-ultrathink planner
 * process per card turn, interpreted into an `UpliftResult`. See
 * `shared/uplift.ts` for how the engine consumes it.
 */

const DEFAULT_CONCURRENCY = 2

export type UpliftDeps = {
  project(): string
  /** Root of OpenFlow's own state; everything this module writes lives under `<stateRoot>/uplift`. */
  stateRoot(): string
  settings(): Promise<OmpSettings>
  env?: NodeJS.ProcessEnv
  /** Planners running at once; the rest queue. Default 2. */
  maxConcurrent?: number
  /** Test seam; default `<root>/bin/run-bun hooks/engine.ts` run from the root. */
  command?: (root: string) => { argv: string[]; cwd: string }
  /** SIGTERM to SIGKILL delay for a planner group. Default 5 s. */
  killGraceMs?: number
}

export type UpliftModule = {
  handle: HostHandler
  /**
   * Never throws for a planner outcome. `signal` aborts the planner (and a
   * queued request) the way `dispose()` does for all of them.
   */
  run(request: UpliftRequest, signal?: AbortSignal): Promise<UpliftResult>
  dispose(): Promise<void>
}

function defaultCommand(root: string) {
  return { argv: [path.join(root, "bin", "run-bun"), "hooks/engine.ts"], cwd: root }
}

export function createUplift(deps: UpliftDeps): UpliftModule {
  const pool = createPlannerPool({ maxConcurrent: deps.maxConcurrent ?? DEFAULT_CONCURRENCY, killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS })
  const attempts = new Map<string, number>()
  const stateDir = () => path.resolve(deps.stateRoot(), "uplift")

  /** Attempts made so far for a card; continues across host restarts, so a session id is never reused. */
  async function attemptsSoFar(dir: string, runId: string, nodeId: string) {
    const key = `${runId}\0${nodeId}`
    if (!attempts.has(key)) {
      const stored = await loadStored(dir, runId, nodeId)
      if (!attempts.has(key)) attempts.set(key, stored?.attempt ?? 0)
    }
    return key
  }

  async function plan(request: UpliftRequest, signal: AbortSignal | undefined, started: number) {
    const original = request.original
    const settled = (result: Omit<UpliftResult, "original" | "elapsedMs">): UpliftResult => ({ ...result, original, elapsedMs: Date.now() - started })
    const env = deps.env ?? process.env
    const settings = await deps.settings()

    if (!settings.uplift.enabled) return settled({ status: "skipped", reason: "disabled" })
    if (!original.trim()) return settled({ status: "skipped", reason: "empty" })
    // Planning twice would wrap an uplifted spec in a second spec.
    if (isUplifted(original)) return settled({ status: "skipped", reason: "passthrough" })

    const located = await locate(settings, env)
    if ("reason" in located) return settled({ status: "failed", reason: located.reason })

    const dir = stateDir()
    // claude-ultrathink silently ignores a state dir inside a `.planning` tree and writes to the user's own.
    if (dir.split(path.sep).includes(".planning")) {
      return settled({ status: "failed", reason: `the OpenFlow state directory (${dir}) is inside a .planning tree, which claude-ultrathink refuses: move OPENFLOW_STATE_DIR` })
    }

    const key = await attemptsSoFar(dir, request.runId, request.nodeId)
    const attempt = attempts.get(key)! + 1
    attempts.set(key, attempt)
    const sessionId = sessionIdFor(request.runId, request.nodeId, attempt)
    const command = (deps.command ?? defaultCommand)(located.root)
    const timeoutMs = request.timeoutMs ?? settings.uplift.timeoutMs

    await writeControl(dir, settings)
    const exit = await pool.run(
      {
        argv: command.argv,
        cwd: command.cwd,
        env: plannerEnv(env, settings, dir),
        // The host must not be "omp" (native-unavailable) or unknown (unsupported-host): report 06 §A.
        stdin: `${JSON.stringify({ host: "prime-agent", session_id: sessionId, prompt: original, cwd: request.cwd ?? deps.project() })}\n`,
        timeoutMs,
      },
      signal,
    )
    // `elapsedMs` counts from the request, queue wait included: it is what the card waited.
    return interpret({ exit, original, stateDir: dir, sessionId, timeoutMs, elapsedMs: Date.now() - started })
  }

  /** Best effort: the result is still returned when the disk refuses; only GET across a restart loses it. */
  async function remember(request: UpliftRequest, result: UpliftResult) {
    try {
      const dir = stateDir()
      const key = await attemptsSoFar(dir, request.runId, request.nodeId)
      await saveStored(dir, request.runId, request.nodeId, { attempt: attempts.get(key)!, result })
    } catch {
      // See above.
    }
  }

  async function run(request: UpliftRequest, signal?: AbortSignal): Promise<UpliftResult> {
    const started = Date.now()
    let result: UpliftResult
    try {
      result = await plan(request, signal, started)
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      result = { status: "failed", original: request.original, reason: `the planner could not be run (${redact(message).slice(0, 200)})`, elapsedMs: Date.now() - started }
    }
    await remember(request, result)
    return result
  }

  return {
    handle: createRoutes({
      run,
      read: async (runId, nodeId) => (await loadStored(stateDir(), runId, nodeId))?.result,
    }),
    run,
    dispose: () => pool.dispose(),
  }
}
