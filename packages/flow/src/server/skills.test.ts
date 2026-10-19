import { describe, expect, test } from "bun:test"
import { folderOf, mcpTarget, serverKeyOf, skillTarget } from "./skills"

describe("skillTarget", () => {
  test("a new skill is addressed by its name and may not take another's", () => {
    expect(skillTarget({ name: " notes " })).toEqual({ name: "notes", create: true, address: "notes" })
  })

  test("an edit that keeps the shown name is addressed by the folder it was opened from", () => {
    expect(skillTarget({ original: "my-skill", shown: "My Skill", name: "My Skill" })).toEqual({
      name: "My Skill",
      create: false,
      address: "my-skill",
    })
  })

  test("keeping the folder name is not a rename either", () => {
    expect(skillTarget({ original: "my-skill", shown: "My Skill", name: "my-skill" })).toMatchObject({ create: false, address: "my-skill" })
  })

  test("a changed name is a rename: addressed by the new name, refused when taken", () => {
    expect(skillTarget({ original: "my-skill", shown: "My Skill", name: "Other" })).toEqual({ name: "Other", create: true, address: "Other" })
  })

  test("a skill still in the old project folder keeps its own name", () => {
    expect(skillTarget({ original: "old", shown: "old", name: "old", legacy: true })).toEqual({ name: "old", create: false, address: "old" })
  })
})

describe("a change of name that lands in the folder the skill already has is an edit", () => {
  const open = { original: "my-skill", shown: "My Skill" }

  test("a case-only rename keeps the folder: saved in place, nothing refused", () => {
    expect(skillTarget({ ...open, name: "my skill" })).toEqual({ name: "my skill", create: false, address: "my-skill" })
  })

  test("a punctuation-only rename that slugs to the same folder is saved in place too", () => {
    expect(skillTarget({ ...open, name: "My  Skill!" })).toEqual({ name: "My  Skill!", create: false, address: "my-skill" })
  })

  test("a rename to a different folder still asks the host to refuse a name that is taken", () => {
    expect(skillTarget({ ...open, name: "Other Skill" })).toEqual({ name: "Other Skill", create: true, address: "Other Skill" })
  })

  test("a new skill is a create, and the old project folder's skills keep their own name", () => {
    expect(skillTarget({ name: "My Skill" }).create).toBe(true)
    expect(skillTarget({ original: "old", shown: "old", name: "old2", legacy: true })).toMatchObject({ create: true, address: "old2" })
  })
})

/**
 * These tables are the values `slug` and `mcpName` in `lib/store.ts` return for each name (checked by running them);
 * `folderOf` and `serverKeyOf` replicate them because `src/` never imports `lib/`. If the host's rule changes,
 * this is the table to update, together with the two functions.
 */
describe("the page's copy of the host's naming rules", () => {
  test.each([
    ["My Skill", "my-skill"],
    ["my skill", "my-skill"],
    ["My  Skill!", "my-skill"],
    ["my-skill", "my-skill"],
    ["  Lead.", "lead"],
    ["Ünï Çode", "ünï-çode"],
    ["a/b", "ab"],
    ["...", "untitled"],
    ["Notes_2", "notes_2"],
    ["héllo wörld", "héllo-wörld"],
  ])("folderOf(%p) is %p", (name, folder) => {
    expect(folderOf(name)).toBe(folder)
  })

  test.each([
    ["my server", "my-server"],
    ["my.server", "my-server"],
    ["My-Server", "My-Server"],
    ["a:b", "a-b"],
    [" x ", "x"],
  ])("serverKeyOf(%p) is %p", (name, key) => {
    expect(serverKeyOf(name)).toBe(key)
  })
})

describe("mcpTarget", () => {
  test("a new server, or a different key, asks the host to refuse a name that is taken", () => {
    expect(mcpTarget(undefined, "docs")).toEqual({ create: true, address: "docs" })
    expect(mcpTarget("docs", "wiki")).toEqual({ create: true, address: "wiki" })
    expect(mcpTarget("my.server", "my-server")).toEqual({ create: true, address: "my-server" })
    // Letter case is part of an MCP key: `Docs` and `docs` are two servers.
    expect(mcpTarget("Docs", "docs")).toEqual({ create: true, address: "docs" })
  })

  test("the same key, or a typing that reduces to it, is an edit of the server as it is stored", () => {
    expect(mcpTarget("docs", "docs")).toEqual({ create: false, address: "docs" })
    expect(mcpTarget("my-server", "my server")).toEqual({ create: false, address: "my-server" })
    expect(mcpTarget("my-server", " my-server ")).toEqual({ create: false, address: "my-server" })
  })
})

describe("a skill from the old project folder", () => {
  const old = { original: "old", shown: "old", legacy: true }

  test("saved under its own name it is the plain migration", () => {
    expect(skillTarget({ ...old, name: "old" })).toEqual({ name: "old", create: false, address: "old" })
  })

  test("saved under any other name the host must refuse a name the profile already has, so it cannot overwrite that skill", () => {
    expect(skillTarget({ ...old, name: "docs" })).toEqual({ name: "docs", create: true, address: "docs" })
    expect(skillTarget({ ...old, name: "fresh" })).toEqual({ name: "fresh", create: true, address: "fresh" })
  })
})
