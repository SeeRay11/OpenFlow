import { normalizePath, TREE, type Write } from "./collisions"
import type { CardDiff } from "./types"

/** One file's line delta, as `lib/diffstat.ts` measures it. */
export type FileStat = { path: string; added: number; removed: number; binary?: boolean }

/**
 * Which card's lines are whose.
 *
 * The tree's delta is measured around a whole batch, because that is the only
 * boundary where the tree holds still — cards inside a batch run at once, in
 * one directory, with nothing locking anything. Splitting that delta back out
 * per card is done with the file lists the activity stream already produces
 * for the collision check: a file exactly one card wrote is that card's, and
 * its lines are exact.
 *
 * A file two cards wrote is neither card's. The lines are still reported, on
 * both, with `shared` naming the other — a number labelled as the pair's is
 * worth having, and silently giving all of it to one of them is the failure
 * mode this whole file exists to avoid. That is the same rule `collisionsIn`
 * follows, including a card that ran a tree-rewriting shell command: it
 * claimed everything, so it shares everything.
 *
 * A file nobody claimed is left out and returned separately. Build output, a
 * program writing on its own account, a heredoc into an interpreter — none of
 * it is readable from a tool call, and attributing it to whoever happened to
 * run would be inventing the number rather than measuring it.
 */
export function attribute(deltas: FileStat[], wrote: Map<string, Write[]>) {
  const claims = new Map<string, string[]>()
  const all = [...wrote].filter(([, writes]) => writes.some((write) => write.path === TREE)).map(([card]) => card)
  for (const delta of deltas) {
    const key = normalizePath(delta.path)
    const cards = [...wrote]
      .filter(([, writes]) => writes.some((write) => write.path !== TREE && samePath(write.path, key)))
      .map(([card]) => card)
    for (const card of all) if (!cards.includes(card)) cards.push(card)
    if (cards.length) claims.set(delta.path, cards)
  }

  const cards = new Map<string, CardDiff>()
  const unclaimed: FileStat[] = []
  for (const delta of deltas) {
    const owners = claims.get(delta.path)
    if (!owners) {
      unclaimed.push(delta)
      continue
    }
    for (const card of owners) {
      const entry = cards.get(card) ?? { added: 0, removed: 0, files: 0 }
      entry.added += delta.added
      entry.removed += delta.removed
      entry.files += 1
      if (owners.length > 1)
        entry.shared = [...new Set([...(entry.shared ?? []), ...owners.filter((other) => other !== card)])]
      cards.set(card, entry)
    }
  }
  return { cards, unclaimed }
}

/**
 * Whether a path a card wrote is the path git measured.
 *
 * They arrive in different shapes and neither side can be normalised into the
 * other: git reports relative to the repository root, while a write tool
 * records whatever the model passed it, which is usually absolute. So the
 * comparison is a suffix on a path boundary — `src/app.tsx` matches
 * `/home/me/project/src/app.tsx` and does not match `other/src/app.tsx`'s
 * sibling `xsrc/app.tsx`.
 */
function samePath(written: string, gitPath: string) {
  const left = normalizePath(written)
  if (left === gitPath) return true
  return left.endsWith(`/${gitPath}`) || gitPath.endsWith(`/${left}`)
}

/**
 * What changed between two snapshots, per file.
 *
 * Subtraction rather than a second diff, because the two snapshots are taken
 * around a batch that ran in the same tree the user is also sitting in: the
 * only honest reading of "what this batch did" is what is there now that was
 * not there before. A file whose counts did not move is absent from the
 * result, so a card that read the tree and wrote nothing measures nothing.
 *
 * Counts can fall as well as rise — a card that reverted another card's work
 * lowers the tree's total additions — and the negative is kept. Clamping it to
 * zero would report the undo as no change at all, which is the one thing it
 * definitely is not.
 */
export function deltaOf(before: FileStat[], after: FileStat[]): FileStat[] {
  const start = new Map(before.map((entry) => [entry.path, entry]))
  const moved: FileStat[] = []
  for (const entry of after) {
    const was = start.get(entry.path)
    const added = entry.added - (was?.added ?? 0)
    const removed = entry.removed - (was?.removed ?? 0)
    const binary = entry.binary || (!!was?.binary && !entry.binary)
    if (!added && !removed && !(binary && !was)) continue
    moved.push({ path: entry.path, added, removed, ...(binary ? { binary: true } : {}) })
  }
  // A file that was changed before the batch and is not changed now was put
  // back — its own counts are gone from `after` entirely, so the subtraction
  // above never sees it.
  for (const entry of before) {
    if (after.some((now) => now.path === entry.path)) continue
    if (!entry.added && !entry.removed) continue
    moved.push({ path: entry.path, added: -entry.added, removed: -entry.removed })
  }
  return moved
}

/** Adds a card's later batch to the one already recorded, so a re-dispatched card totals up. */
export function addDiff(current: CardDiff | undefined, next: CardDiff): CardDiff {
  if (!current) return next
  return {
    added: current.added + next.added,
    removed: current.removed + next.removed,
    files: current.files + next.files,
    ...(current.shared || next.shared
      ? { shared: [...new Set([...(current.shared ?? []), ...(next.shared ?? [])])] }
      : {}),
  }
}

/**
 * The badge: `+42 −7`.
 *
 * The minus is U+2212, not a hyphen — it is the same width as the plus, so a
 * column of these lines up. Zero is a real measurement here and is shown as
 * `±0`; a card with no measurement at all renders nothing, never this.
 */
export function diffLabel(diff: CardDiff | undefined) {
  if (!diff) return ""
  if (!diff.added && !diff.removed) return "±0"
  return [diff.added ? `+${diff.added}` : "", diff.removed ? `−${diff.removed}` : ""].filter(Boolean).join(" ")
}

/** What the badge says on hover, including why a shared figure is not this card's alone. */
export function diffTitle(diff: CardDiff | undefined) {
  if (!diff) return ""
  const files = `${diff.files} file${diff.files === 1 ? "" : "s"}`
  const lines = `+${diff.added} / −${diff.removed} across ${files}`
  if (!diff.shared?.length) return lines
  return `${lines} — shared with ${diff.shared.join(", ")}, which wrote the same files in the same batch, so these lines are the batch's rather than this card's`
}
