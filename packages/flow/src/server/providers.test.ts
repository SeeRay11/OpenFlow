import { describe, expect, test } from "bun:test"
import type { Integration } from "./client"
import {
  availableModels,
  freeModels,
  groupMatches,
  isActive,
  isConnected,
  isFreeModel,
  providerRows,
  readyRows,
  runnable,
  searchModels,
  searchProviders,
  splitProviders,
  suggestedFreeDefault,
  unlockedRows,
  usableCount,
} from "./providers"

function integration(id: string, options: { name?: string; env?: string[]; credentials?: string[] } = {}): Integration {
  return {
    id,
    name: options.name ?? id,
    methods: [{ type: "key" }, ...(options.env ? [{ type: "env", names: options.env }] : [])],
    connections: (options.credentials ?? []).map((credential) => ({ type: "credential", id: credential })),
  }
}

const catalog = [
  integration("groq", { name: "Groq", env: ["GROQ_API_KEY"], credentials: ["cred_groq"] }),
  integration("anthropic", { name: "Anthropic", env: ["ANTHROPIC_API_KEY"] }),
  integration("openrouter", { name: "OpenRouter", env: ["OPENROUTER_API_KEY"], credentials: ["cred_or"] }),
  integration("opencode", { name: "OpenCode Zen" }),
]

const compatible = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://example.test/v1" }
const groqSdk = { type: "aisdk", package: "@ai-sdk/groq" }

const models = [
  { id: "llama-4", providerID: "groq", name: "Llama 4", api: groqSdk },
  { id: "kimi-k2", providerID: "groq", name: "Kimi K2", api: compatible },
  { id: "nemotron", providerID: "opencode", name: "Nemotron", api: compatible },
]

describe("runnable", () => {
  test("accepts the three shapes the session runner actually routes", () => {
    expect(runnable({ type: "aisdk", package: "@ai-sdk/openai" })).toBe(true)
    expect(runnable({ type: "aisdk", package: "@ai-sdk/anthropic" })).toBe(true)
    expect(runnable(compatible)).toBe(true)
  })

  test("rejects provider-specific packages, which fail with UnsupportedApiError", () => {
    expect(runnable(groqSdk)).toBe(false)
    expect(runnable({ type: "aisdk", package: "@openrouter/ai-sdk-provider" })).toBe(false)
    expect(runnable({ type: "aisdk", package: "@ai-sdk/google" })).toBe(false)
  })

  test("openai-compatible without a base URL has nowhere to send the request", () => {
    expect(runnable({ type: "aisdk", package: "@ai-sdk/openai-compatible" })).toBe(false)
  })

  test("native and missing api shapes are not routed", () => {
    expect(runnable({ type: "native", url: "https://example.test" })).toBe(false)
    expect(runnable(undefined)).toBe(false)
  })
})

describe("providerRows", () => {
  test("joins the catalog with the models the server would actually accept", () => {
    const rows = providerRows(catalog, models)
    const groq = rows.find((row) => row.id === "groq")!
    expect(groq.models.map((model) => model.value)).toEqual(["groq/kimi-k2", "groq/llama-4"])
    expect(groq.env).toEqual(["GROQ_API_KEY"])
    expect(isActive(groq)).toBe(true)
    expect(isConnected(groq)).toBe(true)
  })

  test("counts only the models this build can dispatch, and lists them first", () => {
    const rows = providerRows(catalog, models)
    const groq = rows.find((row) => row.id === "groq")!
    expect(usableCount(groq)).toBe(1)
    // The unrunnable one sinks below the runnable one rather than disappearing.
    expect(groq.models.map((model) => [model.id, model.runnable])).toEqual([
      ["kimi-k2", true],
      ["llama-4", false],
    ])
    expect(groq.models[1].api).toBe("@ai-sdk/groq")
  })

  test("a provider whose every model is unroutable ranks below one that works", () => {
    const rows = providerRows(
      [integration("openrouter", { name: "OpenRouter" }), integration("nvidia", { name: "Nvidia" })],
      [
        { id: "gpt-oss", providerID: "openrouter", api: { type: "aisdk", package: "@openrouter/ai-sdk-provider" } },
        { id: "nemotron", providerID: "nvidia", api: compatible },
      ],
    )
    expect(rows.map((row) => row.id)).toEqual(["nvidia", "openrouter"])
    const openrouter = rows[1]
    expect(isActive(openrouter)).toBe(true)
    expect(usableCount(openrouter)).toBe(0)
  })

  test("a stored key that yields no models still reads as connected, not as ready", () => {
    const rows = providerRows(catalog, models)
    const openrouter = rows.find((row) => row.id === "openrouter")!
    expect(isConnected(openrouter)).toBe(true)
    expect(isActive(openrouter)).toBe(false)
  })

  test("a provider with neither a key nor models is offered but inert", () => {
    const rows = providerRows(catalog, models)
    const anthropic = rows.find((row) => row.id === "anthropic")!
    expect(isConnected(anthropic)).toBe(false)
    expect(isActive(anthropic)).toBe(false)
    expect(anthropic.keyable).toBe(true)
  })

  test("orders ready, then keyed-but-silent, then the rest", () => {
    const rows = providerRows(catalog, models)
    expect(rows.map((row) => row.id)).toEqual(["groq", "opencode", "openrouter", "anthropic"])
  })

  test("a provider is locked until a key is stored or its env var is really set", () => {
    const rows = providerRows(catalog, models)
    // groq holds a stored credential; opencode serves free models to a browser
    // that has never seen a key, and must not count as connected.
    expect(rows.filter((row) => row.unlocked).map((row) => row.id).sort()).toEqual(["groq", "openrouter"])
    expect(unlockedRows(rows).map((row) => row.id).sort()).toEqual(["groq", "openrouter"])
    expect(readyRows(rows).map((row) => row.id)).toEqual(["groq"])
  })

  test("an environment variable that is actually set unlocks the provider", () => {
    const rows = providerRows(catalog, models, ["ANTHROPIC_API_KEY"])
    const anthropic = rows.find((row) => row.id === "anthropic")!
    expect(anthropic.unlocked).toBe(true)
    expect(anthropic.envSet).toEqual(["ANTHROPIC_API_KEY"])
    // Still no key of ours — the dialog must not offer to remove one.
    expect(isConnected(anthropic)).toBe(false)
  })

  test("an environment variable the provider declares but the host lacks changes nothing", () => {
    const rows = providerRows(catalog, models, ["SOMETHING_ELSE"])
    expect(rows.find((row) => row.id === "anthropic")!.unlocked).toBe(false)
    expect(rows.find((row) => row.id === "opencode")!.unlocked).toBe(false)
  })

  test("drops catalog models the provider itself does not serve", () => {
    // models.dev listed 90 zen models on 2026-08-13; zen served 61. The 29
    // ghosts answer a run with `401 Model X is not supported`.
    const serves = new Map([["opencode", new Set(["nemotron"])]])
    const rows = providerRows(
      [integration("opencode", { name: "OpenCode Zen", credentials: ["cred_zen"] })],
      [
        { id: "nemotron", providerID: "opencode", api: compatible },
        { id: "kimi-k2", providerID: "opencode", api: compatible },
      ],
      [],
      serves,
    )
    expect(rows[0].models.map((model) => model.id)).toEqual(["nemotron"])
  })

  test("a provider with no entry in the served map is left exactly as the catalog reports it", () => {
    const serves = new Map([["opencode", new Set(["nemotron"])]])
    const rows = providerRows(catalog, models, [], serves)
    expect(rows.find((row) => row.id === "groq")!.models).toHaveLength(2)
  })

  test("keeps models whose provider the integration list omits", () => {
    // Environment-variable providers appear in the model list; an integration
    // list that lags behind must not delete them from the dropdown.
    const rows = providerRows([], [{ id: "gpt-5", providerID: "openai", name: "GPT-5" }])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("openai")
    expect(rows[0].keyable).toBe(false)
    expect(isActive(rows[0])).toBe(true)
    // Nothing here can be keyed, so hiding its models would hide them forever.
    expect(rows[0].unlocked).toBe(true)
  })
})

describe("free models", () => {
  const option = (over: Partial<ReturnType<typeof optionBase>> = {}) => ({ ...optionBase(), ...over })
  function optionBase() {
    return {
      value: "opencode/nemotron-3.5-lightning-free",
      id: "nemotron-3.5-lightning-free",
      name: "Nemotron 3.5 Lightning (free)",
      providerID: "opencode",
      providerName: "OpenCode Zen",
      runnable: true,
      api: "@ai-sdk/openai-compatible",
    }
  }

  test("accepts an opencode runnable model whose id ends in -free", () => {
    expect(isFreeModel(option())).toBe(true)
  })

  test("rejects a free-suffixed model from another provider", () => {
    expect(isFreeModel(option({ value: "groq/x-free", id: "x-free", providerID: "groq" }))).toBe(false)
  })

  test("rejects an unrunnable free model", () => {
    expect(isFreeModel(option({ runnable: false }))).toBe(false)
  })

  test("rejects an opencode model without the suffix", () => {
    expect(isFreeModel(option({ value: "opencode/nemotron", id: "nemotron" }))).toBe(false)
  })

  test("freeModels and suggestedFreeDefault pick the runnable free zen models", () => {
    const rows = providerRows(
      [integration("opencode", { name: "OpenCode Zen" })],
      [
        { id: "grok-code-free", providerID: "opencode", name: "Grok Code (free)", api: compatible },
        { id: "kimi-k2", providerID: "opencode", name: "Kimi K2", api: compatible },
        { id: "dead-free", providerID: "opencode", name: "Dead (free)", api: groqSdk },
      ],
    )
    expect(freeModels(rows).map((model) => model.value)).toEqual(["opencode/grok-code-free"])
    expect(suggestedFreeDefault(rows)).toBe("opencode/grok-code-free")
  })

  test("no free model served means no suggestion and no crash", () => {
    const rows = providerRows(catalog, models)
    expect(freeModels(rows)).toEqual([])
    expect(suggestedFreeDefault(rows)).toBeUndefined()
  })
})

describe("a fresh install: no stored key, no environment variable", () => {
  // Zen ids as the server really serves them: two keyless free ones, one paid
  // model on the same provider, and a free id whose api the runner cannot route.
  const zen = [
    { id: "nemotron-3.5-lightning-free", providerID: "opencode", name: "Nemotron 3.5 Lightning (free)", api: compatible },
    { id: "hy3-free", providerID: "opencode", name: "HY3 (free)", api: compatible },
    { id: "claude-opus-5", providerID: "opencode", name: "Claude Opus 5", api: compatible },
    { id: "gemini-3-free", providerID: "opencode", name: "Gemini 3 (free)", api: { type: "aisdk", package: "@ai-sdk/google" } },
  ]
  const fresh = (serves?: Map<string, Set<string>>) =>
    providerRows(
      [integration("opencode", { name: "OpenCode Zen" }), integration("anthropic", { name: "Anthropic", env: ["ANTHROPIC_API_KEY"] })],
      zen,
      [],
      serves,
    )

  test("offers the free zen models to a user who has connected nothing", () => {
    expect(availableModels(fresh()).map((model) => model.value)).toEqual([
      "opencode/hy3-free",
      "opencode/nemotron-3.5-lightning-free",
    ])
    expect(searchModels(fresh(), "").map((model) => model.value)).toEqual([
      "opencode/hy3-free",
      "opencode/nemotron-3.5-lightning-free",
    ])
  })

  test("a paid zen model still needs a key, so a fresh install cannot spend money", () => {
    expect(availableModels(fresh()).some((model) => model.id === "claude-opus-5")).toBe(false)
    expect(searchModels(fresh(), "claude")).toEqual([])
    const keyed = providerRows([integration("opencode", { name: "OpenCode Zen", credentials: ["cred_zen"] })], zen)
    expect(availableModels(keyed).map((model) => model.id)).toContain("claude-opus-5")
  })

  test("a free id the runner cannot route is not offered — it would fail silently", () => {
    // zen's gemini-* are `@ai-sdk/google`; a node dispatching one produces no
    // assistant message at all, which reads as OpenFlow hanging.
    const opencode = fresh().find((row) => row.id === "opencode")!
    expect(opencode.models.find((model) => model.id === "gemini-3-free")!.free).toBe(false)
    expect(availableModels(fresh()).some((model) => model.id === "gemini-3-free")).toBe(false)
  })

  test("the free flag rides on the model, so the picker can label it", () => {
    const opencode = fresh().find((row) => row.id === "opencode")!
    expect(opencode.models.filter((model) => model.free).map((model) => model.id)).toEqual([
      "hy3-free",
      "nemotron-3.5-lightning-free",
    ])
    expect(opencode.models.find((model) => model.id === "claude-opus-5")!.free).toBe(false)
  })

  test("free models do not make their provider read as connected", () => {
    // The distinction the whole gate rests on: the server being generous is not
    // the user having connected zen. A remove-key button here would remove
    // nothing, and the paid models must stay locked.
    const opencode = fresh().find((row) => row.id === "opencode")!
    expect(opencode.unlocked).toBe(false)
    expect(isConnected(opencode)).toBe(false)
    expect(unlockedRows(fresh()).map((row) => row.id)).toEqual([])
  })

  test("a locked provider with no free model still contributes nothing", () => {
    // openrouter and groq keep the old behaviour exactly: no key, no env var,
    // no models — the `-free` suffix means nothing outside zen.
    const rows = providerRows(
      [integration("openrouter", { name: "OpenRouter", env: ["OPENROUTER_API_KEY"] })],
      [{ id: "grok-4-free", providerID: "openrouter", name: "Grok 4 free", api: compatible }],
    )
    expect(availableModels(rows)).toEqual([])
    expect(searchModels(rows, "")).toEqual([])
  })

  test("an unreachable zen list leaves the free models available rather than wiping them", () => {
    // `serves` undefined is UNKNOWN, not empty: an offline user keeps every zen
    // model, including the only ones they can run without a key.
    expect(availableModels(fresh(undefined)).map((model) => model.value)).toEqual([
      "opencode/hy3-free",
      "opencode/nemotron-3.5-lightning-free",
    ])
  })

  test("a free id zen no longer serves is dropped like any other ghost", () => {
    const serves = new Map([["opencode", new Set(["nemotron-3.5-lightning-free"])]])
    expect(availableModels(fresh(serves)).map((model) => model.value)).toEqual([
      "opencode/nemotron-3.5-lightning-free",
    ])
  })

  test("a search that names a free model finds it on the locked provider", () => {
    expect(searchModels(fresh(), "nemotron").map((model) => model.value)).toEqual([
      "opencode/nemotron-3.5-lightning-free",
    ])
    // A provider-name hit still cannot drag the paid models along.
    expect(searchModels(fresh(), "zen").map((model) => model.id)).toEqual(["hy3-free", "nemotron-3.5-lightning-free"])
  })

  test("connecting a provider adds its models without disturbing the free ones", () => {
    const rows = providerRows(
      [integration("opencode", { name: "OpenCode Zen" }), integration("anthropic", { name: "Anthropic", env: ["ANTHROPIC_API_KEY"] })],
      [...zen, { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", api: { type: "aisdk", package: "@ai-sdk/anthropic" } }],
      ["ANTHROPIC_API_KEY"],
    )
    expect(availableModels(rows).map((model) => model.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "opencode/hy3-free",
      "opencode/nemotron-3.5-lightning-free",
    ])
  })
})

describe("splitProviders", () => {
  test("puts opencode's featured six first, in their order, then the rest by name", () => {
    const rows = providerRows(
      [
        integration("groq", { name: "Groq" }),
        integration("openai", { name: "OpenAI" }),
        integration("anthropic", { name: "Anthropic" }),
        integration("cerebras", { name: "Cerebras" }),
      ],
      [],
    )
    const { popular, other } = splitProviders(rows)
    expect(popular.map((row) => row.id)).toEqual(["anthropic", "openai"])
    expect(other.map((row) => row.id)).toEqual(["cerebras", "groq"])
  })
})

describe("searchModels", () => {
  const rows = providerRows(catalog, models)

  test("a locked provider contributes nothing, so a fresh install has no models", () => {
    const fresh = providerRows(
      [integration("opencode", { name: "OpenCode Zen" })],
      [{ id: "nemotron", providerID: "opencode", name: "Nemotron", api: compatible }],
    )
    expect(searchModels(fresh, "")).toEqual([])
  })

  test("empty query lists every model of every unlocked provider", () => {
    expect(searchModels(rows, "").map((model) => model.value)).toEqual(["groq/kimi-k2", "groq/llama-4"])
  })

  test("matches the provider/model value users actually type", () => {
    expect(searchModels(rows, "groq/kimi").map((model) => model.value)).toEqual(["groq/kimi-k2"])
  })

  test("a provider match keeps all of its models", () => {
    expect(searchModels(rows, "Groq")).toHaveLength(2)
  })

  test("a display-name match finds a model whose id does not contain the query", () => {
    expect(searchModels(rows, "llama").map((model) => model.value)).toEqual(["groq/llama-4"])
  })

  test("respects the limit so a 6000-model catalog cannot lock the dropdown", () => {
    expect(searchModels(rows, "", 2)).toHaveLength(2)
  })
})

describe("searchProviders", () => {
  const rows = providerRows(catalog, models)

  test("matches on id, name and environment variable", () => {
    expect(searchProviders(rows, "anthropic").map((row) => row.id)).toEqual(["anthropic"])
    expect(searchProviders(rows, "zen").map((row) => row.id)).toEqual(["opencode"])
    expect(searchProviders(rows, "GROQ_API_KEY").map((row) => row.id)).toEqual(["groq"])
  })

  test("empty query returns everything", () => {
    expect(searchProviders(rows, "  ")).toHaveLength(4)
  })
})

describe("groupMatches", () => {
  test("regroups a flat match list under one heading per provider run", () => {
    // opencode's free models join the list only once its key is stored.
    const rows = providerRows(
      [...catalog.filter((item) => item.id !== "opencode"), integration("opencode", { credentials: ["cred_zen"] })],
      models,
    )
    const groups = groupMatches(searchModels(rows, ""))
    expect(groups.map((group) => [group.providerID, group.models.length])).toEqual([
      ["groq", 2],
      ["opencode", 1],
    ])
  })
})
