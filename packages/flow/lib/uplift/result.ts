import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ClarificationInfo } from "../../shared/clarification"
import { UPLIFTED_ROOT_TAGS, type UpliftDecision, type UpliftResult } from "../../shared/uplift"
import { type PlannerExit, writeAtomic } from "./planner"

/**
 * What the planner's one JSON line and its per-session files mean for a card.
 *
 * The only trustworthy success signal is `view.source === "llm"` with a
 * non-empty `context` and no `skipped`: a fallback plan also has a non-empty
 * context and exits 0 (claude-ultrathink report 06 §A).
 */

const GUIDANCE_LINE = "The Graph of Thought above is guidance; verify against the repository."
const MAX_SESSION_SEGMENT = 40
const HINT_CHARS = 300

/** The planner declined on purpose: send the original. */
const DELIBERATE_SKIPS = ["jev-skip", "empty", "disabled", "passthrough", "skip", "precheck-skip", "precheck-passthrough", "ultrathink-command", "skill-preamble"]

type Json = Record<string, unknown>

export type Outcome = {
  exit: PlannerExit
  original: string
  stateDir: string
  sessionId: string
  timeoutMs: number
  elapsedMs: number
}

export type Stored = { attempt: number; result: UpliftResult }

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The file-name rule claude-ultrathink applies to a session id (`safeSessionId`). */
function sessionStem(sessionId: string) {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown"
}

function segment(value: string) {
  if (/^[A-Za-z0-9_.-]+$/.test(value) && value.length <= MAX_SESSION_SEGMENT && value !== "." && value !== "..") return value
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8)
  return `${value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SESSION_SEGMENT - 9)}_${hash}`
}

/** Unique per attempt, so two cards (or two tries of one card) never share a session record. */
export function sessionIdFor(runId: string, nodeId: string, attempt: number) {
  return `openflow-${segment(runId)}-${segment(nodeId)}-${attempt}`
}

export function specPathFor(stateDir: string, sessionId: string) {
  return path.join(stateDir, "sessions", `${sessionStem(sessionId)}.xml`)
}

/** Strips what looks like a credential from text that may reach a reason line. */
export function redact(text: string) {
  return text
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
}

/** One short, redacted line out of stderr or an engine error. */
function condense(text: string, limit = HINT_CHARS) {
  const line = redact(text).replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

function stderrHint(stderr: string) {
  const line = condense(stderr)
  return line ? ` (${line})` : ""
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

function parseResponse(stdout: string): Json | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  const lines = text.split("\n")
  // Some bun builds print a banner before the JSON; the response is the last line that starts an object.
  const candidates = [text, ...lines.filter((line) => line.startsWith("{")).reverse()]
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (isRecord(value)) return value
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Why a plan came back as the planner's conservative fallback, in one sentence. */
function fallbackReason(engineError: string | undefined) {
  if (!engineError) {
    return "the planner could not produce a plan (an empty completion or a prompt over its size limit): shorten the prompt or run the original"
  }
  if (/not logged in|\/login|log in|unauthori[sz]ed|invalid (?:api key|x-api-key)|authentication|credit balance/i.test(engineError)) {
    return "the claude CLI is not logged in: run `claude` once and sign in"
  }
  if (/executable not found|enoent|command not found|no such file/i.test(engineError)) {
    return "the claude CLI was not found: install it and put it on PATH"
  }
  return `the planner could not reach its model (${condense(engineError, 200)}): fix the claude CLI and retry`
}

function decisionsOf(record: Json | undefined): UpliftDecision[] | undefined {
  if (!Array.isArray(record?.decisions)) return undefined
  const decisions: UpliftDecision[] = []
  // A decision that errored carries no probability; showing 0 would claim Jev said no.
  for (const item of record.decisions) {
    if (!isRecord(item) || typeof item.p !== "number" || typeof item.point !== "string") continue
    decisions.push({ point: item.point, p: item.p, action: text(item.action) ?? "" })
  }
  return decisions.length ? decisions : undefined
}

function clarificationsOf(record: Json | undefined): ClarificationInfo[] | undefined {
  if (!Array.isArray(record?.clarifications)) return undefined
  const clarifications: ClarificationInfo[] = []
  for (const item of record.clarifications) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.question !== "string") continue
    const options: ClarificationInfo["options"] = []
    for (const option of Array.isArray(item.options) ? item.options : []) {
      if (!isRecord(option) || typeof option.label !== "string") continue
      options.push(typeof option.description === "string" ? { label: option.label, description: option.description } : { label: option.label })
    }
    clarifications.push({
      id: item.id,
      header: text(item.header) ?? "",
      question: item.question,
      ...(text(item.why) ? { why: text(item.why) } : {}),
      blocking: item.blocking === true,
      options,
      ...(text(item.default) ? { default: text(item.default) } : {}),
    })
  }
  return clarifications.length ? clarifications : undefined
}

/** True when text already opens with one of the uplifted root tags: it must not be planned again. */
export function isUplifted(original: string) {
  const head = /^\s*<([A-Z_]+)[\s>]/.exec(original)?.[1]
  return head !== undefined && (UPLIFTED_ROOT_TAGS as readonly string[]).includes(head)
}

export async function interpret(outcome: Outcome): Promise<UpliftResult> {
  const { exit, original, stateDir, sessionId, elapsedMs } = outcome
  const failed = (reason: string, extra: Partial<UpliftResult> = {}): UpliftResult => ({ status: "failed", original, reason, elapsedMs, ...extra })

  if (exit.spawnError) {
    return failed(`the planner could not be started (${condense(exit.spawnError, 200)}): check the claude-ultrathink path and that bun is installed`)
  }
  if (exit.aborted) return failed("uplift was cancelled before the planner finished")
  if (exit.timedOut) return failed(`planner timed out after ${Number((outcome.timeoutMs / 1000).toFixed(1))} s`)
  if (exit.truncated) return failed("the planner printed more output than OpenFlow accepts")
  if (exit.code !== 0) {
    const how = exit.code === null ? `was stopped by ${exit.signal ?? "a signal"}` : `exited with code ${exit.code}`
    return failed(`the planner ${how}${stderrHint(exit.stderr)}`)
  }

  const response = parseResponse(exit.stdout)
  if (!response) {
    if (/bun not found/i.test(exit.stderr)) return failed("bun was not found: install Bun 1.2 or later, or set BUN to its path")
    return failed(`the planner printed no result${stderrHint(exit.stderr)}`)
  }

  const skipped = text(response.skipped)
  if (skipped !== undefined && DELIBERATE_SKIPS.includes(skipped)) return { status: "skipped", original, reason: skipped, elapsedMs }
  if (skipped === "native-unavailable" || skipped === "unsupported-host") {
    return failed(`claude-ultrathink does not accept the host OpenFlow plans under (${skipped}): update claude-ultrathink`)
  }
  if (skipped === "uplift-failed" || skipped === "engine-error") {
    return failed("the planner failed before it produced a plan: check that the claude CLI is logged in (run `claude` once)")
  }
  if (skipped !== undefined) return failed(`the planner skipped this prompt unexpectedly (${skipped})`)
  const context = text(response.context) ?? ""
  if (!context) return failed("the planner returned an empty plan")

  const record = await readJson(path.join(stateDir, "sessions", `${sessionStem(sessionId)}.json`))
  const session = isRecord(record) ? record : undefined
  const view = isRecord(response.view) ? response.view : undefined
  const resultRecord = isRecord(session?.result) ? session.result : undefined
  const source = view?.source ?? resultRecord?.source
  const engine = text(view?.engine) ?? text(session?.engine)
  if (source !== "llm") {
    // The record is written for fallback plans too; the context carries the same sentence when it is not.
    const fromContext = /planning call failed \(([^)]*)\)/.exec(context)?.[1]
    return failed(fallbackReason(text(session?.engineError) ?? fromContext), { source: "fallback", ...(engine ? { engine } : {}) })
  }

  const specPath = specPathFor(stateDir, sessionId)
  const xml = await fs.readFile(specPath, "utf8").then(
    (content) => content.trim(),
    () => text(resultRecord?.xml)?.trim() ?? "",
  )
  if (!xml) return failed("the planner reported a plan but wrote no specification")

  const degraded = Array.isArray(session?.degraded) ? session.degraded.filter((item): item is string => typeof item === "string") : []
  const decisions = decisionsOf(session)
  const clarifications = clarificationsOf(session)
  const graphId = text(response.graphId) ?? text(view?.graphId)
  return {
    status: "ok",
    original,
    uplifted: `${xml}\n\n${GUIDANCE_LINE}`,
    source: "llm",
    ...(graphId ? { graphId } : {}),
    specPath,
    ...(Array.isArray(view?.nodes) ? { nodes: view.nodes.length } : {}),
    ...(Array.isArray(view?.waves) ? { waves: view.waves.length } : {}),
    ...(degraded.length ? { degraded } : {}),
    ...(decisions ? { decisions } : {}),
    ...(clarifications ? { clarifications } : {}),
    ...(engine ? { engine } : {}),
    elapsedMs,
  }
}

/**
 * One file per (run, node). The name carries a hash of the raw ids, so two ids
 * that sanitise to the same text never share a file, and no id can name a path.
 */
function storedPath(stateDir: string, runId: string, nodeId: string) {
  const hash = createHash("sha1").update(`${runId}\0${nodeId}`).digest("hex").slice(0, 12)
  return path.join(stateDir, "results", `${segment(runId)}~${segment(nodeId)}~${hash}.json`)
}

export async function loadStored(stateDir: string, runId: string, nodeId: string): Promise<Stored | undefined> {
  const value = await readJson(storedPath(stateDir, runId, nodeId))
  if (!isRecord(value) || !isRecord(value.result)) return undefined
  const result = value.result
  if (!["ok", "skipped", "failed"].includes(String(result.status)) || typeof result.original !== "string") return undefined
  return { attempt: typeof value.attempt === "number" ? value.attempt : 0, result: result as unknown as UpliftResult }
}

export async function saveStored(stateDir: string, runId: string, nodeId: string, stored: Stored) {
  await writeAtomic(storedPath(stateDir, runId, nodeId), `${JSON.stringify(stored)}\n`)
}
