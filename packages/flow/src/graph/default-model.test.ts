import { beforeEach, describe, expect, test } from "bun:test"
import { defaultModel, nodeModel, setAvailableModels, setDefaultModel } from "./default-model"

beforeEach(() => {
  setDefaultModel(undefined)
  setAvailableModels(new Set<string>())
})

describe("default model preference", () => {
  test("get/set round-trips and clears", () => {
    expect(defaultModel()).toBeUndefined()
    setDefaultModel("test/grok-code-free")
    expect(defaultModel()).toBe("test/grok-code-free")
    setDefaultModel(undefined)
    expect(defaultModel()).toBeUndefined()
  })
})

describe("nodeModel", () => {
  test("a preset's own model always wins, whatever the default", () => {
    expect(nodeModel("anthropic/claude", new Set(), "test/free")).toBe("anthropic/claude")
  })

  test("applies the default only when it is in the available set", () => {
    expect(nodeModel(undefined, new Set(["test/free"]), "test/free")).toBe("test/free")
  })

  test("leaves the model blank when the default is not available", () => {
    expect(nodeModel(undefined, new Set(["test/other"]), "test/free")).toBeUndefined()
  })

  test("leaves the model blank when there is no default", () => {
    expect(nodeModel(undefined, new Set(["test/free"]), undefined)).toBeUndefined()
  })

  test("reads the live signals when no arguments are passed", () => {
    setAvailableModels(new Set(["test/free"]))
    setDefaultModel("test/free")
    expect(nodeModel(undefined)).toBe("test/free")
    setDefaultModel("test/locked")
    expect(nodeModel(undefined)).toBeUndefined()
  })
})
