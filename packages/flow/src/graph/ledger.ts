import { verdictIn } from "./verdict"

/**
 * What each round of an orchestration actually did, kept so the next round can
 * be told.
 *
 * Two failures share one cause, and this is the record both were missing. The
 * first is repetition: an orchestrator re-dispatches an approach a critic
 * already rejected, because nothing between rounds carries what was tried — the
 * cards' answers are in the prompt, but the *outcome* of the round is not.
 * The second is the stall check, which compared the dispatched batch to the
 * previous one as an exact string: a task reworded by a single word read as
 * fresh work, and a run could hand out the same job indefinitely as long as it
 * phrased it differently each time.
 *
 * So the ledger records what changed rather than what was said. A round that
 * moved no lines, dispatched the same cards, produced the same outcomes and
 * changed no verdict did nothing, whatever it was called — and that is a fact
 * about the run, not about the wording.
 */

export type RoundOutcome = {
  card: string
  /** Whether the card came back with an answer at all. */
  ok: boolean
  /** A critic's verdict, when this round had one to read. */
  verdict?: string
}

export type LedgerRound = {
  /** The orchestrator this round belongs to — a subtree keeps its own count. */
  card: string
  /** Its dispatch number, from 1. */
  round: number
  at: number
  cards: RoundOutcome[]
  /** Lines the batch put into the tree and took out of it, when measurable. */
  added?: number
  removed?: number
  files?: number
  /** Files more than one card in the batch wrote. */
  collisions?: string[]
  /**
   * The git ref holding the working tree as this round left it, when the
   * project is a repository. Nothing restores it automatically — see
   * `lib/checkpoint.ts` for why that is deliberate.
   */
  ref?: string
}

/**
 * The round a run should be judged on, which is not reliably its last one.
 *
 * A gauntlet stops on a bound — spend, wall clock, no progress — and whatever
 * round it happened to be in when the bound fired is what the tree is left at.
 * That round can easily be worse than one before it: a builder given one more
 * turn than the work needed will use it, and the critic that would have caught
 * that is the card the run stopped short of asking.
 *
 * The best round is the most recent one a critic **passed**. Nothing weaker is
 * usable: a round with no verdict has not been judged at all, and preferring
 * "more lines" or "fewer failures" would be the engine inventing a bar of its
 * own when a bar already exists and a card was paid to apply it.
 */
export function bestRound(rounds: LedgerRound[]) {
  return [...rounds].reverse().find((round) => round.cards.some((card) => card.verdict === "PASS"))
}

/**
 * Whether a round did anything the one before it did not.
 *
 * Deliberately not a comparison of the task text. The measured failure is a
 * model that rewords the same work — "fix the ground plane" then "correct the
 * ground plane position" — so wording is the one signal that must not count.
 * What counts is evidence outside the model's control:
 *
 * - the tree moved (any lines, in either direction),
 * - a different set of cards ran,
 * - a card that was failing came back, or one that was working stopped,
 * - a verdict changed, including a critic judging for the first time.
 *
 * A round of pure investigation — cards that read and reported, wrote nothing,
 * judged nothing — registers as no progress, and that is intended: three of
 * those in a row is a run going in circles, and the orchestrator is asked to
 * answer rather than stopped, so a card with something to say still says it.
 */
export function progressed(previous: LedgerRound | undefined, next: LedgerRound) {
  if (!previous) return true
  if ((next.added ?? 0) !== 0 || (next.removed ?? 0) !== 0) return true
  if (!sameCards(previous, next)) return true
  return previous.cards.some((was) => {
    const now = next.cards.find((entry) => entry.card === was.card)
    return !now || now.ok !== was.ok || (now.verdict ?? "") !== (was.verdict ?? "")
  })
}

function sameCards(previous: LedgerRound, next: LedgerRound) {
  const before = previous.cards.map((entry) => entry.card).sort()
  const after = next.cards.map((entry) => entry.card).sort()
  return before.length === after.length && before.every((card, index) => card === after[index])
}

/**
 * How many rounds in a row have changed nothing, counting back from the last.
 *
 * Replaces the old string compare of consecutive batches. The count is what a
 * gauntlet's `stall` bound is measured against, so it has the same shape as the
 * number it replaces — the difference is only what "the same" means.
 */
export function stalledRounds(rounds: LedgerRound[], card: string) {
  const mine = rounds.filter((round) => round.card === card)
  let stalled = 0
  for (let index = mine.length - 1; index > 0; index--) {
    if (progressed(mine[index - 1], mine[index])) break
    stalled++
  }
  return stalled
}

/** Kept short on purpose: this rides every dispatch prompt, and a round is one line. */
const SHOWN = 6

/**
 * What the orchestrator is told about its own history.
 *
 * One line per round, newest last, because the model reads forward and the most
 * recent round is the one it is about to build on. Older rounds are counted
 * rather than printed — a twenty-round gauntlet would otherwise spend a page of
 * every prompt on rounds nobody is going to revisit.
 *
 * Facts only, and no instruction. The engine does not know which approach was
 * right, and a note saying "do not try X again" would be wrong the moment X was
 * rejected for a reason that has since been fixed. What it can say honestly is
 * what happened, and a model reading three rounds of `±0 lines` next to the
 * same verdict draws the conclusion without being told.
 *
 * Returns undefined for a first round, which has no history to carry.
 */
export function ledgerNote(rounds: LedgerRound[], card: string) {
  const mine = rounds.filter((round) => round.card === card)
  if (!mine.length) return undefined
  const shown = mine.slice(-SHOWN)
  const hidden = mine.length - shown.length
  const lines = shown.map((round) => `- ${roundLine(round)}`)
  const stalled = stalledRounds(rounds, card)
  return [
    "What your rounds have produced so far:",
    ...(hidden ? [`- (${hidden} earlier round${hidden === 1 ? "" : "s"} not shown)`] : []),
    ...lines,
    ...(stalled >= 2
      ? [
          `The last ${stalled + 1} rounds changed nothing measurable — no lines, the same cards, the same outcomes. Whatever you dispatch next, make it different from those.`,
        ]
      : []),
  ].join("\n")
}

function roundLine(round: LedgerRound) {
  const parts = [
    `round ${round.round}: ${round.cards.map((entry) => entry.card).join(", ") || "nobody"}`,
    lineCounts(round),
    ...round.cards.filter((entry) => !entry.ok).map((entry) => `${entry.card} failed`),
    ...round.cards.filter((entry) => entry.verdict).map((entry) => `${entry.card}: ${entry.verdict}`),
    round.collisions?.length ? `both wrote ${round.collisions.join(", ")}` : "",
  ].filter(Boolean)
  return parts.join(" · ")
}

function lineCounts(round: LedgerRound) {
  // Unmeasured and "changed nothing" are different facts, and only one of them
  // is worth the orchestrator's attention. A run off git says neither.
  if (round.added === undefined || round.removed === undefined) return ""
  if (!round.added && !round.removed) return "changed no lines"
  return `+${round.added} −${round.removed}${round.files ? ` in ${round.files} file${round.files === 1 ? "" : "s"}` : ""}`
}

/**
 * A critic's verdict in the few words a round line can hold.
 *
 * The marker decides, and a message without one is reported as **unreadable**
 * rather than guessed at. Measured 2026-09-07 on a live gauntlet: the critic
 * cleared the bar and opened `**CLEAR**`, and reading its first line as a
 * verdict recorded the string `CLEAR**` — which is not a verdict, cannot be
 * compared against the next round's, and told `bestRound` nothing. Every
 * critic is now asked for the marker (`criticPrompt`); one that ignores it has
 * not answered the question the run has to record, and saying so is more
 * useful than a fragment of prose dressed up as a decision.
 *
 * The first line still travels with a `fail`, because there the model has
 * already committed to the verdict and the line is the reason.
 */
export function verdictSummary(text: string) {
  const verdict = verdictIn(text)
  if (verdict.kind === "pass") return "PASS"
  if (verdict.kind === "fail") return `FAIL — ${clip(firstLine(verdict.reason))}`
  return `no verdict line — ${clip(firstLine(text), 80)}`
}

/**
 * The first line that says something.
 *
 * Headings are skipped rather than stripped: a critic's answer very often opens
 * `## Review`, and a round line reading `reviewer: Review` would then be a
 * wasted line in every prompt from that round on. What is wanted is the first
 * line the critic wrote *as* the review.
 */
function firstLine(text: string) {
  return (
    text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      // Emphasis comes off both ends. Stripping only the front turned the
      // critic's `**CLEAR**` into `CLEAR**`, which reads as a typo in every
      // prompt it appears in.
      .map((line) =>
        line
          .replace(/^[\s>*_-]+/, "")
          .replace(/[\s*_]+$/, "")
          .trim(),
      )
      .find(Boolean) ?? ""
  )
}

function clip(text: string, max = 120) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
