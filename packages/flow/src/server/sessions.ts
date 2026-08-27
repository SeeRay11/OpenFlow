/**
 * One row of the sessions sidebar.
 *
 * This is a projection of `Session.Info` as `GET /api/session` returns it —
 * the drizzle-backed `session` table in `opencode.db`, the same rows the CLI
 * and TUI list. OpenFlow keeps no session store of its own: a node's session is
 * created through the server ([client.createSession]) and therefore already
 * lives there, so a second copy could only ever drift.
 */
export type SessionRow = {
  id: string
  title: string
  agent?: string
  model?: string
  /** A child session — a subagent the card spawned — rather than a node's own. */
  parent?: string
  created: number
  updated: number
}

/*
 * Deliberately not projected: `cost`. This vendored server build reports
 * `cost: 0` on every session (see `server/usage.ts`), so a per-session price in
 * this list would read as "free" for work that was not. Spend has one home, the
 * spend panel, where it is computed from the models.dev tiers.
 */

export type Turn = {
  role: "user" | "assistant"
  text: string
}

/**
 * Narrows `Session.Info` to what the sidebar draws.
 *
 * The wire shape is untyped here on purpose: the generated client types
 * `session.list` through its own schema, and mirroring `Session.Info` in flow
 * would be a second definition to keep in step with upstream for no gain. What
 * this file owns is the projection, and that is what the tests pin.
 */
export function sessionRows(list: any[]): SessionRow[] {
  return list.map((entry) => ({
    id: entry.id,
    // An untitled session is still worth listing — it is usually the one that
    // just started, which is the one a user is looking for.
    title: (entry.title ?? "").trim() || "untitled session",
    agent: entry.agent ?? undefined,
    model: entry.model ? `${entry.model.providerID}/${entry.model.id}` : undefined,
    parent: entry.parentID ?? undefined,
    created: Number(entry.time?.created ?? 0),
    updated: Number(entry.time?.updated ?? entry.time?.created ?? 0),
  }))
}

/**
 * Flattens a message page into readable turns.
 *
 * The two message kinds are not shaped alike, and assuming they were is what
 * made the first draft of this render assistant replies to nothing: a **user**
 * message carries its prompt in a top-level `text` and has no `content` at all,
 * while an **assistant** message carries an array of parts. Both paths are
 * therefore read, and both are covered by tests.
 *
 * Tool parts are dropped rather than rendered: this is a "what was this session
 * about" view, and the blow-by-blow already has a home in the activity drawer.
 * A turn left with no text (a pure tool step) contributes nothing and goes.
 */
export function transcriptTurns(messages: any[]): Turn[] {
  return messages
    .filter((message) => message.type === "user" || message.type === "assistant")
    .map((message) => ({
      role: message.type as Turn["role"],
      text: (typeof message.text === "string"
        ? message.text
        : (message.content ?? [])
            .filter((part: any) => part.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text)
            .join("\n")
      ).trim(),
    }))
    .filter((turn) => turn.text.length > 0)
}

/**
 * What the server names a session it was given no title for.
 *
 * Nothing in OpenFlow sets a title — a node prompts its session and never
 * renames it — so this is what every node session is called, and showing it as
 * the card's headline would give a column of identical rows stamped with dates.
 */
const AUTO_TITLE = /^New session\b/

/**
 * The line that identifies a session in the list.
 *
 * A real title wins when there is one (the CLI and TUI set them). Failing that
 * the generated agent is what a user recognises — "plan-and-code-coder-nmt6c…"
 * is the node that ran — and only when there is neither does the auto-title get
 * used, because a dated row still beats a blank one.
 */
export function sessionLabel(row: SessionRow) {
  if (!AUTO_TITLE.test(row.title)) return row.title
  return row.agent ?? row.title
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
 * Client-side fallback filter.
 *
 * The search box sends `search` to the server, which matches it against the
 * session table — that is the path that scales and the one that normally runs.
 * This exists for the window between keystroke and response, so the list does
 * not sit visibly stale while the request is in flight.
 */
export function matches(row: SessionRow, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.title, row.agent, row.model, row.id].some((field) => field?.toLowerCase().includes(needle))
}
