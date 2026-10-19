/**
 * Prompt Uplift (claude-ultrathink) as the engine and the UI see it.
 *
 * The host (`lib/uplift`) runs ultrathink's headless planner — `bin/run-bun
 * hooks/engine.ts`, JSON on stdin and stdout — with `host: "prime-agent"` (the
 * `omp` host is `native-unavailable` through that entry) and the Claude CLI as
 * the engine. Jev decisions run inside the planner whenever a key is present.
 *
 * Contract with the engine (`src/server/engine.ts`), in order:
 *   1. a card turn of kind `task` calls `deps.uplift` with the card's own task
 *      text; protocol turns (verdict, force-final, dispatch result, reassign)
 *      are never uplifted;
 *   2. `ok` — the engine sends `uplifted` instead of the task text;
 *      `skipped` — the planner declined on purpose (Jev judged it not new work,
 *      uplift is off, the text is trivial): send the original, note why;
 *      `failed` — nothing is sent. The engine blocks the card and asks the user:
 *      run with the original prompt, retry uplift, or cancel the card.
 *   3. original and uplifted text are both kept on the card and in the run log.
 */

import type { ClarificationInfo } from "./clarification"

export type UpliftStatus = "ok" | "skipped" | "failed"

export type UpliftRequest = {
  runId: string
  nodeId: string
  /** Role of the card, for the log line only. */
  role?: string
  /** The card's own task text. Never the upstream outputs, attachments or briefing boilerplate. */
  original: string
  /** Project directory; the planner reads the repo for context from here. */
  cwd?: string
  /** Wall clock for the whole planner process group. Default from settings. */
  timeoutMs?: number
}

export type UpliftDecision = {
  /** Jev decision point: `plan` | `blocking` | `knowledge` | ... */
  point: string
  /** Probability the decision model returned, 0..1. */
  p: number
  /** What the planner did with it. */
  action: string
}

export type UpliftResult = {
  status: UpliftStatus
  original: string
  /** The spec XML (+ the Graph-of-Thought guidance line) to send in place of `original`. Present when `ok`. */
  uplifted?: string
  /**
   * Why: for `skipped` the planner's reason (`jev-skip`, `empty`, `disabled`,
   * `passthrough`, ...); for `failed` one actionable sentence (timeout, the
   * `claude` CLI missing or logged out, planner crashed, fallback spec).
   */
  reason?: string
  /** `fallback` means the planner could not reach its engine and wrote a conservative spec: treated as `failed`. */
  source?: "llm" | "fallback"
  graphId?: string
  /** Absolute path of the saved spec XML. */
  specPath?: string
  nodes?: number
  waves?: number
  /** Parts of the plan that fell back (`fill:n3`, ...). Non-empty with `ok` means a partial plan. */
  degraded?: string[]
  decisions?: UpliftDecision[]
  clarifications?: ClarificationInfo[]
  engine?: string
  elapsedMs: number
}

/** The card-visible state, persisted on the runtime node and in the run log. */
export type UpliftInfo = {
  status: "running" | UpliftStatus | "declined"
  original: string
  uplifted?: string
  reason?: string
  source?: "llm" | "fallback"
  graphId?: string
  specPath?: string
  nodes?: number
  degraded?: string[]
  decisions?: UpliftDecision[]
  elapsedMs?: number
  /** Which engine planned it, e.g. `claude:claude-sonnet-5-5`. */
  engine?: string
  /** The user chose to run the original after a failure (the only way `failed` proceeds). */
  declined?: boolean
}

export const UPLIFT_ROUTE = "/flow/api/uplift"
/** Uplifted text carries this root tag family; never uplift text that already starts with one. */
export const UPLIFTED_ROOT_TAGS = ["BUILD_PROMPT", "FIX_PROMPT", "RESEARCH_PROMPT", "CHANGE_PROMPT", "UPLIFTED_PROMPT"] as const
