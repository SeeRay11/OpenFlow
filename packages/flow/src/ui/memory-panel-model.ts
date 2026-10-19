import type { MemoryEntriesResult, MemoryEntryRow, MemoryForgetResult, MemoryStatus } from "../../shared/memory"
import type { ClientResult } from "../server/memory-client"
import type { StatusTone } from "./omp-settings-model"

/**
 * Everything the memory panel and the settings dialog's memory line decide,
 * without Solid: what a status says, how a listing becomes one of a handful of
 * view states, what the forget outcome announces. The components only bind these.
 */

export type MemoryHealth = "ready" | "unavailable" | "disabled"

/** Reachability only counts when memory is on; a host that never answered is the caller's `error` state, not this. */
export function memoryHealth(status: MemoryStatus): MemoryHealth {
  if (!status.enabled) return "disabled"
  return status.reachable ? "ready" : "unavailable"
}

/** One line for the settings dialog's Status tab. */
export function memoryLine(status: MemoryStatus): string {
  const health = memoryHealth(status)
  if (health === "disabled") return "Shared memory is off: cards run without it."
  if (health === "ready") return `Shared memory is reachable${status.url ? ` at ${status.url}` : ""}.`
  const reason = status.problems[0] ?? "Substrate did not answer."
  return `Shared memory is unavailable: ${reason} Cards run without it.`
}

export type MemoryLineView = { tone: StatusTone; text: string }

/**
 * The Status tab's memory line from a status fetch. Memory off or unreachable is
 * not an error (cards run without it); only a host that never answered is.
 */
export function memoryLineView(result: ClientResult<MemoryStatus> | undefined): MemoryLineView {
  if (!result) return { tone: "pending", text: "Checking shared memory…" }
  if (!result.ok) return { tone: "error", text: `Shared memory could not be checked: ${result.error}` }
  return { tone: memoryHealth(result.value) === "unavailable" ? "warning" : "ok", text: memoryLine(result.value) }
}

export type FactRow = { label: string; value: string; ok: boolean }

const TTL_LABEL: Record<MemoryStatus["retention"]["ttl"], string> = {
  graph: "for the graph they belong to",
  "30d": "30 days",
  permanent: "permanently",
}

export function statusFacts(status: MemoryStatus): FactRow[] {
  const rows: FactRow[] = [{ label: "Shared memory", value: status.enabled ? "on" : "off", ok: true }]
  if (!status.enabled) return rows
  const where = status.url ? ` at ${status.url}` : ""
  rows.push(
    { label: "Substrate", value: status.reachable ? `reachable${where}` : `not reachable${where}`, ok: status.reachable },
    { label: "Surface", value: status.surface, ok: true },
    { label: "Project", value: status.project || "not resolved", ok: Boolean(status.project) },
    { label: "Keep memories", value: TTL_LABEL[status.retention.ttl], ok: true },
  )
  return rows
}

/** What the confirm step says before anything is retracted: the plain version of the retention note. */
export const FORGET_WARNING =
  "Forget writes a retraction marker for each entry and stops every card from reading them. Substrate cannot delete data: the entries stay there until their ttl lapses."

// ------------------------------------------------------------------ listing

export type EntryView = {
  key: string
  scope: string
  subject: string
  age: string
  preview: string
  retracted: boolean
}

export type ListView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "disabled" }
  | { kind: "unavailable"; message: string }
  | { kind: "empty" }
  | { kind: "rows"; rows: EntryView[] }

export function ageText(days: number | undefined): string {
  if (days === undefined) return "age unknown"
  if (days < 1) return "today"
  const whole = Math.floor(days)
  return whole === 1 ? "1 day ago" : `${whole} days ago`
}

export function entryView(row: MemoryEntryRow): EntryView {
  return {
    key: row.id,
    scope: row.scope,
    subject: row.subject,
    age: ageText(row.ageDays),
    preview: row.preview,
    retracted: row.retracted,
  }
}

/** `undefined` is a request in flight. */
export function listView(result: ClientResult<MemoryEntriesResult> | undefined): ListView {
  if (!result) return { kind: "loading" }
  if (!result.ok) return { kind: "error", message: result.error }
  const listing = result.value
  if (listing.status === "disabled") return { kind: "disabled" }
  if (listing.status === "unavailable") {
    return { kind: "unavailable", message: listing.error ?? "Substrate did not answer." }
  }
  if (listing.status === "empty" || listing.items.length === 0) return { kind: "empty" }
  return { kind: "rows", rows: listing.items.map(entryView) }
}

/** The polite announcement after a refresh. */
export function listSummary(view: ListView, pipeline: string): string {
  switch (view.kind) {
    case "loading":
      return "Loading memory entries…"
    case "error":
    case "unavailable":
      return view.message
    case "disabled":
      return "Shared memory is off."
    case "empty":
      return `No memory entries for ${pipeline} yet.`
    case "rows": {
      const retracted = view.rows.filter((row) => row.retracted).length
      const base = `${view.rows.length} ${view.rows.length === 1 ? "entry" : "entries"} for ${pipeline}`
      return retracted ? `${base}, ${retracted} retracted.` : `${base}.`
    }
  }
}

// ------------------------------------------------------------------- forget

export type ForgetStep = "idle" | "confirm" | "running"

export type ForgetOutcome = { ok: boolean; text: string }

export function forgetOutcome(result: ClientResult<MemoryForgetResult>): ForgetOutcome {
  if (!result.ok) return { ok: false, text: result.error }
  const forgotten = result.value
  if (forgotten.status === "disabled") return { ok: false, text: "Shared memory is off, so there is nothing to forget." }
  if (forgotten.status === "unavailable") {
    return { ok: false, text: forgotten.error ?? "Substrate did not answer, so nothing was retracted." }
  }
  const count = `${forgotten.retracted} ${forgotten.retracted === 1 ? "subject" : "subjects"} retracted`
  // A partial retraction still succeeded on this host; the host's sentence says what did not reach Substrate.
  return forgotten.error ? { ok: false, text: `${count}. ${forgotten.error}` } : { ok: true, text: `${count}.` }
}
