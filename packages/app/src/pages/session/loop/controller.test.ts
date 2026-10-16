import { describe, expect, test } from "bun:test"
import { NEXT_MOVES_BACKFILL, NEXT_MOVES_MAX, pickLastAssistantText, type NextMoveMessageLike } from "./controller"

/**
 * Unit coverage for the pure NEXT-MOVE helpers. The reactive controller
 * (cache, backfill, visibility) needs real Solid effects and is covered in
 * test-browser/session-loop-tab.test.ts — under --conditions=solid this suite
 * resolves the server build, where createEffect is a no-op.
 */

const msg = (id: string, role: string, created: number, parts: Array<{ type: string; text?: string }>): NextMoveMessageLike => ({
  info: { id, role, time: { created } },
  parts,
})

describe("pickLastAssistantText (E9)", () => {
  test("picks the LAST assistant message by time.created regardless of order", () => {
    const items = [
      msg("m3", "assistant", 300, [{ type: "text", text: "drei" }]),
      msg("m1", "user", 200, [{ type: "text", text: "frage" }]),
      msg("m2", "assistant", 100, [{ type: "text", text: "eins" }]),
    ]
    expect(pickLastAssistantText(items)).toEqual({ text: "drei", textKey: "m3", at: 300 })
  })

  test("joins text parts and ignores other part types", () => {
    const picked = pickLastAssistantText([
      msg("m1", "assistant", 100, [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }]),
    ])
    expect(picked).toEqual({ text: "a\nb", textKey: "m1", at: 100 })
  })

  test("returns null without assistant messages", () => {
    expect(pickLastAssistantText([msg("m0", "user", 1, [{ type: "text", text: "x" }])])).toBeNull()
    expect(pickLastAssistantText([])).toBeNull()
  })
})

describe("NEXT_MOVES caps (E4)", () => {
  test("display cap and backfill window are both 10", () => {
    expect(NEXT_MOVES_MAX).toBe(10)
    expect(NEXT_MOVES_BACKFILL).toBe(10)
  })
})
