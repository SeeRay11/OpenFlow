import { toolMap } from "../server/store"
import type { FlowNode } from "./types"

/**
 * Whether a card is worth isolating.
 *
 * Only a card that can change files can overwrite another's work, and a
 * worktree costs a checkout and a merge — so a reader stays in the project
 * directory, where it reads exactly what the run is actually building.
 *
 * The test is the same one `swarm-writers` uses, and for the same reason: an
 * unlisted tool inherits the default agent's allow, so `{ read: true }` is a
 * writer. Erring toward isolating is the safe direction — an isolated reader
 * costs a checkout, an un-isolated writer costs somebody's work.
 */
export function isolates(node: FlowNode) {
  const tools = toolMap(node.agent.tools)
  return tools.edit !== false || tools.bash !== false
}

export type MergeReport = {
  merged: string[]
  empty: string[]
  conflicts: { card: string; paths: string[] }[]
}

/**
 * What the orchestrator is told after a batch's work is folded back in.
 *
 * Only conflicts are reported. A batch that merged cleanly is the expected
 * case, and narrating it every round would train the orchestrator to skim the
 * one message that matters — the same reasoning as `collisionNote`, which says
 * nothing when nothing collided.
 *
 * The message has to make three things unambiguous, because each one is a
 * decision the orchestrator would otherwise get wrong: the conflicting work
 * still exists and is *not* in the tree, the file on disk is whichever card
 * merged first rather than some blend of the two, and re-running the losing
 * card verbatim will conflict again. Telling it only "there was a conflict"
 * reliably produces a card re-dispatched with the same instructions.
 */
export function mergeNote(report: MergeReport) {
  if (!report.conflicts.length) return ""
  const lines = report.conflicts.map(
    (conflict) => `- ${conflict.card}: ${conflict.paths.join(", ")}`,
  )
  return [
    `${report.conflicts.length} card(s) produced work that could not be folded back into the project:`,
    ...lines,
    "",
    "Those paths are unchanged on disk: they hold what the card that merged first wrote, and the conflicting version was discarded rather than layered on top. Nothing else that card wrote was lost — its other files were applied.",
    "Re-dispatching the same task word for word will conflict again. Either give that card the current state of the file and ask it to redo the change on top, or give the file to one card and have the other work somewhere else.",
  ].join("\n")
}
