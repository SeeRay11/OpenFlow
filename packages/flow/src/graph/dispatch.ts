/**
 * The orchestrator's control protocol.
 *
 * A card is a plain `opencode` session: it emits one final message and nothing
 * else crosses the boundary. So an orchestrator says what it wants to happen
 * next by ending that message with a fenced block, and this reads it back.
 *
 * Everything here is deliberately strict. A control instruction that is *nearly*
 * right — a card id that does not exist, a task that is an empty string, two
 * assignments racing the same session — costs real sessions to discover at run
 * time, and the failure looks like a broken model rather than a malformed block.
 * Refusing with the exact reason lets the engine re-prompt the same session with
 * something it can act on.
 */

import { normalizePath } from "./collisions"

export const FENCE = "openflow"

/**
 * The MCP server that carries the same protocol as tool calls, and the tool
 * names opencode registers it under (`<server>_<tool>`).
 *
 * A tool call is the channel models actually reach for — measured — so it is
 * tried first and the fenced block is the fallback. Both ends up in
 * `assignmentsFrom` below, so the two channels cannot drift into disagreeing
 * about what a valid dispatch is.
 */
export const MCP_SERVER = "openflow"
export const DISPATCH_TOOL = `${MCP_SERVER}_dispatch`
export const FINISH_TOOL = `${MCP_SERVER}_finish`

/**
 * Whether an MCP tool can reach a card at all. **It cannot, in this fork.**
 *
 * OpenFlow drives `client.v2.session.*`, so a card runs through the v2 session
 * runner — and that runner has never been wired to MCP. Its own spec comment
 * says so, unticked, at `packages/core/src/session/runner/llm.ts`:
 *
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output
 *         tool definitions.
 *
 * MCP tools are converted and registered in exactly one place, the *v1* session
 * path (`packages/opencode/src/session/tools.ts`), which OpenFlow does not use.
 * The v2 tool registry (`packages/core/src/tool/`) holds read, grep, glob, bash,
 * edit, write, question, skill, todowrite, webfetch, websearch and apply-patch,
 * and nothing puts MCP beside them — so `openflow_dispatch` comes back as
 * `Unknown tool` from `core/src/tool/registry.ts` however the config is written.
 *
 * `GET /mcp` still answers `connected`, which is what made this look like a
 * config bug for so long: the MCP *service* connects the process and holds the
 * client perfectly well. It simply never contributes a tool definition to a v2
 * session.
 *
 * So the channel is parked, not deleted. Everything it needs is built and
 * tested; flipping this to `true` is the whole of turning it back on the day
 * that checklist line is ticked. Fixing it here is not an option — it would
 * mean editing `packages/core`, and this fork modifies no upstream package.
 */
export const MCP_REACHES_SESSIONS = false

/**
 * `files` is what the orchestrator says the card will write, if it says. It is
 * optional because most assignments do not write anything, and a declaration
 * demanded of every one would be padded with guesses. When two assignments in
 * a batch declare the same path the batch is refused before anything runs —
 * the only moment a collision is free to fix.
 */
export type Assignment = { card: string; task: string; files?: string[] }

export type Dispatch =
  | { kind: "dispatch"; assignments: Assignment[] }
  | { kind: "final"; answer: string }
  /** `reason` is written to be handed straight back to the model. */
  | { kind: "error"; reason: string }

/**
 * Reads the control block out of an orchestrator's final message.
 *
 * The **last** block wins. A model that explains the protocol, or quotes the
 * example it was given, before deciding what it actually wants is common; the
 * block it settled on is the one it wrote last.
 */
export function parseDispatch(text: string, children: string[]): Dispatch {
  const blocks = [...text.matchAll(new RegExp("```" + FENCE + "\\s*\\n([\\s\\S]*?)```", "g"))]
  // A message that is *nothing but* the JSON needs no fence to be unambiguous,
  // and models send it that way constantly — measured against a real provider,
  // which produced a flawless dispatch object and no fence around it. The fence
  // exists to separate reasoning from instruction; where there is no reasoning
  // there is nothing to separate. Refusing this was costing a paid turn and
  // then the run.
  //
  // Only the whole message counts. Fishing a JSON object out of prose would
  // read an example the model was talking *about* as one it meant to send.
  const body = blocks.length ? blocks[blocks.length - 1][1] : text.trim()
  // A turn that ended on a tool call and said nothing is a different mistake
  // from a turn that wrote the wrong thing, and it needs a different thing said
  // back: telling a card its block was malformed when it sent no message at all
  // reads as nonsense and it repeats the same empty turn.
  if (!text.trim())
    return {
      kind: "error",
      reason:
        "Your last turn produced no message at all — you ended it on a tool call. Tools do not decide anything here; the block does.",
    }
  if (!blocks.length && !(body.startsWith("{") && body.endsWith("}")))
    return {
      kind: "error",
      reason: `Your message carried no \`\`\`${FENCE} block, so nothing could be dispatched and the run cannot continue.`,
    }

  const parsed = parseJson(body)
  if (parsed === undefined) return { kind: "error", reason: `The \`\`\`${FENCE} block is not valid JSON.` }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "error", reason: `The \`\`\`${FENCE} block must hold a JSON object.` }

  const block = parsed as Record<string, unknown>
  const wantsFinal = "final" in block
  const wantsDispatch = "dispatch" in block
  if (wantsFinal && wantsDispatch)
    return { kind: "error", reason: "The block carries both `dispatch` and `final`. Send exactly one." }
  if (!wantsFinal && !wantsDispatch)
    return { kind: "error", reason: "The block carries neither `dispatch` nor `final`. Send exactly one." }

  if (wantsFinal) {
    if (typeof block.final !== "string" || !block.final.trim())
      return { kind: "error", reason: "`final` must be a non-empty string holding the answer itself." }
    return { kind: "final", answer: block.final.trim() }
  }

  return assignmentsFrom(block.dispatch, children)
}

/**
 * Reads the protocol out of a tool call the card made.
 *
 * Returns `undefined` for any tool that is not ours, so the caller can keep
 * looking back through the turn: an orchestrator that dispatches and then
 * writes a to-do list has the call buried under later parts, and only the
 * newest *matching* call is the decision.
 */
export function fromToolCall(name: string, input: unknown, children: string[]): Dispatch | undefined {
  if (name !== DISPATCH_TOOL && name !== FINISH_TOOL) return undefined
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>

  if (name === FINISH_TOOL) {
    if (typeof args.answer !== "string" || !args.answer.trim())
      return { kind: "error", reason: "`finish` needs an `answer` holding the result itself." }
    return { kind: "final", answer: args.answer.trim() }
  }
  // `dispatch` is accepted alongside the schema's own `assignments`: measured,
  // a model that had also been shown the fenced block called the tool with the
  // block's key. Both name the same array, and refusing one of them spends a
  // paid retry to correct a spelling.
  return assignmentsFrom(args.assignments ?? args.dispatch, children)
}

/**
 * The one place a batch of assignments is judged, whichever channel carried it.
 *
 * Everything here is deliberately strict, and the reasons are written to be
 * handed straight back to the model.
 */
function assignmentsFrom(value: unknown, children: string[]): Dispatch {
  if (!Array.isArray(value) || !value.length)
    return { kind: "error", reason: "A dispatch must be a non-empty array of `{ card, task }` objects." }
  if (!children.length)
    return {
      kind: "error",
      reason: "No cards are connected below you, so there is nobody to dispatch to. Answer instead.",
    }

  const assignments: Assignment[] = []
  const claimed = new Set<string>()
  /** Declared write targets, normalised, to the card that declared them first. */
  const owners = new Map<string, string>()
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null)
      return { kind: "error", reason: "Every assignment must be an object with a `card` and a `task`." }
    const row = entry as Record<string, unknown>
    if (typeof row.card !== "string" || !children.includes(row.card))
      return {
        kind: "error",
        reason: `\`${String(row.card)}\` is not a card you can dispatch to. Your cards are: ${children.join(", ")}.`,
      }
    if (typeof row.task !== "string" || !row.task.trim())
      return { kind: "error", reason: `The assignment for \`${row.card}\` has no task text.` }
    // One card is one session. Two assignments in the same batch would race the
    // same session and one of them would silently be lost.
    if (claimed.has(row.card))
      return {
        kind: "error",
        reason: `\`${row.card}\` appears twice in one dispatch. Give a card one task per round, or dispatch it again next round.`,
      }
    claimed.add(row.card)
    // The cards in a batch run at once in one directory with no lock, so a
    // file two of them both write ends up as whichever wrote last. The engine
    // reports that after the batch from the writes it actually saw; this is
    // the half that costs nothing, because the batch has not run yet.
    if (row.files !== undefined && !(Array.isArray(row.files) && row.files.every(isPath)))
      return {
        kind: "error",
        reason: `\`files\` on the assignment for \`${row.card}\` must be an array of file paths, or left out.`,
      }
    const files = row.files === undefined ? undefined : (row.files as string[]).map((path) => path.trim())
    for (const path of files ?? []) {
      const owner = owners.get(normalizePath(path))
      if (owner && owner !== row.card)
        return {
          kind: "error",
          reason: `\`${path}\` is declared by both \`${owner}\` and \`${row.card}\` in one dispatch. The cards in a batch run at the same time and nothing locks a file, so the later write would silently replace the earlier one. Give the file to one card, or dispatch the other next round.`,
        }
      owners.set(normalizePath(path), row.card)
    }
    assignments.push({ card: row.card, task: row.task.trim(), ...(files?.length ? { files } : {}) })
  }
  return { kind: "dispatch", assignments }
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && !!value.trim()
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Fall through to the balanced-object read below.
  }
  const object = balanced(text)
  if (object === undefined) return undefined
  try {
    return JSON.parse(object) as unknown
  } catch {
    return undefined
  }
}

/**
 * The first complete JSON object in `text`, ignoring whatever follows it.
 *
 * Models leave a character behind. Measured: a dispatch that was correct in
 * every respect — right card, a task naming the file, the line and the fix —
 * arrived with one stray `"` after the closing brace, and cost the run, because
 * `JSON.parse` rejects the whole string over trailing junk. Reading to the
 * matching brace and stopping recovers it.
 *
 * Braces inside strings do not count, and an escaped quote does not end one, so
 * a task that talks about `{` or quotes something is still read correctly. This
 * only ever *ends* earlier than the raw text: it cannot turn invalid JSON into
 * a different valid object, and anything unbalanced still fails.
 */
function balanced(text: string) {
  const start = text.indexOf("{")
  if (start < 0) return undefined
  /** Openers still waiting to be closed, so a truncated block can be finished. */
  const open: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && inString) {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === "{" || character === "[") open.push(character)
    else if (character === "}" || character === "]") {
      open.pop()
      if (!open.length) return text.slice(start, index + 1)
    }
  }
  // Ran out of text with the object still open: the model was cut off mid-block.
  // Measured: an orchestrator wrote a 5.3KB dispatch with a whole verification
  // script inlined in the task and ended `… "priority": "high" } ]` — every
  // brace but the outermost closed. Closing what it left open is what a person
  // reading it would do; the alternative is throwing away a run over a missing
  // character. A string left open is closed too, which truncates that value
  // rather than losing the dispatch.
  if (!open.length) return undefined
  // Trailing whitespace has to go before the quote does: the cut usually lands
  // after a newline, and a raw newline inside a JSON string is invalid however
  // the string is closed. A dangling backslash would escape the quote we add.
  const body = inString ? text.slice(start).replace(/\s+$/, "").replace(/(?<!\\)\\$/, "") : text.slice(start)
  return (
    body +
    (inString ? '"' : "") +
    open
      .reverse()
      .map((character) => (character === "{" ? "}" : "]"))
      .join("")
  )
}
