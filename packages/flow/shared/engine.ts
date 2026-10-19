/**
 * The engine wire: what the browser client (`src/server/client.ts`) and the
 * Omp host (`lib/omp/*`) agree on. JSON over `/flow/api/engine/*` plus one SSE
 * stream of `BusEvent`s. Types and route paths only; both sides import them and
 * neither re-declares them.
 *
 * The browser run engine (`src/server/engine.ts`) talks to `EngineApi` and to
 * nothing else — not to omp, Substrate, ultrathink or the swarm. Everything
 * omp-shaped lives behind this wire, in the host.
 *
 * One Omp process (`omp --mode rpc-ui`) per card session; the host owns it, so
 * a page reload does not end a session and `CreateSession.reuse` can re-attach.
 */

import type { SwarmMode, SwarmStatus } from "./swarm"

export const ENGINE_BASE = "/flow/api/engine"

/* ------------------------------------------------------------------ catalog */

/** One pricing tier, USD per 1M tokens — the shape `src/server/usage.ts` prices from. */
export type Price = {
  input: number
  output: number
  cache: { read: number; write: number }
  tier?: { type: "context"; size: number }
}

export type ModelInfo = {
  providerID: string
  id: string
  name?: string
  reasoning?: boolean
  contextWindow?: number
  /** Input modalities, e.g. `["text", "image"]`. `accepts()` reads this. */
  capabilities?: { input: string[] }
  /** Omp's per-model cost mapped to tiers. Absent or empty = the catalog quotes no price (unpriced, never "free"). */
  cost?: Price[]
}

/* -------------------------------------------------- permissions and questions */

export type PermissionReply = "once" | "always" | "reject"

export type QuestionOption = { label: string; description: string }

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/* ------------------------------------------------------------------- events */

/**
 * One event on the SSE stream (`engineRoutes.events`): `data: <json>\n\n`.
 * `: ping` comment lines keep the stream alive. There is no replay; the engine
 * re-reads authoritative state (steps, transcript) after the fact.
 *
 * The host maps omp frames onto the names and fields the engine and
 * `src/server/activity.ts` already read — do not rename them:
 *  - `session.created`            sessionID, info.parentID            (a subagent session started)
 *  - `session.next.step.started`  sessionID, assistantMessageID, model{providerID,id}, agent
 *  - `session.next.step.ended`    sessionID, assistantMessageID, tokens{input,output,reasoning,cache{read,write}}
 *  - `session.next.step.failed`   sessionID, assistantMessageID, error
 *  - `session.next.text.started|delta|ended`        sessionID, textID, delta|text
 *  - `session.next.reasoning.delta|ended`           sessionID, reasoningID, delta|text
 *  - `session.next.tool.input.started`  sessionID, callID, name
 *  - `session.next.tool.called`         sessionID, callID, tool, input
 *  - `session.next.tool.progress`       sessionID, callID, content[]
 *  - `session.next.tool.success|failed` sessionID, callID, content[]|result|error
 *  - `permission.v2.asked`        sessionID, id, action, resources[]  (omp approval prompt)
 *  - `question.v2.asked`          sessionID, id, questions: QuestionInfo[]  (omp `ask`)
 * New:
 *  - `flow.swarm.status`   sessionID, status: SwarmStatus
 *  - `flow.session.lost`   sessionID, reason  (the process died; the engine recreates the card's session)
 *  - `flow.notice`         sessionID?, level: "info" | "error", message  (omp `notice`, extension errors)
 */
export type BusEvent = { type: string; data?: Record<string, any> }

export type FlowSwarmEvent = { type: "flow.swarm.status"; data: { sessionID: string; status: SwarmStatus } }

/* ----------------------------------------------------------------- sessions */

/**
 * Everything the host needs to launch one card, in OpenFlow's own vocabulary.
 * Replaces "merge agents into opencode.json and restart the engine": a changed
 * card simply launches a fresh process with the new spec.
 */
export type CardSpec = {
  /** Stable per-card key (`agentKey`): pipeline-role-node, sanitised. */
  key: string
  role: string
  /** Role instructions, appended to omp's own system prompt (never replacing it). */
  prompt?: string
  /** Tool toggles in OpenFlow's vocabulary (`toolMap`): read grep glob edit bash webfetch websearch todowrite skill question. Absent = every tool. */
  tools?: Record<string, boolean>
  /** Allowlisted MCP server names; absent = every server omp has configured. */
  mcp?: string[]
  /** Orchestrator cards get `openflow_dispatch` / `openflow_finish` as RPC host tools. */
  dispatch?: boolean
}

export type CreateSession = {
  /** The run this session belongs to; keys memory, uplift state and the swarm task store. */
  runId: string
  nodeId: string
  card: CardSpec
  /** `provider/id`; absent = omp's configured default model. */
  model?: string
  /** Working directory: the card's worktree, else the project. Fixed for the life of the session. */
  directory?: string
  /** `auto` runs with approvals granted; `manual` surfaces them as `permission.v2.asked`. */
  permissions?: "auto" | "manual"
  /** Absent = the settings default. */
  swarm?: SwarmMode
  /** A session an earlier run left open (`RunOptions.sessions`): re-attach instead of creating. */
  reuse?: string
}

export type SessionRow = {
  id: string
  title: string
  agent?: string
  model?: string
  parent?: string
  /** Epoch ms. */
  created: number
  updated: number
}

export type Turn = { role: "user" | "assistant"; text: string }

/** Final assistant turn of a session: the joined text parts plus any error, already run through `describe`. */
export type Transcript = { text: string; error?: string }

export type ToolCall = { id: string; name: string; input: unknown }

/** One settled assistant step. Structurally `StepUsage` (`graph/types`) plus what omp itself reported. */
export type WireStep = {
  /** Assistant message id — the dedupe key. Stable and unique per assistant turn. */
  messageID: string
  /** `providerID/modelID` the step actually ran on. */
  model: string
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** USD omp reported for the step (`usage.cost.total`). Informational: the engine prices from the catalog. */
  reportedCost?: number
}

export type PromptFile = { name: string; url: string; mime?: string }

export type PromptRequest = { text: string; files?: PromptFile[] }

export type WaitRequest = { timeoutMs?: number }

/**
 * Long-poll: resolves when omp reports the session settled (`prompt_result` plus
 * `session_settled`, nothing queued or running in the background).
 * `result` distinguishes a clean answer from an abort or a provider error; the
 * engine must not treat `aborted` as success.
 */
export type WaitResult = {
  status: "idle" | "timeout" | "missing"
  result?: "completed" | "aborted" | "error"
  error?: string
}

export type HealthInfo = {
  ok: boolean
  omp: { available: boolean; version?: string }
  sessions: { live: number }
}

/**
 * Every non-2xx answer. Provider failures keep the status in the text
 * (`Provider request failed with HTTP 429 Too Many Requests …`) because the
 * engine classifies rate limits and transient failures by regex on this text;
 * a missing session says `session not found: <id>`.
 */
export type EngineError = { error: string; code?: string }

/* ------------------------------------------------------------------- routes */

export const engineRoutes = {
  health: `${ENGINE_BASE}/health`,
  models: `${ENGINE_BASE}/models`,
  /** SSE. */
  events: `${ENGINE_BASE}/events`,
  /** POST creates; GET lists `SessionRow[]` newest first (`?limit=`). */
  sessions: `${ENGINE_BASE}/sessions`,
  /** GET: ids whose agent loop is executing right now. */
  active: `${ENGINE_BASE}/sessions/active`,
  /** POST `{ runId }`: dispose every session of a run (run finished or abandoned). */
  releaseRun: `${ENGINE_BASE}/runs/release`,
} as const

/**
 * `/flow/api/engine/sessions/<id><tail>` with tails:
 *  `` DELETE dispose | `/prompt` POST PromptRequest | `/wait` POST WaitRequest -> WaitResult |
 *  `/interrupt` POST | `/transcript` GET ?limit -> Turn[] | `/final` GET -> Transcript |
 *  `/steps` GET -> WireStep[] | `/calls` GET ?limit -> ToolCall[] (newest first) |
 *  `/permission/<requestID>` POST { reply: PermissionReply } |
 *  `/question/<requestID>` POST { answers: string[][] } | `/question/<requestID>/reject` POST
 */
export function sessionRoute(id: string, tail = ""): string {
  return `${ENGINE_BASE}/sessions/${encodeURIComponent(id)}${tail}`
}

/* --------------------------------------------------------------------- port */

/**
 * The port `src/server/engine.ts` depends on (`EngineDeps.api`). Implemented
 * by `src/server/client.ts` over the routes above; implemented by test doubles
 * in `engine.test.ts`. Optional members may be absent from a double.
 */
export interface EngineApi {
  subscribe(onEvent: (event: BusEvent) => void, signal: AbortSignal): Promise<void>
  createSession(input: CreateSession): Promise<{ id: string }>
  /** Resolves when the prompt is admitted, not when the turn ends. */
  prompt(sessionID: string, text: string, files?: PromptFile[]): Promise<unknown>
  /** Resolves on idle, silently on abort; throws on timeout, on a lost session, and on `aborted`/`error` results. */
  waitForIdle(sessionID: string, options?: { signal?: AbortSignal; interval?: number; timeout?: number }): Promise<void>
  transcript(sessionID: string): Promise<Transcript>
  /** Never throws. */
  interrupt(sessionID: string): Promise<void>
  /** Dispose a session the engine abandons (a replaced critic session, a finished card). Best effort. */
  release?(sessionID: string): Promise<void>
  replyPermission(sessionID: string, requestID: string, reply: PermissionReply): Promise<unknown>
  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<unknown>
  rejectQuestion(sessionID: string, requestID: string): Promise<unknown>
  accepts(model: ModelInfo | undefined, mime: string): boolean
  models(): Promise<ModelInfo[]>
  describe(error: unknown, response?: Response): string
  sessionSteps?(sessionID: string): Promise<WireStep[]>
  sessionCalls?(sessionID: string, limit?: number): Promise<ToolCall[]>
}
