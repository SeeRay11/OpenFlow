/**
 * Agent Swarm under the hood of a card — the types the swarm module
 * (`lib/swarm`), the Omp launch builder (`lib/omp/launch.ts`), the engine wire
 * and the UI agree on. Types and constants only; nothing here touches disk.
 *
 * A card's Omp session loads agent-swarm's Omp extension (`-e <root>/omp`).
 * Whether the model then delegates to the swarm is the extension's own
 * decision (HOOK-01 classifies SDLC-shaped prompts and adds a hint) unless the
 * mode is `always`.
 */

import type { OmpSettings } from "./omp"

/**
 * - `off`: the extension is not loaded; no hook, no hint, no signing need.
 * - `auto`: the extension is loaded and its own classifier decides.
 * - `always`: loaded, and the card's system prompt tells it to hand the work to
 *   `a01-orchestrator` through the `task` tool.
 *
 * Never implemented through the extension's `/swarm` command: that command
 * writes `.claude/swarm-state.json` and appends to `.planning/STATE.md` in the
 * session's cwd, which would pollute the user's repository.
 */
export type SwarmMode = "off" | "auto" | "always"

export const SWARM_MODES: readonly SwarmMode[] = ["off", "auto", "always"]

export type SwarmProblemCode =
  | "no-root" // no agent-swarm checkout configured or discoverable
  | "bad-root" // configured root has no omp/package.json or scripts/orch_plan.py
  | "no-python" // python3 missing
  | "no-crypto" // python cannot import `cryptography` (Ed25519 signing)
  | "no-signing-key" // neither SWARM_ED25519_KEY(_FILE) nor SWARM_SIGNING_KEY is set (value-free check)
  | "bad-state-dir"

export type SwarmProblem = {
  code: SwarmProblemCode
  message: string
  /** What the user can do about it, in one sentence. */
  fix?: string
}

export type SwarmPreflight = {
  /** True when a card can run with `mode` as asked. `off` is always ok. */
  ok: boolean
  /** The mode that will actually be used: `auto`/`always` degrade to `off` when not ok. */
  effective: SwarmMode
  requested: SwarmMode
  problems: SwarmProblem[]
  /** Absolute path of the agent-swarm checkout in use; absent when there is none. */
  root?: string
}

/**
 * What the swarm module contributes to one card's Omp launch. The launch
 * builder appends `args` to argv, merges `env` over the filtered host env, and
 * deep-merges `overlay` into the per-card `--config` overlay it writes.
 * `env` never carries a signing key value into argv or a file: the host env
 * passthrough is the only way a key reaches the child.
 */
export type SwarmLaunch = {
  effective: SwarmMode
  /** e.g. ["-e", "<root>/omp"]. Empty when `effective` is `off`. */
  args: string[]
  /** SWARM_DIR (absolute, outside the worktree), SWARM_ROOT when needed, ... Never SWARM_AGENT / SWARM_TASK_ID / SWARM_CHILD. */
  env: Record<string, string>
  /** Settings overlay: `task.maxRecursionDepth: 2`, task isolation off. */
  overlay: Record<string, unknown>
  /** Appended to the card's system prompt (mode `always`); empty otherwise. */
  systemPrompt: string
  /** Absolute task-store directory for this card; the progress reader looks here. */
  stateDir: string
  preflight: SwarmPreflight
}

export type SwarmAgentState = {
  /** Agent slug, e.g. `a05-backend`. */
  agent: string
  state: "queued" | "running" | "completed" | "failed" | "cancelled"
  /** One line: the last tool or phase, when known. */
  activity?: string
  /** Epoch ms of the last change. */
  at: number
}

/** The card-visible swarm state. Emitted on the engine stream as `flow.swarm.status`. */
export type SwarmStatus = {
  mode: SwarmMode
  /** True once any delegation (a `task` call to a swarm agent) was seen this session. */
  active: boolean
  correlationId?: string
  counts: { queued: number; running: number; completed: number; failed: number; cancelled: number }
  agents: SwarmAgentState[]
  /** Set when the swarm degraded (preflight failed, a lane failed). Always actionable. */
  error?: string
  updatedAt: number
}

export const EMPTY_SWARM_COUNTS: SwarmStatus["counts"] = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }

/**
 * Watches one card's swarm. Fed every non-response frame of the card's Omp
 * process; turns `task` delegations and omp's `subagent_*` frames (enabled
 * with `set_subagent_subscription`) into `SwarmStatus`. May also fold in the
 * task store's `live.json` (`swarm.live.v1`) when `poll` is called.
 */
export interface SwarmTracker {
  /** Returns the new status when this frame changed it, else undefined. */
  observe(frame: { type: string; [key: string]: unknown }): SwarmStatus | undefined
  snapshot(): SwarmStatus
  /** Re-read the task store; returns the new status when it changed. */
  poll?(): Promise<SwarmStatus | undefined>
  dispose(): void
}

/** What `lib/omp` receives from `lib/swarm`. Both methods are total: problems come back in `preflight`, never as throws. */
export interface SwarmHost {
  launch(input: {
    settings: OmpSettings
    mode: SwarmMode
    runId: string
    nodeId: string
    /** Per-session directory (absolute); the task store lives in a `swarm` subdirectory. */
    stateDir: string
    env: NodeJS.ProcessEnv
  }): Promise<SwarmLaunch>
  tracker(input: { mode: SwarmMode; stateDir: string }): SwarmTracker
}

export const SWARM_ROUTES = { preflight: "/flow/api/swarm/preflight" } as const
