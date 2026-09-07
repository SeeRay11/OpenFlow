/**
 * A critic's verdict, read back out of the message it wrote.
 *
 * A gauntlet never needed this: its verdicts are read by an orchestrator, which
 * is a model and can understand prose. A verification pass has no orchestrator
 * — the engine itself has to decide whether the run passed — so the answer has
 * to carry one machine-readable line.
 *
 * The protocol is deliberately not the ```openflow block. That block is a
 * control instruction with a schema behind it, taught over several paragraphs
 * of briefing to a card whose whole job is dispatching; a critic writes prose
 * about work it inspected, and asking it for JSON buys a parse failure on the
 * one turn that matters. A bare marker line is the cheapest thing a model
 * reliably emits.
 */

/** What the critic must end its message with. Shown verbatim in the briefing. */
export const PASS = "VERDICT: PASS"
export const FAIL = "VERDICT: FAIL"

export type Verdict = { kind: "pass" } | { kind: "fail"; reason: string } | { kind: "unreadable" }

/**
 * Reads the verdict out of a critic's message.
 *
 * The **last** marker wins, for the reason the dispatch block's last block wins:
 * a critic that quotes the two lines it was told to choose between, and then
 * chooses, has written three markers and means the third.
 *
 * `reason` is what the critic said above its marker, which is the part a person
 * reads. It is not parsed — everything above the line is kept, because a critic
 * that explains itself in one sentence and one that writes eight paragraphs are
 * both being useful.
 */
export function verdictIn(text: string): Verdict {
  // Tolerant of what models actually write around a marker they were told to
  // put on its own line: bold, a bullet, a trailing full stop, `Verdict: pass`.
  const markers = [...text.matchAll(/^[\s>*_-]*verdict\s*:\s*\**\s*(pass|fail)\b/gim)]
  const last = markers[markers.length - 1]
  if (!last) return { kind: "unreadable" }
  if (last[1].toLowerCase() === "pass") return { kind: "pass" }
  return { kind: "fail", reason: text.slice(0, last.index).trim() || text.trim() }
}
