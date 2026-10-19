import { describe, expect, test } from "bun:test"
import { skillTarget } from "./skills"

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
