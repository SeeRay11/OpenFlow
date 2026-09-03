import { describe, expect, test } from "bun:test"
import { pipeline } from "./test-support"
import { isolates, mergeNote } from "./worktree"

function node(tools?: Record<string, boolean>) {
  const one = pipeline("a").nodes[0]!
  return { ...one, agent: { ...one.agent, tools } }
}

describe("isolates", () => {
  test("a card that can edit or run commands gets its own tree", () => {
    expect(isolates(node({ edit: true }))).toBe(true)
    expect(isolates(node({ bash: true }))).toBe(true)
  })

  // An unlisted tool inherits the default agent's allow, so a map that names
  // only reads still describes a card that can write.
  test("a tool the map does not name is not a denial", () => {
    expect(isolates(node({ read: true }))).toBe(true)
    expect(isolates(node())).toBe(true)
  })

  test("a card with both switched off reads the project directly", () => {
    expect(isolates(node({ edit: false, bash: false }))).toBe(false)
  })

  test("write and patch fold onto edit, the way the config does", () => {
    expect(isolates(node({ write: false, bash: false }))).toBe(false)
  })
})

describe("mergeNote", () => {
  test("a clean batch is not narrated", () => {
    expect(mergeNote({ merged: ["a", "b"], empty: [], conflicts: [] })).toBe("")
    expect(mergeNote({ merged: [], empty: ["a"], conflicts: [] })).toBe("")
  })

  test("names the card and the paths it could not land", () => {
    const note = mergeNote({ merged: ["a"], empty: [], conflicts: [{ card: "b", paths: ["src/x.ts", "src/y.ts"] }] })
    expect(note).toContain("b: src/x.ts, src/y.ts")
  })

  // Each of these is a decision the orchestrator gets wrong when it is left to
  // infer: what is on disk, whether the work survived, and what to do next.
  test("says the file is the first card's, that the rest of the work landed, and that a repeat will fail", () => {
    const note = mergeNote({ merged: ["a"], empty: [], conflicts: [{ card: "b", paths: ["src/x.ts"] }] })
    expect(note).toContain("merged first")
    expect(note).toContain("its other files were applied")
    expect(note).toContain("conflict again")
  })
})
