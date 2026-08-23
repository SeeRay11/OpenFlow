import { beforeEach, describe, expect, test } from "bun:test"
import { defaultModel, nodeModel, setAvailableModels, setDefaultModel } from "./default-model"

beforeEach(() => {
  setDefaultModel(undefined)
  setAvailableModels(new Set<string>())
})

describe("default model preference", () => {
  test("get/set round-trips and clears", () => {
    expect(defaultModel()).toBeUndefined()
    setDefaultModel("opencode/grok-code-free")
    expect(defaultModel()).toBe("opencode/grok-code-free")
    setDefaultModel(undefined)
    expect(defaultModel()).toBeUndefined()
  })
})

describe("nodeModel", () => {
  test("a preset's own model always wins, whatever the default", () => {
    expect(nodeModel("anthropic/claude", new Set(), "opencode/free")).toBe("anthropic/claude")
  })

  test("applies the default only when it is in the available set", () => {
    expect(nodeModel(undefined, new Set(["opencode/free"]), "opencode/free")).toBe("opencode/free")
  })

  test("leaves the model blank when the default is not available", () => {
    expect(nodeModel(undefined, new Set(["opencode/other"]), "opencode/free")).toBeUndefined()
  })

  test("leaves the model blank when there is no default", () => {
    expect(nodeModel(undefined, new Set(["opencode/free"]), undefined)).toBeUndefined()
  })

  test("reads the live signals when no arguments are passed", () => {
    setAvailableModels(new Set(["opencode/free"]))
    setDefaultModel("opencode/free")
    expect(nodeModel(undefined)).toBe("opencode/free")
    setDefaultModel("opencode/locked")
    expect(nodeModel(undefined)).toBeUndefined()
  })
})
