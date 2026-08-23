import { describe, expect, test } from "bun:test"
import { TOOLS, TOOL_HELP } from "../server/store"

describe("TOOL_HELP", () => {
  test("has a non-empty entry for every tool the inspector renders", () => {
    for (const tool of TOOLS) {
      expect(TOOL_HELP[tool]).toBeString()
      expect(TOOL_HELP[tool].length).toBeGreaterThan(0)
    }
  })

  test("its keys are a superset of the inspector's tool list", () => {
    const help = new Set(Object.keys(TOOL_HELP))
    expect(TOOLS.every((tool) => help.has(tool))).toBe(true)
  })
})
