import { toolMap } from "../server/card-spec"
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

/** A worktree as the run log names it. Read back from a file in the project, so none of it is trusted. */
export type LoggedTree = { card: string; directory: string; branch: string }

const LONGEST = 200
const MOST_SHOWN = 20
const MOST_KEPT = 50

/**
 * A string from the run log, made safe to show and to put in front of a model: control and invisible
 * formatting characters (bidi overrides, zero-width marks) and line breaks become spaces, runs of spaces
 * collapse, and it is cut at 200 characters.
 */
export function plainText(value: unknown) {
  const text = typeof value === "string" ? value : ""
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
  return flat.length > LONGEST ? `${flat.slice(0, LONGEST)}…` : flat
}

/** An absolute path (`/…` or `X:\…`) of plain characters only: nothing a shell or a reader could read as more than a name. */
const SAFE_DIRECTORY = /^(?:\/|[A-Za-z]:[\\/])[A-Za-z0-9 _.@+:~\\/-]*$/
/** A branch OpenFlow itself would have made. */
const SAFE_BRANCH = /^openflow\/[A-Za-z0-9_./-]+$/

/**
 * The trees of a log's `isolation`, as far as they are well formed: anything else in the file is dropped.
 * At most 50 are kept, and `total` is how many entries the file held, so a note can still say how many it left out.
 */
export function loggedTrees(value: unknown): { trees: LoggedTree[]; total: number } {
  const list = typeof value === "object" && value !== null && "trees" in value && Array.isArray(value.trees) ? value.trees : []
  const trees: LoggedTree[] = []
  for (const tree of list) {
    if (trees.length >= MOST_KEPT) break
    if (typeof tree !== "object" || tree === null) continue
    const raw = { directory: "directory" in tree ? tree.directory : undefined, branch: "branch" in tree ? tree.branch : undefined }
    // Judged as written, before anything is flattened: a path that needed cleaning is not a path to put in a command.
    if (typeof raw.directory !== "string" || raw.directory.length > LONGEST || !SAFE_DIRECTORY.test(raw.directory)) continue
    if (typeof raw.branch !== "string" || raw.branch.length > LONGEST || !SAFE_BRANCH.test(raw.branch)) continue
    const card = "card" in tree ? plainText(tree.card) : ""
    if (card) trees.push({ card, directory: raw.directory, branch: raw.branch })
  }
  return { trees, total: list.length }
}

/**
 * The one sentence a resumed run raises about isolated copies its predecessor left. It says where they are and
 * what to do, and does nothing about them: whether they hold unmerged work, and what to do with it, is the user's call.
 * `total` is how many entries the log held, so the count of those not listed is true even when some were dropped.
 */
export function abandonedNote(trees: LoggedTree[], total = trees.length, name: (card: string) => string = (card) => card) {
  const shown = trees.slice(0, MOST_SHOWN)
  const where = shown
    .map((tree) => `${plainText(name(tree.card))} in "${tree.directory}" (branch ${tree.branch})`)
    .join("; ")
  const more = total > shown.length ? `; …and ${total - shown.length} more` : ""
  const first = shown[0]?.directory ?? "<directory>"
  return `The interrupted run left isolated copies that may hold work not merged into the project: ${where}${more}. Check each one with git -C "${first}" status and git -C "${first}" diff (the same for the others) before relying on it, then merge or discard it yourself; Resume does not touch it.`
}

/**
 * What a carried card is told when it had an isolated copy: the folder to work in is the project, edits it made
 * earlier may only exist in the old copy, so it checks the project before relying on them and must not edit the copy.
 * The path goes in only when it has no space; the notice names it otherwise.
 */
export function movedNote(tree: LoggedTree) {
  const where = tree.directory.includes(" ") ? "the old isolated copy named in the notice" : `the old isolated copy at ${tree.directory}`
  return `Your working directory is now the project folder. Edits you made before the interruption may still be only in ${where}: check the project files before relying on them, redo any that are missing in the project folder, and do not edit the old copy.`
}
