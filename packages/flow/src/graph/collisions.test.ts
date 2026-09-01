import { describe, expect, test } from "bun:test"
import { collisionNote, collisionsIn, writesOf } from "./collisions"
import type { NodeEvent } from "./types"

/** One tool call as the activity stream records it: title, and input as sent. */
function call(tool: string, input: unknown, options: { at?: number; status?: NodeEvent["status"] } = {}): NodeEvent {
  return {
    id: `tool:${tool}:${options.at ?? 1}`,
    at: options.at ?? 1,
    kind: "tool",
    depth: 0,
    title: input && typeof input === "object" ? `${tool} path=${(input as any).path}` : tool,
    status: options.status ?? "done",
    input: JSON.stringify(input),
  }
}

describe("writesOf", () => {
  test("reads the path off the writing tools and ignores the reading ones", () => {
    expect(
      writesOf([
        call("read", { path: "src/read-only.ts" }),
        call("write", { path: "src/game.ts", content: "x" }),
        call("grep", { pattern: "foo" }),
        call("edit", { path: "src/bird.ts" }),
      ]),
    ).toEqual(["src/game.ts", "src/bird.ts"])
  })

  test("a rejected tool call never touched the disk", () => {
    // A card with `edit: deny` is still handed the tool and still calls it —
    // counting the refusal would report a collision between a card that wrote
    // and a card that was stopped from writing.
    expect(writesOf([call("write", { path: "src/game.ts" }, { status: "error" })])).toEqual([])
  })

  test("only calls from this batch count", () => {
    const events = [call("write", { path: "old.ts" }, { at: 10 }), call("write", { path: "new.ts" }, { at: 30 })]
    expect(writesOf(events, 20)).toEqual(["new.ts"])
  })

  test("one card writing one file twice is one path, not a collision with itself", () => {
    expect(
      writesOf([call("write", { path: "src/game.ts" }, { at: 1 }), call("edit", { path: "src/game.ts" }, { at: 2 })]),
    ).toEqual(["src/game.ts"])
  })

  test("bash is not read as a writer", () => {
    // A shell line cannot be parsed into paths with any honesty. What that
    // costs the check is said in the note instead of guessed at here.
    expect(writesOf([call("bash", { command: "echo hi > src/game.ts" })])).toEqual([])
  })

  test("a tool call with no parseable input is skipped rather than throwing", () => {
    const broken: NodeEvent = { id: "t", at: 1, kind: "tool", depth: 0, title: "write", status: "done", input: "{oops" }
    expect(writesOf([broken, { ...broken, id: "u", input: undefined }])).toEqual([])
  })
})

describe("collisionsIn", () => {
  test("two cards on one file collide; a file only one card wrote does not", () => {
    const collisions = collisionsIn(
      new Map([
        ["coder-a", ["src/game.ts", "src/only-mine.ts"]],
        ["coder-b", ["src/game.ts"]],
      ]),
    )
    expect(collisions).toEqual([{ path: "src/game.ts", cards: ["coder-a", "coder-b"] }])
  })

  test("paths that differ only in punctuation or case are the same file", () => {
    // The collision a check misses because one card wrote `./src/game.ts` is
    // exactly the collision it exists to find.
    const collisions = collisionsIn(
      new Map([
        ["a", ["./src/Game.ts"]],
        ["b", ["src\\game.ts"]],
      ]),
    )
    expect(collisions.map((collision) => collision.cards)).toEqual([["a", "b"]])
  })

  test("what is shown is what the card sent, not the normalised form", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", ["./src/Game.ts"]],
        ["b", ["src/game.ts"]],
      ]),
    )
    expect(collisions[0].path).toBe("./src/Game.ts")
  })

  test("three cards on one file are one finding naming all three", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", ["x.ts"]],
        ["b", ["x.ts"]],
        ["c", ["x.ts"]],
      ]),
    )
    expect(collisions).toEqual([{ path: "x.ts", cards: ["a", "b", "c"] }])
  })

  test("a batch where everyone stayed in their own territory reports nothing", () => {
    expect(
      collisionsIn(
        new Map([
          ["a", ["a.ts"]],
          ["b", ["b.ts"]],
        ]),
      ),
    ).toEqual([])
  })
})

describe("collisionNote", () => {
  test("nothing to report leaves the prompt alone", () => {
    expect(collisionNote([], false)).toBeUndefined()
  })

  test("names the file, names the cards, and says the earlier write is gone", () => {
    const note = collisionNote([{ path: "src/game.ts", cards: ["coder-a", "coder-b"] }], false)!
    expect(note).toContain("src/game.ts")
    expect(note).toContain("coder-a, coder-b")
    expect(note).toContain("only the last")
    // The card whose work went under still reported success — the orchestrator
    // has to be told that, or it builds on an answer describing a file that no
    // longer says that.
    expect(note).toContain("did not fail")
  })

  test("it reports rather than orders a revert", () => {
    // The engine does not know which of the two writes was worth keeping, and a
    // card told to undo the right half spends a round making the work worse.
    const note = collisionNote([{ path: "a.ts", cards: ["a", "b"] }], false)!
    expect(note).not.toContain("revert")
    expect(note).toContain("belongs to **one** card")
  })

  test("a shell-capable card makes the list a floor, and says so", () => {
    expect(collisionNote([{ path: "a.ts", cards: ["a", "b"] }], true)).toContain("least that collided")
    expect(collisionNote([{ path: "a.ts", cards: ["a", "b"] }], false)).not.toContain("least that collided")
  })
})
