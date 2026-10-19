import type { SessionRow } from "../../shared/engine"

export type { SessionRow, Turn } from "../../shared/engine"

/*
 * Deliberately not on the row: cost. Omp reports a per-step `usage.cost`, but
 * the engine prices from the catalog (`server/usage.ts`), and a second number
 * per session would disagree with the spend panel. Spend has one home.
 */

/**
 * The line that identifies a session in the list.
 *
 * The host sets the title (the card's role and node, or whatever omp named the
 * session); a blank one is still worth listing — it is usually the session that
 * just started, which is the one a user is looking for — so the generated agent
 * key names it, and only without both does the placeholder show.
 */
export function sessionLabel(row: SessionRow) {
  return row.title.trim() || row.agent || "untitled session"
}

/**
 * Compact age label — "now", "4m", "3h", "6d".
 *
 * Absolute timestamps would need more width than a 240px column has, and the
 * question this list answers is "which one did I just run", which is relative.
 */
export function formatAge(time: number, now: number) {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/**
 * Client-side filter for the search box.
 *
 * Matches what the user can see — title, agent, model, id — because a card's
 * session is titled by the host, not by the user, so a server-side title search
 * would miss the fields that actually identify a node.
 */
export function matches(row: SessionRow, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.title, row.agent, row.model, row.id].some((field) => field?.toLowerCase().includes(needle))
}
