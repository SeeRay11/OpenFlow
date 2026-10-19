import type { MemoryInfo } from "../../shared/memory"
import type { SwarmAgentState, SwarmStatus } from "../../shared/swarm"
import type { UpliftDecision, UpliftInfo } from "../../shared/uplift"
import type { NodeStatus } from "../graph/types"

/**
 * Every string the uplift / memory / swarm surfaces show, as data.
 *
 * There is no DOM test infrastructure in this package, so the components in
 * `card-stages.tsx` only place these values; the wording, the counts and the
 * "what is honest to say when the planner or Substrate was unreachable" rules
 * live here where `bun test` can reach them.
 */

export type StageTone = "neutral" | "ok" | "info" | "warn" | "danger"

export type Chip = {
  label: string
  /** Native tooltip; may span several lines. */
  title: string
  /** Full sentence for assistive tech, and for the live region. */
  aria: string
  tone: StageTone
}

/** Longest preview a row shows; the host already cuts memory previews at 240. */
export const PREVIEW_LIMIT = 140
/** Memory subjects a chip tooltip lists before saying "+n more". */
const TITLE_SUBJECTS = 5
/** Agent pills on a card before the rest collapse into "+n". */
const PILL_LIMIT = 4

/** One line, at most `max` characters, with an ellipsis when something was cut. */
export function truncate(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function formatElapsed(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/* ------------------------------------------------------------------- uplift */

const SKIP_REASONS: Record<string, string> = {
  "jev-skip": "Jev judged this is not new multi-step work, so the original prompt was sent",
  empty: "the prompt was empty",
  disabled: "prompt uplift is switched off",
  passthrough: "the prompt asked to be sent as written",
  "ultrathink-command": "the prompt already invoked ultrathink",
  "child-or-disabled": "uplift does not run for sub-sessions",
  "unsupported-host": "the planner does not support this host",
  "native-unavailable": "the planner's native host is unavailable",
}

/** `skipped` is mostly Jev's call; those get their own label so it is clear nobody failed. */
export function isJevSkip(uplift: UpliftInfo | undefined) {
  return uplift?.status === "skipped" && uplift.reason?.startsWith("jev") === true
}

export function upliftReasonText(reason: string | undefined) {
  if (!reason) return undefined
  return SKIP_REASONS[reason] ?? reason
}

/** Parts of the plan that fell back with `ok` mean a partial plan, which is still sent. */
export function upliftDegraded(uplift: UpliftInfo | undefined) {
  return uplift?.status === "ok" && !!uplift.degraded?.length
}

export function upliftChip(uplift: UpliftInfo | undefined): Chip | undefined {
  if (!uplift) return undefined
  const reason = upliftReasonText(uplift.reason)
  const took = formatElapsed(uplift.elapsedMs)
  const suffix = took ? ` (${took})` : ""

  if (uplift.status === "running")
    return {
      label: "uplifting…",
      title: "prompt uplift is rewriting this card's task before it is sent",
      aria: "prompt uplift running",
      tone: "info",
    }

  if (uplift.status === "ok") {
    const partial = upliftDegraded(uplift)
    const parts = partial ? `; fell back on ${uplift.degraded!.join(", ")}` : ""
    return {
      label: partial ? "uplifted ~" : "uplifted",
      title: `the uplifted prompt was sent instead of the original${parts}${suffix}`,
      aria: partial ? "prompt uplifted with a partial plan" : "prompt uplifted",
      tone: partial ? "warn" : "ok",
    }
  }

  if (uplift.status === "skipped") {
    const jev = isJevSkip(uplift)
    return {
      label: jev ? "skipped (Jev)" : "uplift skipped",
      title: `the original prompt was sent as written${reason ? ` — ${reason}` : ""}`,
      aria: jev ? "prompt uplift skipped by Jev" : "prompt uplift skipped",
      tone: "neutral",
    }
  }

  if (uplift.status === "declined")
    return {
      label: "original sent",
      title: `uplift failed${reason ? ` (${reason})` : ""}; the original prompt was sent at your request`,
      aria: "prompt uplift failed, original prompt sent at your request",
      tone: "warn",
    }

  return {
    label: "uplift failed",
    title: `nothing was sent${reason ? ` — ${reason}` : ""}`,
    aria: `prompt uplift failed${reason ? `: ${reason}` : ""}`,
    tone: "danger",
  }
}

/** Fixed-order key/value rows for the inspector's uplift section. */
export function upliftFacts(uplift: UpliftInfo): Array<{ key: string; value: string }> {
  const facts: Array<{ key: string; value: string }> = []
  const status = upliftChip(uplift)
  if (status) facts.push({ key: "status", value: status.label })
  const reason = upliftReasonText(uplift.reason)
  if (reason) facts.push({ key: "reason", value: reason })
  if (uplift.source) facts.push({ key: "planner", value: uplift.source === "fallback" ? "fallback spec (engine unreachable)" : "llm" })
  if (uplift.engine) facts.push({ key: "engine", value: uplift.engine })
  if (uplift.graphId) facts.push({ key: "graph id", value: uplift.graphId })
  if (uplift.nodes !== undefined) facts.push({ key: "nodes", value: String(uplift.nodes) })
  if (uplift.degraded?.length) facts.push({ key: "degraded", value: uplift.degraded.join(", ") })
  const took = formatElapsed(uplift.elapsedMs)
  if (took) facts.push({ key: "took", value: took })
  return facts
}

export function decisionLine(decision: UpliftDecision) {
  return `${decision.point} · p ${decision.p.toFixed(2)} · ${decision.action}`
}

export type UpliftPrompts = { original?: string; uplifted?: string }

/**
 * What the two collapsible blocks hold. `originalPrompt` is the runtime's own
 * copy and wins only when the uplift record carries none.
 */
export function upliftPrompts(originalPrompt: string | undefined, uplift: UpliftInfo | undefined): UpliftPrompts {
  const original = uplift?.original || originalPrompt
  return { original: original || undefined, uplifted: uplift?.uplifted || undefined }
}

/**
 * Dialog copy for one blocked card. `waiting` counts the failures queued behind it.
 * `canRetry` is false on the last attempt: the engine fails the card then, so
 * offering a retry would be offering a button that cancels.
 */
export function upliftFailureView(
  failure: { role: string; reason: string; elapsedMs: number; attempt: number; attempts: number },
  waiting: number,
) {
  const took = formatElapsed(failure.elapsedMs)
  return {
    title: `Prompt uplift failed for ${failure.role}`,
    reason: failure.reason,
    elapsed: took ? `after ${took}` : undefined,
    queue: waiting > 0 ? `${plural(waiting, "more card")} waiting for a decision` : undefined,
    canRetry: failure.attempt < failure.attempts,
  }
}

/* ------------------------------------------------------------------- memory */

type MemoryRead = NonNullable<MemoryInfo["read"]>
export type MemoryRowItem = MemoryRead["items"][number] & {
  /** `MemoryInfo` items do not carry an age today; shown when the host adds one. */
  ageDays?: number
}

/** Write outcomes the user has to hear about: the fact may not exist. */
const WRITE_PROBLEMS: Record<string, true> = {
  unverified: true,
  quarantined: true,
  denied: true,
  conflict: true,
  unavailable: true,
}

const WRITE_TEXT: Record<string, string> = {
  stored: "stored",
  unverified: "sent, but the server did not confirm it was persisted",
  quarantined: "held in quarantine by Substrate",
  denied: "denied by Substrate",
  conflict: "conflicts with an existing fact",
  skipped: "nothing to write",
  unavailable: "memory unavailable",
  disabled: "memory is off",
  running: "writing…",
}

export function memoryAge(ageDays: number | undefined) {
  if (ageDays === undefined || !Number.isFinite(ageDays) || ageDays < 0) return undefined
  if (ageDays < 1) return "today"
  return `${Math.floor(ageDays)} d ago`
}

export function memoryRow(item: MemoryRowItem) {
  const from = item.run && item.card ? `run ${item.run} · card ${item.card}` : undefined
  return {
    scope: item.scope,
    subject: item.subject,
    age: memoryAge(item.ageDays),
    preview: truncate(item.preview, PREVIEW_LIMIT),
    from,
  }
}

function readSymbol(read: MemoryInfo["read"]) {
  if (!read) return "–"
  if (read.status === "running") return "…"
  if (read.status === "unavailable") return "!"
  if (read.status === "disabled") return "–"
  return String(read.items.length)
}

function writeSymbol(write: MemoryInfo["write"]) {
  if (!write) return "0"
  if (write.status === "running") return "…"
  if (write.status === "stored") return "1"
  if (WRITE_PROBLEMS[write.status]) return "!"
  return "0"
}

/** The honest one-liner for a failed read; never implies the card had memory it did not. */
export function memoryReadText(read: MemoryRead | undefined) {
  if (!read) return undefined
  if (read.status === "running") return "reading memory…"
  if (read.status === "unavailable") return `memory unavailable: ${read.error ?? "the memory service did not answer"}; the card ran without it`
  if (read.status === "disabled") return "memory is off for this run"
  if (read.status === "empty") return "no related memories found"
  const brief = read.briefState && read.briefState !== "complete" ? ` (brief ${read.briefState})` : ""
  return `read ${read.items.length} ${read.items.length === 1 ? "memory" : "memories"}${brief}`
}

export function memoryWriteText(write: MemoryInfo["write"]) {
  if (!write) return undefined
  const base = WRITE_TEXT[write.status] ?? write.status
  const hedged = write.status === "stored" && write.kind === "todo" ? " (stored as a todo because the output was hedged)" : ""
  const detail = write.status === "stored" ? `${write.subject ?? ""}${hedged}` : write.error
  return detail ? `${base}: ${detail}` : base
}

export function memoryChip(memory: MemoryInfo | undefined): Chip | undefined {
  const read = memory?.read
  const write = memory?.write
  if (!read && !write) return undefined

  const writeOff = !write || write.status === "disabled"
  if (read?.status === "disabled" && writeOff)
    return { label: "mem off", title: "shared memory is off for this run", aria: "shared memory is off", tone: "neutral" }

  if (read?.status === "unavailable" && (!write || write.status === "disabled" || write.status === "unavailable")) {
    const error = read.error ?? write?.error ?? "the memory service did not answer"
    return {
      label: "mem unavailable",
      title: `memory unavailable: ${error}`,
      aria: `shared memory unavailable: ${error}`,
      tone: "warn",
    }
  }

  const lines: string[] = []
  const readLine = memoryReadText(read)
  if (readLine) lines.push(readLine)
  for (const item of (read?.items ?? []).slice(0, TITLE_SUBJECTS)) lines.push(`  ↓ ${item.subject}`)
  const hidden = (read?.items.length ?? 0) - TITLE_SUBJECTS
  if (hidden > 0) lines.push(`  … +${hidden} more`)
  const writeLine = memoryWriteText(write)
  if (writeLine) lines.push(`↑ ${writeLine}`)

  const problem = read?.status === "unavailable" || (!!write && WRITE_PROBLEMS[write.status] === true)
  const running = read?.status === "running" || write?.status === "running"
  const aria = [readLine, writeLine && `write: ${writeLine}`].filter(Boolean).join("; ")
  return {
    label: `mem ↓${readSymbol(read)} ↑${writeSymbol(write)}`,
    title: lines.join("\n"),
    aria: `shared memory — ${aria}`,
    tone: problem ? "warn" : running ? "info" : "neutral",
  }
}

/* -------------------------------------------------------------------- swarm */

const COUNT_ORDER = ["running", "queued", "completed", "failed", "cancelled"] as const

export function swarmCountsText(counts: SwarmStatus["counts"]) {
  const parts: string[] = []
  for (const key of COUNT_ORDER) {
    if (counts[key] > 0) parts.push(`${counts[key]} ${key === "completed" ? "done" : key}`)
  }
  return parts.join(" · ")
}

/**
 * A swarm's agents only run while their card does. Once the card is anything
 * but running or queued, what the host last said may be stale (the final
 * status can arrive late or never), so open agents read as cancelled.
 */
export function settleSwarm(swarm: SwarmStatus | undefined, status: NodeStatus | undefined): SwarmStatus | undefined {
  if (!swarm || status === undefined || status === "running" || status === "queued") return swarm
  if (!swarm.active && !swarm.counts.running && !swarm.counts.queued) return swarm
  const counts = { ...swarm.counts, running: 0, queued: 0, cancelled: swarm.counts.cancelled + swarm.counts.running + swarm.counts.queued }
  const agents = swarm.agents.map((entry) => (entry.state === "running" || entry.state === "queued" ? { ...entry, state: "cancelled" as const } : entry))
  return { ...swarm, active: false, counts, agents }
}

/** The card line shows once the swarm did something or degraded; a loaded-but-idle extension is not news. */
export function swarmVisible(swarm: SwarmStatus | undefined): swarm is SwarmStatus {
  if (!swarm || swarm.mode === "off") return false
  return swarm.active || swarm.agents.length > 0 || !!swarm.error
}

export type SwarmPill = { agent: string; state: SwarmAgentState["state"]; title: string }

/** `agent: state — last activity`, the one form every swarm surface uses. */
export function swarmAgentText(entry: SwarmAgentState) {
  return `${entry.agent}: ${entry.state}${entry.activity ? ` — ${entry.activity}` : ""}`
}

export function swarmPills(agents: SwarmAgentState[]) {
  const pills: SwarmPill[] = agents
    .slice(0, PILL_LIMIT)
    .map((entry) => ({ agent: entry.agent, state: entry.state, title: swarmAgentText(entry) }))
  return { pills, more: Math.max(0, agents.length - PILL_LIMIT) }
}

export function swarmLine(raw: SwarmStatus | undefined, status?: NodeStatus) {
  const swarm = settleSwarm(raw, status)
  if (!swarmVisible(swarm)) return undefined
  const counts = swarmCountsText(swarm.counts) || "delegating"
  const { pills, more } = swarmPills(swarm.agents)
  const text = swarm.error ? `swarm degraded: ${swarm.error}` : `swarm ${counts}`
  const tone: StageTone = swarm.error || swarm.counts.failed > 0 ? "danger" : swarm.counts.running > 0 ? "info" : "neutral"
  return {
    text,
    title: [text, ...swarm.agents.map(swarmAgentText)].join("\n"),
    aria: swarm.error ? `agent swarm degraded: ${swarm.error}` : `agent swarm ${counts}`,
    tone,
    pills,
    more,
  }
}

/** Inspector text for a swarm that loaded but has not delegated. */
export function swarmIdleText(swarm: SwarmStatus) {
  if (swarm.mode === "always") return "swarm is on; waiting for the card to hand work to a01-orchestrator"
  return "swarm is on (auto); no delegation yet"
}

/* ------------------------------------------------------------- live updates */

export type StageSnapshot = { uplift?: string; memory?: string; swarm?: string }

/** One sentence per surface, or nothing when a surface has no state yet. */
export function stageSnapshot(runtime: {
  uplift?: UpliftInfo
  memory?: MemoryInfo
  swarm?: SwarmStatus
  status?: NodeStatus
}): StageSnapshot {
  return {
    uplift: upliftChip(runtime.uplift)?.aria,
    memory: memoryChip(runtime.memory)?.aria,
    swarm: swarmLine(runtime.swarm, runtime.status)?.aria,
  }
}

/**
 * What a screen reader hears when the selected card's stage state moves from
 * `prev` to `next`: only the surfaces that changed, nothing when none did.
 */
export function stageAnnouncement(role: string, prev: StageSnapshot, next: StageSnapshot) {
  const changed: string[] = []
  for (const key of ["uplift", "memory", "swarm"] as const) {
    if (next[key] && next[key] !== prev[key]) changed.push(next[key])
  }
  if (!changed.length) return ""
  return `${role}: ${changed.join(". ")}`
}

/* ------------------------------------------------------------------- dialog */

/**
 * Where Tab or Shift+Tab lands inside a modal with `count` focusable controls.
 * `current` is the focused control's index, or -1 when focus is outside the
 * dialog, in which case either direction enters at the near end.
 */
export function wrapFocus(current: number, count: number, backwards: boolean) {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return (current + (backwards ? -1 : 1) + count) % count
}
