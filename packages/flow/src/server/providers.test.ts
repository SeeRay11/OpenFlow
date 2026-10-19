import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ModelInfo } from "../../shared/engine"
import { ENGINE_BASE } from "../../shared/engine"
import { OMP_ROUTES, type OmpProviderRow } from "../../shared/omp"
import { models, setOrigin } from "./client"
import {
  availableModels,
  groupMatches,
  providerRows,
  readyRows,
  searchModels,
  searchProviders,
  unlockedRows,
} from "./providers"

const catalog: ModelInfo[] = [
  { providerID: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, contextWindow: 200_000 },
  { providerID: "anthropic", id: "claude-haiku-5", name: "Claude Haiku 5" },
  { providerID: "openai", id: "gpt-5", name: "GPT-5" },
  { providerID: "openrouter", id: "meta/llama-4" },
  { providerID: "local-llm", id: "tiny" },
]

const providers: OmpProviderRow[] = [
  { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
  { id: "openai", name: "OpenAI", available: true, authenticated: false },
  { id: "openrouter", name: "OpenRouter", available: true, authenticated: true },
  { id: "xai", name: "xAI", available: true, authenticated: true },
  { id: "zai", name: "Z.ai", available: true, authenticated: false },
]

describe("providerRows", () => {
  test("groups models by provider and builds the provider/model value a node stores", () => {
    const rows = providerRows(catalog, providers)
    const anthropic = rows.find((row) => row.id === "anthropic")
    expect(anthropic?.name).toBe("Anthropic")
    expect(anthropic?.models.map((model) => model.value)).toEqual([
      "anthropic/claude-haiku-5",
      "anthropic/claude-opus-5",
    ])
    expect(anthropic?.models[1]).toMatchObject({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      providerID: "anthropic",
      providerName: "Anthropic",
      reasoning: true,
      contextWindow: 200_000,
    })
  })

  test("a model without a name shows its id, and a model id containing a slash stays whole", () => {
    const openrouter = providerRows(catalog, providers).find((row) => row.id === "openrouter")
    expect(openrouter?.models[0]).toMatchObject({ value: "openrouter/meta/llama-4", name: "meta/llama-4", reasoning: false })
  })

  test("authenticated providers unlock; an explicit false locks", () => {
    const rows = providerRows(catalog, providers)
    expect(rows.find((row) => row.id === "anthropic")).toMatchObject({ authenticated: true, unlocked: true })
    expect(rows.find((row) => row.id === "openai")).toMatchObject({ authenticated: false, unlocked: false })
  })

  test("a provider omp serves models for but does not list is unknown, therefore available", () => {
    const row = providerRows(catalog, providers).find((entry) => entry.id === "local-llm")
    expect(row).toMatchObject({ authenticated: undefined, unlocked: true, name: "local-llm" })
    expect(row?.models).toHaveLength(1)
  })

  test("without a provider list nothing is locked", () => {
    const rows = providerRows(catalog)
    expect(rows.every((row) => row.unlocked)).toBe(true)
    expect(availableModels(rows)).toHaveLength(catalog.length)
  })

  test("providers with no models are still rows, so a search can offer to connect them", () => {
    const rows = providerRows(catalog, providers)
    expect(rows.find((row) => row.id === "xai")).toMatchObject({ models: [], unlocked: true })
    expect(rows.find((row) => row.id === "zai")).toMatchObject({ models: [], unlocked: false })
  })

  test("rows with something to pick come first, locked and empty ones last", () => {
    const order = providerRows(catalog, providers).map((row) => row.id)
    expect(order).toEqual(["anthropic", "local-llm", "openrouter", "xai", "openai", "zai"])
  })
})

describe("availability", () => {
  const rows = providerRows(catalog, providers)

  test("availableModels is every model of an unlocked provider", () => {
    expect(availableModels(rows).map((model) => model.value).sort()).toEqual([
      "anthropic/claude-haiku-5",
      "anthropic/claude-opus-5",
      "local-llm/tiny",
      "openrouter/meta/llama-4",
    ])
  })

  test("unlockedRows keeps empty-but-authenticated providers, readyRows drops them", () => {
    expect(unlockedRows(rows).map((row) => row.id)).toContain("xai")
    expect(readyRows(rows).map((row) => row.id)).toEqual(["anthropic", "local-llm", "openrouter"])
  })
})

describe("searchModels", () => {
  const rows = providerRows(catalog, providers)

  test("an empty query lists every available model in row order", () => {
    expect(searchModels(rows, "").map((model) => model.value)).toEqual([
      "anthropic/claude-haiku-5",
      "anthropic/claude-opus-5",
      "local-llm/tiny",
      "openrouter/meta/llama-4",
    ])
  })

  test("a locked provider contributes nothing, even to a query that names its model", () => {
    expect(searchModels(rows, "gpt")).toEqual([])
    expect(searchModels(rows, "openai")).toEqual([])
  })

  test("matches the joined provider/model value", () => {
    expect(searchModels(rows, "anthropic/claude-o").map((model) => model.id)).toEqual(["claude-opus-5"])
    expect(searchModels(rows, "meta/llama").map((model) => model.value)).toEqual(["openrouter/meta/llama-4"])
  })

  test("a provider name brings all of its models", () => {
    expect(searchModels(rows, "Anthropic")).toHaveLength(2)
  })

  test("matches the display name, case-insensitively", () => {
    expect(searchModels(rows, "OPUS").map((model) => model.id)).toEqual(["claude-opus-5"])
  })

  test("the limit holds", () => {
    expect(searchModels(rows, "", 2)).toHaveLength(2)
  })
})

describe("searchProviders", () => {
  const rows = providerRows(catalog, providers)

  test("an empty query keeps every row", () => {
    expect(searchProviders(rows, "  ")).toHaveLength(rows.length)
  })

  test("matches id or display name", () => {
    expect(searchProviders(rows, "z.ai").map((row) => row.id)).toEqual(["zai"])
    expect(searchProviders(rows, "openrouter").map((row) => row.id)).toEqual(["openrouter"])
  })
})

describe("groupMatches", () => {
  test("regroups a flat match list under provider headings, in order", () => {
    const rows = providerRows(catalog, providers)
    const groups = groupMatches(searchModels(rows, ""))
    expect(groups.map((group) => [group.providerID, group.providerName, group.models.length])).toEqual([
      ["anthropic", "Anthropic", 2],
      ["local-llm", "local-llm", 1],
      ["openrouter", "OpenRouter", 1],
    ])
  })
})

describe("from the host", () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === `${ENGINE_BASE}/models`) return Response.json(catalog)
      if (path === OMP_ROUTES.providers) return Response.json(providers)
      return Response.json({ error: "no such route" }, { status: 404 })
    },
  })

  beforeAll(() => setOrigin(server.url.origin))
  afterAll(async () => {
    setOrigin("")
    await server.stop(true)
  })

  test("the catalog and the provider list a browser fetches join into the picker's rows", async () => {
    const fetched = (await (await fetch(`${server.url.origin}${OMP_ROUTES.providers}`)).json()) as OmpProviderRow[]
    const rows = providerRows(await models(), fetched)
    expect(availableModels(rows).map((model) => model.value)).toContain("anthropic/claude-opus-5")
    expect(availableModels(rows).map((model) => model.value)).not.toContain("openai/gpt-5")
  })
})
