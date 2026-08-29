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

export type Assignment = { card: string; task: string }

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
    assignments.push({ card: row.card, task: row.task.trim() })
  }
  return { kind: "dispatch", assignments }
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
