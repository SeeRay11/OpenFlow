import { describe, expect, test } from "bun:test"
import path from "node:path"
import { COMPATIBLE_PROFILES, globalConfigCandidates, isV1Config, repackage, repackaged } from "./repackage"

describe("globalConfigCandidates", () => {
  test("follows XDG_CONFIG_HOME when it is set", () => {
    expect(globalConfigCandidates({ XDG_CONFIG_HOME: "/cfg" }, "/home/x")[0]).toBe(
      path.join("/cfg", "opencode", "opencode.json"),
    )
  })

  test("falls back to ~/.config, and offers .jsonc second", () => {
    expect(globalConfigCandidates({}, "/home/x")).toEqual([
      path.join("/home/x", ".config", "opencode", "opencode.json"),
      path.join("/home/x", ".config", "opencode", "opencode.jsonc"),
    ])
  })
})

describe("repackage", () => {
  test("writes the v2 shape into a config with no v1 key", () => {
    const { value, changed } = repackage({ $schema: "x", model: "opencode/y" }, ["openrouter"])
    expect(changed).toEqual(["openrouter"])
    expect(value.providers.openrouter.api).toEqual({
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: COMPATIBLE_PROFILES.openrouter,
    })
    expect(value.provider).toBeUndefined()
  })

  // One v1 key sends the whole file through the v1 migration, where `providers`
  // is not read at all — the override has to follow the file's dialect.
  test("writes the v1 shape into a config that already carries a v1 key", () => {
    const { value } = repackage({ plugin: ["./p.js"] }, ["groq"])
    expect(value.provider.groq).toEqual({ npm: "@ai-sdk/openai-compatible", api: COMPATIBLE_PROFILES.groq })
    expect(value.providers).toBeUndefined()
  })

  test("keeps the rest of an existing provider entry", () => {
    const { value } = repackage({ provider: { groq: { name: "Groq", models: { a: {} } } } }, ["groq"])
    expect(value.provider.groq.name).toBe("Groq")
    expect(value.provider.groq.models).toEqual({ a: {} })
    expect(value.provider.groq.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("reports nothing changed when the override is already there", () => {
    const first = repackage({}, ["openrouter"])
    expect(repackage(first.value, ["openrouter"]).changed).toEqual([])
  })

  test("ignores a provider the runner has no OpenAI-compatible profile for", () => {
    expect(repackage({}, ["google", "openrouter"]).changed).toEqual(["openrouter"])
  })

  test("does not mutate the config it was given", () => {
    const config = { $schema: "x" }
    repackage(config, ["groq"])
    expect(config).toEqual({ $schema: "x" })
  })
})

describe("repackaged", () => {
  test("reads both dialects, and rejects a different package or url", () => {
    expect(repackaged({ provider: { groq: { npm: "@ai-sdk/openai-compatible", api: COMPATIBLE_PROFILES.groq } } })).toEqual([
      "groq",
    ])
    expect(repackaged(repackage({}, ["xai"]).value)).toEqual(["xai"])
    expect(repackaged({ provider: { groq: { npm: "@ai-sdk/groq" } } })).toEqual([])
    expect(repackaged({ provider: { groq: { npm: "@ai-sdk/openai-compatible", api: "https://example.test" } } })).toEqual(
      [],
    )
    expect(repackaged({})).toEqual([])
  })
})

describe("isV1Config", () => {
  test("one v1 key claims the whole file", () => {
    expect(isV1Config({ model: "x", plugin: [] })).toBe(true)
    expect(isV1Config({ model: "x", providers: {} })).toBe(false)
    expect(isV1Config(undefined)).toBe(false)
  })
})
