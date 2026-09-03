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
  return {
    value: entry.id,
    label: runTime(entry.started, now),
    hint: runHint(entry),
    // `done` is the expected ending and every row would carry it. The pill is
    // spent on the endings worth picking out of the list instead.
    ...(entry.status && entry.status !== "done" ? { tag: entry.status } : {}),
    group: entry.pipeline === current ? "This canvas" : "Other canvases",
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

/** Menu values that act rather than open a recording. Run ids are uuids, so neither can collide. */
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
  const opened = open ? entries.find((entry) => entry.id === open) : undefined
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

function runHint(entry: RunEntry) {
  const parts: string[] = []
  if (entry.pipeline) parts.push(entry.pipeline)
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
