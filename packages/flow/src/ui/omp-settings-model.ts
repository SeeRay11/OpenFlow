import {
  DEFAULT_OMP_SETTINGS,
  type OmpAuthImportResult,
  type OmpConfigEntry,
  type OmpProblem,
  type OmpSettings,
  type OmpSettingsPatch,
  type OmpSettingsView,
  type OmpStatusView,
  type ValidationError,
} from "../../shared/omp"
import { SWARM_MODES, type SwarmPreflight, type SwarmProblem } from "../../shared/swarm"
import type { ClientResult } from "../server/memory-client"
import type { OmpResult } from "../server/omp-config"

/**
 * Everything the Omp settings dialog decides, without Solid: which fields exist,
 * what a draft differs by, how a server error maps onto a field, how the option
 * list is searched and grouped, what each key press does. The component only
 * binds these to elements.
 */

export type DraftValue = string | boolean
/** One entry per settings leaf, keyed by dotted path. Numbers stay text so a half-typed value is not rewritten under the cursor. */
export type Draft = Record<string, DraftValue>

export type FieldKind = "toggle" | "text" | "number" | "choice"

export type Field = {
  path: string
  label: string
  kind: FieldKind
  hint?: string
  placeholder?: string
  choices?: Array<{ value: string; label: string }>
}

export type Section = { id: string; title: string; fields: Field[] }

export const SECTIONS: Section[] = [
  {
    id: "omp",
    title: "Omp",
    fields: [
      { path: "binary", label: "Binary", kind: "text", placeholder: "omp from PATH", hint: "Absolute path of the omp executable." },
      {
        path: "profile",
        label: "Profile",
        kind: "text",
        placeholder: "openflow",
        hint: "Isolated omp profile (its own credentials, config and sessions). Empty uses omp's default profile.",
      },
      {
        path: "loadUserExtensions",
        label: "Load my omp extensions and plugins in cards",
        kind: "toggle",
        hint: "Off runs cards with --no-extensions.",
      },
      {
        path: "manualApproval",
        label: "Manual approval mode",
        kind: "choice",
        hint: "What a card asks about when a run uses manual approvals.",
        choices: [
          { value: "write", label: "Ask before writes and commands" },
          { value: "always-ask", label: "Ask before everything" },
        ],
      },
      { path: "maxSessionMinutes", label: "Longest card session (minutes)", kind: "number", hint: "1 to 1440." },
    ],
  },
  {
    id: "uplift",
    title: "Prompt uplift",
    fields: [
      { path: "uplift.enabled", label: "Uplift each card's task before it runs", kind: "toggle" },
      { path: "uplift.timeoutMs", label: "Planner time limit (ms)", kind: "number", hint: "10000 to 1800000." },
      {
        path: "uplift.hitl",
        label: "Let the planner ask clarifying questions",
        kind: "toggle",
        hint: "One more model call; cards run unattended.",
      },
      {
        path: "uplift.root",
        label: "claude-ultrathink location",
        kind: "text",
        placeholder: "omp's plugin directory",
        hint: "Absolute path of a directory containing bin/run-bun.",
      },
    ],
  },
  {
    id: "memory",
    title: "Shared memory",
    fields: [
      { path: "memory.enabled", label: "Share memory across the cards of a run", kind: "toggle" },
      {
        path: "memory.ttl",
        label: "Keep memories",
        kind: "choice",
        choices: [
          { value: "graph", label: "For this graph" },
          { value: "30d", label: "30 days" },
          { value: "permanent", label: "Permanently" },
        ],
      },
      { path: "memory.readLimit", label: "Most memories per card", kind: "number", hint: "0 to 50." },
      {
        path: "memory.repo",
        label: "Repository scope",
        kind: "text",
        placeholder: "owner/name",
        hint: "Empty derives it from the project's git remote.",
      },
      {
        path: "substrate.url",
        label: "Substrate URL",
        kind: "text",
        placeholder: "http://127.0.0.1:8787",
        hint: "No credentials in the URL: the token comes from the host environment.",
      },
    ],
  },
  {
    id: "swarm",
    title: "Agent swarm",
    fields: [
      {
        path: "swarm.mode",
        label: "Swarm",
        kind: "choice",
        choices: SWARM_MODES.map((mode) => ({
          value: mode,
          label: mode === "off" ? "Off" : mode === "auto" ? "Auto (the swarm decides)" : "Always hand the work to the swarm",
        })),
      },
      {
        path: "swarm.root",
        label: "agent-swarm location",
        kind: "text",
        hint: "Absolute path of a directory containing omp/package.json.",
      },
    ],
  },
]

export const FIELDS: Field[] = SECTIONS.flatMap((section) => section.fields)

const FIELD_BY_PATH = new Map(FIELDS.map((field) => [field.path, field]))

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Dotted path -> leaf value, in declaration order. */
function leaves(value: Record<string, unknown>, prefix = ""): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, child]) =>
    isObject(child) ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child] as [string, unknown]],
  )
}

const NUMERIC = new Set(leaves(DEFAULT_OMP_SETTINGS).filter(([, value]) => typeof value === "number").map(([path]) => path))

export function toDraft(settings: OmpSettings): Draft {
  const draft: Draft = {}
  for (const [path, value] of leaves(settings as unknown as Record<string, unknown>))
    draft[path] = typeof value === "number" ? String(value) : (value as DraftValue)
  return draft
}

function normalise(value: DraftValue | undefined): DraftValue {
  return typeof value === "string" ? value.trim() : (value ?? "")
}

/** Paths whose draft differs from what is saved. Surrounding whitespace is not a difference: it is trimmed on save. */
export function dirtyPaths(saved: OmpSettings, draft: Draft): string[] {
  const base = toDraft(saved)
  return Object.keys(base).filter((path) => normalise(draft[path]) !== normalise(base[path]))
}

/**
 * The patch the server should receive, or the numeric fields that are not
 * numbers. Only changed leaves are sent, so a field left alone cannot overwrite
 * a value another tab saved meanwhile.
 */
export function buildPatch(saved: OmpSettings, draft: Draft): { patch: OmpSettingsPatch; errors: ValidationError[] } {
  const patch: Record<string, unknown> = {}
  const errors: ValidationError[] = []
  for (const path of dirtyPaths(saved, draft)) {
    const raw = normalise(draft[path])
    let value: unknown = raw
    if (NUMERIC.has(path)) {
      const parsed = raw === "" ? Number.NaN : Number(raw)
      if (!Number.isFinite(parsed)) {
        errors.push({ path, message: "Enter a number." })
        continue
      }
      value = parsed
    }
    const parts = path.split(".")
    let target = patch
    for (const part of parts.slice(0, -1)) {
      const next = isObject(target[part]) ? (target[part] as Record<string, unknown>) : {}
      target[part] = next
      target = next
    }
    target[parts.at(-1)!] = value
  }
  return { patch: patch as OmpSettingsPatch, errors }
}

/** Server and client errors by field path; several messages for one field are joined. */
export function errorMap(errors: ValidationError[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const error of errors) {
    if (!error.path || !FIELD_BY_PATH.has(error.path)) continue
    map[error.path] = map[error.path] ? `${map[error.path]} ${error.message}` : error.message
  }
  return map
}

/** Errors that belong to no field of the form (a host failure, an unknown path), for the form-level alert. */
export function formErrors(errors: ValidationError[]): string[] {
  return errors.filter((error) => !error.path || !FIELD_BY_PATH.has(error.path)).map((error) => error.message)
}

export const fieldId = (path: string) => `omp-setting-${path.replaceAll(".", "-")}`
export const errorId = (path: string) => `${fieldId(path)}-error`
export const hintId = (path: string) => `${fieldId(path)}-hint`

/** The `aria-describedby` value for a field: its error first, then its hint. */
export function describedBy(field: Field, error: string | undefined): string | undefined {
  const ids = [error ? errorId(field.path) : undefined, field.hint ? hintId(field.path) : undefined].filter(Boolean)
  return ids.length ? ids.join(" ") : undefined
}

const DEFAULT_TEXT: Record<string, string> = {
  binary: "omp from PATH",
  profile: "omp's default profile",
  "uplift.root": "omp's plugin directory",
  "swarm.root": "no checkout configured",
  "substrate.url": "no URL configured",
}

export type EffectiveLine = { path: string; label: string; text: string; origin: "settings" | "env" | "default" }

/** One readable line per value an environment variable can stand in for. Names of variables only, never their values. */
export function effectiveLines(view: Pick<OmpSettingsView, "effective">): EffectiveLine[] {
  return Object.entries(view.effective).map(([path, source]) => {
    const label = FIELD_BY_PATH.get(path)?.label ?? path
    if (source.from === "settings") return { path, label, text: "set here", origin: source.from }
    if (source.from === "env") return { path, label, text: `from $${source.env}`, origin: source.from }
    return { path, label, text: `using ${DEFAULT_TEXT[path] ?? "the default"}`, origin: source.from }
  })
}

// ---------------------------------------------------------------- omp options

export const UNGROUPED = "other"

export type EntryGroup = { group: string; entries: OmpConfigEntry[] }

export type EntryInput = "toggle" | "choice" | "number" | "text" | "readonly"

export function entryInput(entry: OmpConfigEntry): EntryInput {
  if (!entry.editable) return "readonly"
  if (entry.type === "boolean") return "toggle"
  if (entry.type === "number") return "number"
  if (entry.type === "enum" && entry.options?.length) return "choice"
  return "text"
}

/** Every word of the query must appear in the key, the description or the category. Order of the list is kept. */
export function searchEntries(entries: OmpConfigEntry[], query: string): OmpConfigEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return entries
  return entries.filter((entry) => {
    const haystack = `${entry.key} ${entry.description} ${entry.group ?? ""}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Groups in the order omp lists them, entries by key, entries with no category last. */
export function groupEntries(entries: OmpConfigEntry[]): EntryGroup[] {
  const groups = new Map<string, OmpConfigEntry[]>()
  for (const entry of entries) {
    const name = entry.group ?? UNGROUPED
    groups.set(name, [...(groups.get(name) ?? []), entry])
  }
  const named = [...groups].filter(([name]) => name !== UNGROUPED)
  const loose = groups.get(UNGROUPED)
  const ordered = loose ? [...named, [UNGROUPED, loose] as [string, OmpConfigEntry[]]] : named
  return ordered.map(([group, items]) => ({ group, entries: [...items].sort((a, b) => a.key.localeCompare(b.key)) }))
}

/** What an input starts with for this entry. Booleans stay booleans; everything else is text. */
export function entryDraft(entry: OmpConfigEntry): DraftValue {
  if (entry.type === "boolean") return entry.value === true
  if (entry.value === undefined || entry.value === null) return ""
  return String(entry.value)
}

export type ParsedEntry = { ok: true; value: unknown } | { ok: false; message: string }

/** The value to send for a draft, checked the way the host checks it so the user hears about a mistake before the round trip. */
export function parseEntry(entry: OmpConfigEntry, draft: DraftValue): ParsedEntry {
  if (entry.type === "boolean") return { ok: true, value: draft === true }
  const text = typeof draft === "string" ? draft : String(draft)
  if (entry.type === "number") {
    const parsed = text.trim() === "" ? Number.NaN : Number(text)
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, message: "Enter a number." }
  }
  if (entry.type === "enum" && entry.options?.length && !entry.options.includes(text))
    return { ok: false, message: `Choose one of ${entry.options.join(", ")}.` }
  return { ok: true, value: text }
}

export function entryDirty(entry: OmpConfigEntry, draft: DraftValue): boolean {
  if (entry.type === "boolean") return draft !== (entry.value === true)
  if (entry.type === "number") {
    const parsed = parseEntry(entry, draft)
    return !parsed.ok || parsed.value !== entry.value
  }
  return draft !== entryDraft(entry)
}

/** Text for an entry the dialog does not edit as a scalar, or for a value shown beside its input. */
export function displayValue(entry: OmpConfigEntry): string {
  if (entry.redacted) return "set"
  if (entry.value === undefined || entry.value === null) return "not set"
  if (entry.value === "") return "empty"
  const text = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)
  return text.length > 140 ? `${text.slice(0, 137)}...` : text
}

export function readOnlyReason(entry: OmpConfigEntry): string {
  if (entry.type === "array" || entry.type === "record") return "Lists and maps are edited in the terminal."
  return "Credentials are set in the terminal."
}

// -------------------------------------------------------------------- status

export type ProblemAction = "terminal" | "settings"

/** What the dialog offers next to a problem: the terminal for omp-side fixes, the Cards tab for OpenFlow-side ones. */
export function problemActions(problem: OmpProblem): ProblemAction[] {
  switch (problem.code) {
    case "missing":
      return ["settings"]
    case "version":
    case "no-credentials":
    case "no-models":
      return ["terminal"]
    case "spawn":
    case "profile":
      return ["settings", "terminal"]
  }
}

/** Whether a problem card already offers the terminal, so the status actions row need not repeat the button. */
export function problemsOfferTerminal(problems: OmpProblem[]): boolean {
  return problems.some((problem) => problemActions(problem).includes("terminal"))
}

// ------------------------------------------------------------ copy logins

export type CopyStep = "idle" | "confirm" | "running"

export const COPY_LOGINS_LABEL = "Copy logins from your default profile"

export const COPY_LOGINS_WARNING =
  "This copies the API keys and logins stored in your default omp profile into the OpenFlow profile on this machine. Nothing is removed from the default profile."

/** Only a named profile can receive logins, and only a profile with none is missing them. */
export function canCopyLogins(status: OmpStatusView, problem: OmpProblem): boolean {
  return problem.code === "no-credentials" && status.profile !== ""
}

export type CopyOutcome = { ok: boolean; text: string }

/** The sentence for the live region: the count on success, the host's own sentence otherwise. */
export function copyLoginsOutcome(result: OmpResult<OmpAuthImportResult>): CopyOutcome {
  if (!result.ok) return { ok: false, text: result.errors.map((error) => error.message).join(" ") }
  return { ok: true, text: `Copied ${result.value.imported} ${result.value.imported === 1 ? "login" : "logins"}.` }
}

export type StatusRow = { label: string; value: string; ok: boolean }

export function statusRows(status: OmpStatusView): StatusRow[] {
  const rows: StatusRow[] = [
    { label: "omp binary", value: status.binary ?? "not found", ok: Boolean(status.binary) },
    {
      label: "Version",
      value: status.version ? `${status.version} (needs ${status.minVersion} or newer)` : "unknown",
      ok: status.available,
    },
    { label: "Profile", value: status.profile || "default", ok: true },
    { label: "Config directory", value: status.configDir ?? "unknown", ok: Boolean(status.configDir) },
  ]
  if (status.providers) {
    rows.push({
      label: "Providers",
      value: `${status.providers.authenticated} of ${status.providers.total} authenticated`,
      ok: status.providers.authenticated > 0,
    })
  }
  return rows
}

/** The sentence announced politely whenever the status changes. */
export function statusSummary(status: OmpStatusView): string {
  if (!status.problems.length) return status.version ? `omp ${status.version} is ready.` : "omp is ready."
  return `${status.problems.length} problem${status.problems.length === 1 ? "" : "s"} to fix.`
}

// -------------------------------------------------------- swarm preflight

/** `warning` is a degradation the user chose to live with (cards still run); `error` is a check that could not be made. */
export type StatusTone = "pending" | "ok" | "warning" | "error"

export type SwarmView = { tone: StatusTone; text: string; problems: SwarmProblem[] }

/** What the Status tab says about the configured swarm mode. A degraded swarm is a warning: the card runs, without the swarm. */
export function swarmView(result: ClientResult<SwarmPreflight> | undefined): SwarmView {
  if (!result) return { tone: "pending", text: "Checking the swarm…", problems: [] }
  if (!result.ok) return { tone: "error", text: `The swarm check failed: ${result.error}`, problems: [] }
  const check = result.value
  if (check.requested === "off") return { tone: "ok", text: "Swarm is off: cards run without it.", problems: check.problems }
  if (check.ok && check.effective === check.requested) {
    return { tone: "ok", text: `Swarm is ready in ${check.requested} mode.`, problems: check.problems }
  }
  const text =
    check.effective === "off"
      ? `Swarm degraded to off: ${check.requested} mode cannot run yet, so cards run without it.`
      : `Swarm is running as ${check.effective} instead of ${check.requested}.`
  return { tone: "warning", text, problems: check.problems }
}

// ------------------------------------------------------------- remote state

export type Remote<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string }
  | { state: "disconnected"; message: string }

export function remoteFrom<T>(result: OmpResult<T>): Remote<T> {
  if (result.ok) return { state: "ready", value: result.value }
  const message = result.errors.map((error) => error.message).join(" ")
  return result.status === 0 ? { state: "disconnected", message } : { state: "error", message }
}

// ---------------------------------------------------------------- keyboard

export type Tab = "status" | "cards" | "memory" | "options"

export const TABS: Array<{ id: Tab; label: string }> = [
  { id: "status", label: "Status" },
  { id: "cards", label: "Cards" },
  { id: "memory", label: "Memory" },
  { id: "options", label: "Omp options" },
]

/** Escape goes back one level: leave an edit, then clear the search, then close the dialog. */
export function escapeStep(state: { editing: boolean; query: string }): "cancel-edit" | "clear-search" | "close" {
  if (state.editing) return "cancel-edit"
  if (state.query) return "clear-search"
  return "close"
}

/**
 * Where Tab must be sent so focus never leaves the dialog: `index` is the
 * focused element's position among the dialog's focusable elements (-1 when
 * focus is outside them). `undefined` means the browser's own move stays inside.
 */
export function trapTarget(index: number, count: number, backwards: boolean): number | undefined {
  if (count === 0) return undefined
  if (index < 0) return backwards ? count - 1 : 0
  if (backwards && index === 0) return count - 1
  if (!backwards && index === count - 1) return 0
  return undefined
}

/** Arrow / Home / End moves between tabs, wrapping at the ends. */
export function tabTarget(index: number, count: number, key: string): number | undefined {
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "ArrowLeft") return (index - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return undefined
}
