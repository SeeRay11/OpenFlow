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

  if (!Array.isArray(block.dispatch) || !block.dispatch.length)
    return { kind: "error", reason: "`dispatch` must be a non-empty array of `{ card, task }` objects." }
  if (!children.length)
    return {
      kind: "error",
      reason: "No cards are connected below you, so there is nobody to dispatch to. Answer with `final` instead.",
    }

  const assignments: Assignment[] = []
  const claimed = new Set<string>()
  for (const entry of block.dispatch) {
    if (typeof entry !== "object" || entry === null)
      return { kind: "error", reason: "Every `dispatch` entry must be an object with a `card` and a `task`." }
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
