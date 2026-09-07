import { describe, expect, test } from "bun:test"
import { TREE, type Write } from "./collisions"
import { addDiff, attribute, deltaOf, diffLabel, diffTitle } from "./diff"

const wrote = (entries: Record<string, string[]>) =>
  new Map<string, Write[]>(Object.entries(entries).map(([card, paths]) => [card, paths.map((path) => ({ path }))]))

describe("attribute", () => {
  test("a file one card wrote is that card's, exactly", () => {
    const { cards } = attribute(
      [
        { path: "src/a.ts", added: 10, removed: 2 },
        { path: "src/b.ts", added: 4, removed: 0 },
      ],
      wrote({ alice: ["/repo/src/a.ts"], bob: ["/repo/src/b.ts"] }),
    )
    expect(cards.get("alice")).toEqual({ added: 10, removed: 2, files: 1 })
    expect(cards.get("bob")).toEqual({ added: 4, removed: 0, files: 1 })
  })

  test("a file two cards wrote is neither card's, and says so on both", () => {
    const { cards } = attribute(
      [{ path: "src/a.ts", added: 10, removed: 2 }],
      wrote({ alice: ["src/a.ts"], bob: ["src/a.ts"] }),
    )
    expect(cards.get("alice")).toEqual({ added: 10, removed: 2, files: 1, shared: ["bob"] })
    expect(cards.get("bob")).toEqual({ added: 10, removed: 2, files: 1, shared: ["alice"] })
  })

  test("a card that rewrote the whole tree shares every file in the batch", () => {
    const { cards } = attribute(
      [{ path: "src/a.ts", added: 3, removed: 1 }],
      new Map<string, Write[]>([
        ["alice", [{ path: "src/a.ts" }]],
        ["reset", [{ path: TREE, probable: true }]],
      ]),
    )
    expect(cards.get("alice")?.shared).toEqual(["reset"])
    expect(cards.get("reset")).toEqual({ added: 3, removed: 1, files: 1, shared: ["alice"] })
  })

  test("a file nobody claimed is reported unattributed rather than given away", () => {
    const { cards, unclaimed } = attribute(
      [
        { path: "dist/bundle.js", added: 900, removed: 0 },
        { path: "src/a.ts", added: 2, removed: 0 },
      ],
      wrote({ alice: ["src/a.ts"] }),
    )
    expect(cards.get("alice")).toEqual({ added: 2, removed: 0, files: 1 })
    expect(unclaimed.map((entry) => entry.path)).toEqual(["dist/bundle.js"])
  })

  test("an absolute write path matches the path git reports it under", () => {
    const { cards } = attribute(
      [{ path: "packages/flow/src/app.tsx", added: 1, removed: 1 }],
      wrote({ alice: ["C:\\Users\\me\\project\\packages\\flow\\src\\app.tsx"] }),
    )
    expect(cards.get("alice")?.files).toBe(1)
  })

  test("a suffix that is not a path boundary is a different file", () => {
    const { cards, unclaimed } = attribute(
      [{ path: "src/app.tsx", added: 1, removed: 0 }],
      wrote({ alice: ["/repo/xsrc/app.tsx"] }),
    )
    expect(cards.size).toBe(0)
    expect(unclaimed).toHaveLength(1)
  })

  test("a card that wrote nothing measurable gets no entry at all", () => {
    const { cards } = attribute([], wrote({ reader: ["src/a.ts"] }))
    expect(cards.has("reader")).toBe(false)
  })
})

describe("deltaOf", () => {
  test("only what moved between the snapshots is the batch's", () => {
    const before = [{ path: "a.ts", added: 5, removed: 0 }]
    const after = [
      { path: "a.ts", added: 12, removed: 2 },
      { path: "b.ts", added: 4, removed: 0 },
    ]
    expect(deltaOf(before, after)).toEqual([
      { path: "a.ts", added: 7, removed: 2 },
      { path: "b.ts", added: 4, removed: 0 },
    ])
  })

  test("a file put back is a negative, not an absence", () => {
    expect(deltaOf([{ path: "a.ts", added: 5, removed: 1 }], [])).toEqual([{ path: "a.ts", added: -5, removed: -1 }])
  })

  test("a file nobody touched is left out", () => {
    const same = [{ path: "a.ts", added: 5, removed: 0 }]
    expect(deltaOf(same, same)).toEqual([])
  })
})

describe("addDiff", () => {
  test("a re-dispatched card totals its batches", () => {
    expect(addDiff({ added: 3, removed: 1, files: 1 }, { added: 4, removed: 0, files: 2 })).toEqual({
      added: 7,
      removed: 1,
      files: 3,
    })
  })

  test("sharing in either batch is kept, once", () => {
    expect(
      addDiff(
        { added: 1, removed: 0, files: 1, shared: ["bob"] },
        { added: 1, removed: 0, files: 1, shared: ["bob", "eve"] },
      ).shared,
    ).toEqual(["bob", "eve"])
  })
})

describe("diffLabel", () => {
  test("no measurement renders nothing, and a measured zero renders as one", () => {
    expect(diffLabel(undefined)).toBe("")
    expect(diffLabel({ added: 0, removed: 0, files: 0 })).toBe("±0")
  })

  test("both halves, minus sign not hyphen", () => {
    expect(diffLabel({ added: 42, removed: 7, files: 2 })).toBe("+42 −7")
    expect(diffLabel({ added: 42, removed: 0, files: 1 })).toBe("+42")
  })

  test("the title says why a shared figure is not this card's", () => {
    expect(diffTitle({ added: 5, removed: 1, files: 1, shared: ["bob"] })).toContain("shared with bob")
    expect(diffTitle({ added: 5, removed: 1, files: 1 })).toBe("+5 / −1 across 1 file")
  })
})
