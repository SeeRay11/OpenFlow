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
export function runOption(entry: RunEntry, current: string, now = Date.now()) {
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
export function runOptions(entries: RunEntry[], current: string, now = Date.now()) {
  return [
    ...entries.filter((entry) => entry.pipeline === current),
    ...entries.filter((entry) => entry.pipeline !== current),
  ].map((entry) => runOption(entry, current, now))
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
