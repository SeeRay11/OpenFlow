import type { RunLog } from "../graph/types"
import { plainText } from "../graph/worktree"
import type { SelectOption } from "../ui/select"
import type { RunEntry } from "./store"
import { costLabel } from "./usage"

/**
 * A recorded run as one row of the Runs menu.
 *
 * The id is a uuid, so a list keyed on it is a wall of identical rows: every
 * run of this project looked alike whatever it cost or however long it took.
 * What tells two runs apart is when it ran, how long it took, how much it
 * spent and whether it finished — all of it already in the listing index, none
 * of it rendered. The id stays reachable through the menu's own search, which
 * matches `value` as well as the text.
 *
 * Nothing here invents a number it does not have. A run with no usage predates
 * cost tracking or never billed a step, and shows no money rather than `$0`;
 * one with no `finished` shows no duration rather than counting up to now,
 * because a run abandoned by a closed tab is not still running.
 */
export function runOption(entry: RunEntry, current: string, now = Date.now()): SelectOption {
  const mine = entry.pipeline === current
  return {
    value: entry.id,
    label: runTime(entry.started, now),
    // The canvas name is dropped from its own group's rows: the heading above
    // them already says it, and the hint is ellipsised at half the row, so a
    // repeated name is paid for by pushing the cost off the end.
    hint: runHint(entry, mine),
    // `done` is the expected ending and every row would carry it. The pill is
    // spent on the endings worth picking out of the list instead.
    ...(entry.status && entry.status !== "done" ? { tag: entry.status } : {}),
    group: mine ? "This canvas" : "Other canvases",
    title: entry.id,
  }
}

/**
 * Rows for the Runs menu, current canvas first.
 *
 * The listing arrives newest first and stays that way inside each group; the
 * groups themselves are ordered by the order rows are first seen, so the
 * current canvas has to lead the array to lead the menu.
 */
export function runOptions(entries: RunEntry[], current: string, now = Date.now()): SelectOption[] {
  return [
    ...entries.filter((entry) => entry.pipeline === current),
    ...entries.filter((entry) => entry.pipeline !== current),
  ].map((entry) => runOption(entry, current, now))
}

/**
 * The listing row for a run id, matched the way the store matches it.
 *
 * A run is addressed by its *filename*, and the id inside the log is not
 * always the same string: logs on disk carry `run-<ISO>` with the timestamp's
 * `T` and `Z` in caps while the file that holds them is lower case, so
 * `log.id === entry.id` is false for every run recorded that way. Comparing
 * case-insensitively is what lets an open recording find itself in the list —
 * and, more to the point, what makes a delete address a file that exists.
 */
export function findRun(entries: RunEntry[], id: string | undefined) {
  if (!id) return undefined
  const wanted = id.toLowerCase()
  return entries.find((entry) => entry.id.toLowerCase() === wanted)
}

/** Menu values that act rather than open a recording. A run id always starts `run-`, so neither can collide. */
export const RUN_DELETE = "action:delete"
export const RUN_PRUNE = "action:prune"

/**
 * How old a run has to be before the prune row offers to delete it.
 *
 * A month is past the point where a log is being compared against anything and
 * still long enough that a run someone meant to come back to is not swept up
 * by a menu row they clicked once.
 */
export const PRUNE_DAYS = 30

/**
 * The whole Runs menu: the recordings, then what can be done to them.
 *
 * The actions live at the bottom of the same menu because that is the only
 * place a run is already the subject — there is nowhere else in the UI a
 * recording is named. Both are disabled rather than hidden when they would do
 * nothing, so the menu does not change shape between openings.
 */
export function runMenuOptions(entries: RunEntry[], current: string, open?: string, now = Date.now()): SelectOption[] {
  const opened = findRun(entries, open)
  const stale = entries.filter(
    (entry) => entry.status !== "running" && (entry.started ?? 0) < now - PRUNE_DAYS * 86_400_000,
  ).length
  return [
    ...runOptions(entries, current, now),
    {
      value: RUN_DELETE,
      label: "Delete this run",
      hint: opened ? runTime(opened.started, now) : "no run open",
      group: "Manage",
      disabled: !opened,
      title: opened ? `permanently delete ${opened.id}` : "open a run first",
    },
    {
      value: RUN_PRUNE,
      label: `Delete runs older than ${PRUNE_DAYS} days`,
      hint: stale ? `${stale} run${stale === 1 ? "" : "s"}` : "nothing that old",
      group: "Manage",
      disabled: !stale,
      title: "runs still marked running are never pruned — they are the ones that can be resumed",
    },
  ]
}

function runHint(entry: RunEntry, mine: boolean) {
  const parts: string[] = []
  if (entry.pipeline && !mine) parts.push(entry.pipeline)
  if (entry.nodes) parts.push(`${entry.nodes} card${entry.nodes === 1 ? "" : "s"}`)
  const elapsed = runDuration(entry)
  if (elapsed) parts.push(elapsed)
  // Steps, not cost, decides whether there is anything to report: a priced run
  // that genuinely cost nothing is not the same as a run that measured nothing.
  if (entry.usage?.steps) parts.push(costLabel(entry.usage))
  return parts.join(" · ")
}

/** Wall clock the run took, once it has an ending to measure to. */
export function runDuration(entry: RunEntry) {
  if (!entry.started || !entry.finished) return ""
  const seconds = Math.max(0, Math.round((entry.finished - entry.started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * When the run started, at the shortest length that still places it.
 *
 * Today's runs are the ones a user is comparing against each other, so those
 * get the clock alone; anything older carries the date it needs to be told
 * apart, and a run from another year carries that too.
 */
export function runTime(started: number | undefined, now = Date.now()) {
  if (!started) return "unknown time"
  const at = new Date(started)
  const today = new Date(now)
  const clock = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (at.toDateString() === today.toDateString()) return clock
  const day = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  })
  return `${day}, ${clock}`
}

/**
 * How long a `running` log may go unwritten before it counts as abandoned.
 *
 * A live run rewrites its log on every change and on a 30 s heartbeat, and a hidden
 * tab's timers are throttled to about a minute, so five minutes of silence means the
 * page that owned the run is gone rather than busy.
 */
export const RESUME_STALE_MS = 5 * 60_000

/** How far ahead of the clock a log's timestamp may be before it is not a clock difference between two machines any more. */
const CLOCK_SKEW_MS = RESUME_STALE_MS

type Stamped = { status?: string; updatedAt?: number; finished?: number; started?: number }

/** A timestamp from the future cannot belong to a page that is writing the log now: it is a copied, edited or hostile file. */
function implausible(run: Stamped, now: number) {
  return (run.updatedAt ?? 0) > now + CLOCK_SKEW_MS || (run.started ?? 0) > now + CLOCK_SKEW_MS
}

/** Whether a log still marked `running` has gone quiet: its page is gone, so it can be resumed. */
export function abandoned(run: Stamped, now = Date.now()) {
  if (run.status !== "running") return false
  // Never "still being written": that is what would let such a log hide the run that really was interrupted.
  if (implausible(run, now)) return true
  // A log from before `updatedAt` existed is judged by the last time it said anything at all.
  const last = run.updatedAt ?? run.finished ?? run.started ?? 0
  return now - last >= RESUME_STALE_MS
}

/**
 * The newest run of this canvas that never reached an end state, when it is
 * abandoned. A newer run that is still being written (another tab is running it)
 * hides every older one: resuming under it would run the same cards twice. A log
 * with a timestamp from the future ranks below every plausible one, so it cannot
 * take the place of the run that was really interrupted.
 */
export function interrupted(entries: RunEntry[], pipeline: string, now = Date.now()) {
  const newest = entries
    .filter((entry) => entry.status === "running" && entry.pipeline === pipeline)
    .sort((a, b) => Number(implausible(a, now)) - Number(implausible(b, now)) || (b.started ?? 0) - (a.started ?? 0))[0]
  return newest && abandoned(newest, now) ? newest : undefined
}

/** The longest output a resumed card may bring back from a log: the biggest answer a card is expected to give, with room to spare. */
export const MAX_RESUMED_OUTPUT = 1_000_000
/** The longest session id taken from a log. The host's own ids are a dozen characters. */
const MAX_SESSION_ID = 200

/**
 * What a log offered for resuming gives back: the answers of the cards that finished, and the sessions of the
 * ones that did not. It is read from a file in the project, so each value is checked as it is taken:
 * an output must be a string of a sane length (else that card counts as not finished), a session id a
 * non-empty string without control characters (else it is not carried). A log whose own `id` is not the
 * id it was opened under is refused: closing it afterwards would overwrite whichever run that id names.
 * The list id is the lower-cased file name and the log's own id is mixed-case, so they are compared ignoring case.
 */
export function resumePlan(id: string, log: RunLog, isLegacy: (sessionID: string) => boolean) {
  if (typeof log.id !== "string" || log.id.toLowerCase() !== id.toLowerCase())
    return { ok: false as const, reason: `run ${id} cannot be resumed: the log inside it is named ${plainText(log.id)}, not ${plainText(id)}` }
  if (!Array.isArray(log.nodes)) return { ok: false as const, reason: `run ${id} cannot be resumed: its log has no cards` }
  const outputs: Record<string, string> = {}
  const sessions: Record<string, string> = {}
  const fresh: string[] = []
  for (const node of log.nodes) {
    if (typeof node !== "object" || node === null || typeof node.id !== "string") continue
    if (node.status === "done" && typeof node.output === "string" && node.output.length <= MAX_RESUMED_OUTPUT) {
      outputs[node.id] = node.output
      continue
    }
    const session = node.sessionID
    if (typeof session !== "string" || !session || session.length > MAX_SESSION_ID || /[\u0000-\u001f\u007f-\u009f]/.test(session)) continue
    // A session the earlier build opened lives in a process this one cannot attach to.
    if (isLegacy(session)) fresh.push(plainText(node.role))
    else sessions[node.id] = session
  }
  return { ok: true as const, outputs, sessions, fresh }
}

/**
 * The run to offer for resuming, judged on a list that was read recently.
 *
 * `interrupted` only knows what the list says: a snapshot older than the staleness
 * window cannot tell a run another tab stopped writing from one it is still writing,
 * so it offers nothing. The page re-reads the list on a tick, which keeps the snapshot
 * younger than the window whenever the tab is visible and idle.
 */
export function offerable(entries: RunEntry[], pipeline: string, fetchedAt: number, now = Date.now()) {
  if (now - fetchedAt >= RESUME_STALE_MS) return undefined
  return interrupted(entries, pipeline, now)
}

/**
 * The old log of a resumed run, closed: the new run carries on from it, so it is
 * no longer interrupted and must not be offered for resuming again. Cards it left
 * working are marked stopped, as the engine does at the end of a run of its own.
 */
export function superseded(log: RunLog, by: string, now = Date.now()): RunLog {
  return {
    ...log,
    status: "stopped",
    resumedBy: by,
    finished: log.finished ?? log.updatedAt ?? now,
    nodes: log.nodes.map((node) =>
      node.status === "queued" || node.status === "running" ? { ...node, status: "stopped" } : node,
    ),
  }
}
