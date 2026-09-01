import type { NodeEvent } from "./types"

/**
 * Tools that change a file, and the field naming what they changed.
 *
 * The v2 registry calls it `path` on both writers (`packages/core/src/tool/
 * write.ts`, `edit.ts`); `filePath` is here because the model-facing schema
 * carries a standing TODO to rename it that way for trained-in compatibility,
 * and a card that guesses the trained name should still be counted rather than
 * silently dropped.
 */
const WRITERS = new Set(["write", "edit", "apply_patch", "apply-patch"])

/** One file two cards in the same batch both wrote, in the order they wrote it. */
export type Collision = { path: string; cards: string[] }

/**
 * Files this card wrote, read off the tool calls it made.
 *
 * The events are the ones the activity stream already keeps for the card, so
 * this costs no extra request: `input` is the tool's arguments as sent, which
 * is where the path is. A failed call is not a write — a tool the provider
 * rejected never touched the disk, and counting it would report a collision
 * between a card that wrote and a card that was refused.
 *
 * `bash` is deliberately not a writer here even though a card with it can
 * redirect into a file. A shell line is not parseable into paths with any
 * honesty, and a detector that guessed would be wrong in both directions. What
 * bash costs this check is said out loud in `collisionNote` instead.
 */
export function writesOf(events: NodeEvent[], since = 0) {
  const paths: string[] = []
  for (const event of events) {
    if (event.kind !== "tool" || event.at < since || event.status === "error") continue
    if (!WRITERS.has(event.title.split(" ")[0])) continue
    const path = pathIn(event.input)
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * Where two cards in one batch wrote the same file.
 *
 * Batch-scoped on purpose. Two cards writing one file in *different* batches is
 * ordinary iteration — the orchestrator dispatched them in sequence and knows
 * which came second. Within one batch nothing ordered them: the pool ran them
 * at once, no lock exists anywhere in this fork, and the later write wins with
 * nothing anywhere reporting that the earlier one is gone.
 *
 * `wrote` maps a dispatched card to the paths it and everything below it
 * touched, because the card the orchestrator can re-dispatch is the one at the
 * top of that subtree, not whichever leaf held the pen.
 */
export function collisionsIn(wrote: Map<string, string[]>) {
  const byPath = new Map<string, { display: string; cards: string[] }>()
  for (const [card, paths] of wrote) {
    for (const path of paths) {
      // Two cards can name one file differently — `src/game.ts` and
      // `./src/game.ts`, or either case of a Windows drive letter — and a
      // collision the check misses because of punctuation is the collision it
      // exists to find. Comparison is normalised; what the user is shown is
      // what the card actually sent.
      const key = normalize(path)
      const seen = byPath.get(key) ?? { display: path, cards: [] }
      if (!seen.cards.includes(card)) seen.cards.push(card)
      byPath.set(key, seen)
    }
  }
  return [...byPath.values()]
    .filter((entry) => entry.cards.length > 1)
    .map<Collision>((entry) => ({ path: entry.display, cards: entry.cards }))
}

/**
 * What the orchestrator is told about the collisions its last batch produced.
 *
 * Written as a finding rather than an instruction: the engine does not know
 * which of the two writes was the one worth keeping, and a card told "revert
 * b" when b was right would spend a round undoing the good half. It states
 * what happened, names the rule the batch broke, and leaves the decision where
 * the decision belongs.
 *
 * Returns undefined when there is nothing to report, so the caller can leave
 * the prompt exactly as it was.
 */
export function collisionNote(collisions: Collision[], hasShell: boolean) {
  if (!collisions.length) return undefined
  return [
    "# Your cards wrote over each other",
    "",
    "These files were written by more than one card in the batch you just dispatched. Nothing",
    "orders writes inside a batch and nothing locks a file, so for each of these only the last",
    "write survives and the earlier one is gone — including any part of it the later card had",
    "no idea existed.",
    "",
    ...collisions.map((collision) => `- \`${collision.path}\` — ${collision.cards.join(", ")}`),
    "",
    "Check what survived before you build on it. A card whose work was overwritten did not fail",
    "and will report success, so its answer above describes a file that no longer says that.",
    "",
    "This is the split that caused it: work on one file belongs to **one** card. Give the file to",
    "a single card and let it make every change in sequence, or split the work so that no two",
    "cards need the same file. Cards cannot see each other, so two of them editing one file are",
    "each writing against a version they imagined.",
    ...(hasShell
      ? [
          "",
          "Some of these cards can also run shell commands, which can write files without a write",
          "tool call. The list above is what was seen; treat it as the least that collided, not all",
          "of it.",
        ]
      : []),
  ].join("\n")
}

/** The path a writing tool was given, from the arguments as sent. */
function pathIn(input: string | undefined) {
  if (!input) return undefined
  const parsed = parse(input)
  if (!parsed) return undefined
  for (const key of ["path", "filePath"]) {
    const value = parsed[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function parse(input: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function normalize(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}
