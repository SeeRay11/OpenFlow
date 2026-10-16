import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { SESSION_TREE_MAX_NODES, buildSessionTree } from "./tree"

const session = (id: string, parentID?: string, created = 0): Session => ({
  id,
  slug: id,
  projectID: "p1",
  directory: "/dir",
  title: `Title ${id}`,
  version: "1",
  parentID,
  time: { created, updated: created },
})

describe("buildSessionTree", () => {
  // T-01: root + 2 children + 1 grandchild + 1 orphan renders as a
  // DFS-flattened cluster with newest-first siblings and the orphan at depth 1.
  test("T-01: builds hierarchy with children, grandchild and orphan", () => {
    const tree = buildSessionTree({
      rootID: "root",
      sessions: [
        session("root", undefined, 0),
        session("c1", "root", 100),
        session("c2", "root", 200),
        session("g1", "c1", 300),
        session("o1", "ses_missing", 400),
      ],
    })

    expect(tree.total).toBe(5)
    expect(tree.truncated).toBe(false)
    expect(tree.nodes.map((node) => [node.session.id, node.depth])).toEqual([
      ["root", 0],
      ["o1", 1],
      ["c2", 1],
      ["c1", 1],
      ["g1", 2],
    ])
    expect(tree.root?.children.map((node) => node.session.id)).toEqual(["o1", "c2", "c1"])
    expect(tree.nodes[3]?.children.map((node) => node.session.id)).toEqual(["g1"])
  })

  test("returns an empty cluster when the root is missing", () => {
    const tree = buildSessionTree({ rootID: "nope", sessions: [session("a", "nope", 1)] })
    expect(tree.root).toBeUndefined()
    expect(tree.nodes).toEqual([])
    expect(tree.total).toBe(0)
    expect(tree.truncated).toBe(false)
  })

  test("ignores parentless sessions other than the root", () => {
    const tree = buildSessionTree({ rootID: "root", sessions: [session("root"), session("loose")] })
    expect(tree.total).toBe(1)
    expect(tree.nodes.map((node) => node.session.id)).toEqual(["root"])
  })

  // T-03: 60 sessions cap at 50 nodes while total keeps counting.
  test("T-03: caps nodes at max and reports total + truncated", () => {
    const sessions = [session("root"), ...Array.from({ length: 59 }, (_, i) => session(`c${i}`, "root", i + 1))]
    const tree = buildSessionTree({ rootID: "root", sessions })

    expect(tree.nodes.length).toBe(SESSION_TREE_MAX_NODES)
    expect(tree.total).toBe(60)
    expect(tree.truncated).toBe(true)
    expect(tree.nodes[0]?.session.id).toBe("root")
    // Newest-first: the last kept node is the 49th newest child.
    expect(tree.nodes.at(-1)?.session.id).toBe("c10")
  })

  test("custom max overrides the default cap", () => {
    const sessions = [session("root"), session("a", "root", 1), session("b", "root", 2)]
    const tree = buildSessionTree({ rootID: "root", sessions, max: 2 })
    expect(tree.nodes.map((node) => node.session.id)).toEqual(["root", "b"])
    expect(tree.total).toBe(3)
    expect(tree.truncated).toBe(true)
  })

  test("cycle-guarded: mutually linked descendants never enter the cluster", () => {
    // a↔b point at each other, so neither resolves to an orphan nor a root
    // child; the guard must keep them out of the walk entirely.
    const tree = buildSessionTree({
      rootID: "root",
      sessions: [session("root"), session("a", "b", 1), session("b", "a", 2)],
    })
    expect(tree.nodes.map((node) => node.session.id)).toEqual(["root"])
    expect(tree.total).toBe(1)
    expect(tree.truncated).toBe(false)
  })
})
