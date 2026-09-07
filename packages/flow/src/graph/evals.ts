import type { LedgerRound } from "./ledger"
import type { Pipeline, RunLog } from "./types"
import { gauntletOf, isolationOf, modeOf } from "./types"

/**
 * A fixed set of canvases, run the same way each release, so "it got worse" is
 * a number rather than an impression.
 *
 * Goals 1, 3 and 6 of this project — runs for hours, does not degrade, no bugs
 * that cost quality — are all claims about behaviour over time, and nothing
 * here measured any of them. Every failure this fork has fixed was found by
 * running a mode once and reading the result afterwards, which finds the
 * failure that happened and says nothing about the ones that stopped happening.
 *
 * Two halves, because they cost very different things:
 *
 * - The **corpus** is a set of canvases checked in beside the code. Asserting
 *   that each one still passes preflight with exactly the warnings it is
 *   supposed to raise costs nothing, runs in CI, and catches the regression
 *   class where a change to `validate.ts` quietly makes a legal shape illegal
 *   or an illegal one legal.
 * - The **scorecard** is what a real run of one of those canvases produced:
 *   status, verdict, wall clock, spend, rounds, lines changed. Producing one
 *   costs real money, so it is recorded by hand from a run log rather than
 *   driven from a test — and `compareScores` is what turns two of them into
 *   "this release is slower, dearer, and its gauntlet needs two more rounds".
 *
 * Nothing here runs a model. The scorecard is read off `RunLog`, which already
 * carries every number this needs, and that is deliberate: an eval harness that
 * re-implemented the run would be measuring itself.
 */

/** One canvas in the corpus, with what it is supposed to exercise. */
export type EvalCase = {
  id: string
  /** What this canvas is in the corpus to catch, in one line. */
  covers: string
  pipeline: Pipeline
  /** Preflight warning kinds this canvas is *expected* to raise. */
  warns?: string[]
}

/**
 * What one run of a case produced, in the numbers worth comparing.
 *
 * Deliberately small. A scorecard that carried the transcript would be
 * unreadable as a diff, and the transcript is in the run log anyway — this is
 * the row of a table somebody scans to decide whether to look closer.
 */
export type Score = {
  id: string
  status: RunLog["status"]
  /** What the verifier or the gauntlet's critics decided, when anything did. */
  verdict?: "pass" | "fail" | "unreadable"
  /** Wall clock in seconds, and dollars, when the run could be priced. */
  seconds?: number
  cost?: number
  /** Cards that failed, by role — the shape of a failure matters more than the count. */
  failed: string[]
  /** Dispatch rounds, and how many of those changed nothing measurable. */
  rounds?: number
  stalled?: number
  /** Lines the whole run put into the tree and took out of it. */
  added?: number
  removed?: number
}

/**
 * A run log, reduced to the row that goes in the table.
 *
 * `cost` is absent rather than zero when nothing could be priced, following the
 * same rule as every other total in this codebase: an unpriced run is unknown,
 * not free, and a comparison that read it as zero would report every release
 * against an unpriced baseline as an improvement.
 */
export function scoreRun(id: string, log: RunLog): Score {
  const measured = log.nodes.filter((node) => node.diff)
  return {
    id,
    status: log.status,
    ...(log.verdict ? { verdict: log.verdict.kind } : {}),
    ...(log.started !== undefined && log.finished !== undefined
      ? { seconds: Math.round((log.finished - log.started) / 1000) }
      : {}),
    ...(log.usage?.steps && !log.usage.unpriced.length ? { cost: log.usage.cost } : {}),
    failed: log.nodes.filter((node) => node.status === "error").map((node) => node.role),
    ...(log.rounds?.length ? { rounds: log.rounds.length, stalled: unchanged(log.rounds) } : {}),
    ...(measured.length
      ? {
          added: measured.reduce((total, node) => total + (node.diff?.added ?? 0), 0),
          removed: measured.reduce((total, node) => total + (node.diff?.removed ?? 0), 0),
        }
      : {}),
  }
}

/** Rounds that moved no lines at all — the cheapest read on a run going in circles. */
function unchanged(rounds: LedgerRound[]) {
  return rounds.filter((round) => round.added !== undefined && !round.added && !round.removed).length
}

/** One thing that got worse, better, or merely moved, between two scorecards. */
export type Change = {
  id: string
  field: string
  was: string
  now: string
  /** Whether this is a regression, an improvement, or neither. */
  kind: "worse" | "better" | "changed"
}

/**
 * What changed between two scorecards.
 *
 * Direction is only claimed where it is real. A run that stopped passing is
 * worse and a run that started passing is better — those are not judgement
 * calls. Cost and wall clock only count past a threshold, because a gauntlet
 * that costs 3% more is noise from a provider's tokeniser and flagging it every
 * release trains whoever reads this to skip the column. Lines changed are
 * reported with **no direction at all**: more lines is not better work and
 * fewer is not tighter work, and the moment this file starts claiming otherwise
 * it is inventing a bar of its own.
 */
export function compareScores(before: Score[], after: Score[]): Change[] {
  const changes: Change[] = []
  for (const now of after) {
    const was = before.find((score) => score.id === now.id)
    if (!was) {
      changes.push({ id: now.id, field: "case", was: "not in the baseline", now: "new", kind: "changed" })
      continue
    }
    if (was.status !== now.status)
      changes.push({
        id: now.id,
        field: "status",
        was: was.status,
        now: now.status,
        kind: now.status === "done" ? "better" : "worse",
      })
    if ((was.verdict ?? "none") !== (now.verdict ?? "none"))
      changes.push({
        id: now.id,
        field: "verdict",
        was: was.verdict ?? "none",
        now: now.verdict ?? "none",
        kind: now.verdict === "pass" ? "better" : "worse",
      })
    if (was.failed.length !== now.failed.length)
      changes.push({
        id: now.id,
        field: "failed cards",
        was: String(was.failed.length),
        now: now.failed.length ? now.failed.join(", ") : "none",
        kind: now.failed.length > was.failed.length ? "worse" : "better",
      })
    for (const [field, a, b] of [
      ["cost", was.cost, now.cost],
      ["seconds", was.seconds, now.seconds],
      ["rounds", was.rounds, now.rounds],
    ] as const) {
      if (a === undefined || b === undefined || !moved(a, b)) continue
      changes.push({ id: now.id, field, was: String(a), now: String(b), kind: b > a ? "worse" : "better" })
    }
    if ((was.added ?? 0) !== (now.added ?? 0) || (was.removed ?? 0) !== (now.removed ?? 0))
      changes.push({
        id: now.id,
        field: "lines",
        was: `+${was.added ?? 0} −${was.removed ?? 0}`,
        now: `+${now.added ?? 0} −${now.removed ?? 0}`,
        kind: "changed",
      })
  }
  for (const was of before)
    if (!after.some((score) => score.id === was.id))
      changes.push({ id: was.id, field: "case", was: "in the baseline", now: "not run", kind: "changed" })
  return changes
}

/**
 * Whether two numbers differ by enough to be worth a line in the report.
 *
 * A tenth, or one whole unit, whichever is larger. The absolute floor is what
 * makes small counts work: two rounds against three is a real difference and
 * 10% of two is not.
 */
function moved(before: number, after: number) {
  return Math.abs(after - before) >= Math.max(1, before * 0.1)
}

/** The table, as text, because this is read in a terminal and pasted into a release note. */
export function report(changes: Change[]) {
  if (!changes.length) return "No case changed."
  const worse = changes.filter((change) => change.kind === "worse")
  const rest = changes.filter((change) => change.kind !== "worse")
  return [
    ...(worse.length ? [`${worse.length} regression${worse.length === 1 ? "" : "s"}:`] : []),
    ...worse.map((change) => `  ${change.id} · ${change.field}: ${change.was} -> ${change.now}`),
    ...(rest.length ? [`${rest.length} other change${rest.length === 1 ? "" : "s"}:`] : []),
    ...rest.map((change) => `  ${change.id} · ${change.field}: ${change.was} -> ${change.now}`),
  ].join("\n")
}

/** What a canvas is, in the one line a corpus listing shows. */
export function shapeOf(pipeline: Pipeline) {
  const mode = modeOf(pipeline)
  return [
    mode,
    ...(gauntletOf(pipeline) ? ["gauntlet"] : []),
    ...(isolationOf(pipeline) ? ["isolated"] : []),
    ...(pipeline.verify ? ["verified"] : []),
    `${pipeline.nodes.length} cards`,
  ].join(" · ")
}
