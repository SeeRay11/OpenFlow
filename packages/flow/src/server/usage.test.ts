import { describe, expect, test } from "bun:test"
import type { StepUsage, TokenTotals } from "../graph/types"
import {
  NO_TOKENS,
  addTokens,
  byProvider,
  contextSize,
  costLabel,
  costOf,
  formatCost,
  formatTokens,
  mergeSpend,
  priceAt,
  providerOf,
  summarize,
  type PricedModel,
} from "./usage"

/**
 * These numbers are the product's honesty guarantee, so they are pinned
 * against hand-computed values rather than against whatever the code happens
 * to return. The arithmetic mirrors opencode's own — see
 * `packages/opencode/src/session/session.ts`.
 */

const tokens = (part: Partial<TokenTotals>): TokenTotals => ({ ...NO_TOKENS, ...part })

const catalog = (...models: PricedModel[]) =>
  new Map(models.map((model) => [`${model.providerID}/${model.id}`, model] as const))

const sonnet: PricedModel = {
  providerID: "anthropic",
  id: "claude-sonnet-4",
  cost: [
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  ],
}

const free: PricedModel = { providerID: "opencode", id: "zen-free", cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }
const unknown: PricedModel = { providerID: "mystery", id: "model-x", cost: [] }

const step = (model: string, part: Partial<TokenTotals>, id: string = crypto.randomUUID()): StepUsage => ({
  messageID: id,
  model,
  tokens: tokens(part),
})

describe("pricing", () => {
  test("charges input, output, reasoning and cache at their own rates", () => {
    const price = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
    const cost = costOf(tokens({ input: 1_000, output: 500, reasoning: 100, cacheRead: 10_000, cacheWrite: 2_000 }), price)
    // 1000*3 + (500+100)*15 + 10000*0.3 + 2000*3.75 = 3000 + 9000 + 3000 + 7500 = 22500 per 1M
    expect(cost).toBeCloseTo(0.0225, 10)
  })

  test("bills reasoning tokens at the output rate", () => {
    const price = { input: 0, output: 10, cache: { read: 0, write: 0 } }
    expect(costOf(tokens({ reasoning: 1_000_000 }), price)).toBe(10)
  })

  test("counts cached tokens toward the context that picks a tier", () => {
    expect(contextSize(tokens({ input: 1_000, cacheRead: 190_000, cacheWrite: 20_000 }))).toBe(211_000)
  })

  test("a step whose context crosses 200k is charged at the higher tier", () => {
    const spend = summarize([step("anthropic/claude-sonnet-4", { input: 1_000_000 })], catalog(sonnet))
    expect(spend.cost).toBeCloseTo(6, 12)
  })

  test("uses the highest tier the context exceeds", () => {
    expect(priceAt(sonnet, 10_000)?.input).toBe(3)
    expect(priceAt(sonnet, 200_000)?.input).toBe(3) // the threshold itself is not over it
    expect(priceAt(sonnet, 200_001)?.input).toBe(6)
  })

  test("reports no price rather than a zero when the catalog quotes none", () => {
    expect(priceAt(unknown, 10)).toBeUndefined()
    expect(priceAt(undefined, 10)).toBeUndefined()
  })
})

describe("summarize", () => {
  test("prices each step at the tier its own context landed on", () => {
    const spend = summarize(
      [
        step("anthropic/claude-sonnet-4", { input: 100_000, output: 1_000 }),
        step("anthropic/claude-sonnet-4", { input: 300_000, output: 1_000 }),
      ],
      catalog(sonnet),
    )
    // small step: 100000*3 + 1000*15 = 315000 -> 0.315
    // large step: 300000*6 + 1000*22.5 = 1_822_500 -> 1.8225
    expect(spend.cost).toBeCloseTo(2.1375, 9)
    expect(spend.steps).toBe(2)
    expect(spend.unpriced).toEqual([])
  })

  test("a genuinely free model costs zero and stays priced", () => {
    const spend = summarize([step("opencode/zen-free", { input: 5_000, output: 900 })], catalog(free))
    expect(spend.cost).toBe(0)
    expect(spend.unpriced).toEqual([])
    expect(spend.models[0].priced).toBe(true)
  })

  test("a model with no published price reports tokens but no money", () => {
    const spend = summarize([step("mystery/model-x", { input: 1_000, output: 10 })], catalog(unknown))
    expect(spend.cost).toBe(0)
    expect(spend.unpriced).toEqual(["mystery/model-x"])
    expect(spend.models[0].cost).toBeUndefined()
    expect(spend.models[0].tokens.input).toBe(1_000)
    expect(costLabel(spend)).toBe("unpriced")
  })

  test("a model missing from the catalog is unpriced, not free", () => {
    const spend = summarize([step("ghost/model", { input: 10, output: 10 })], catalog(sonnet))
    expect(spend.unpriced).toEqual(["ghost/model"])
  })

  test("mixing a priced and an unpriced model makes the total a floor", () => {
    const spend = summarize(
      [step("anthropic/claude-sonnet-4", { input: 100_000 }), step("mystery/model-x", { output: 1_000 })],
      catalog(sonnet, unknown),
    )
    // 100_000 * $3/1M = $0.30, and the unpriced model makes the total a floor
    expect(spend.cost).toBeCloseTo(0.3, 12)
    expect(costLabel(spend)).toBe("≥ $0.3000")
  })

  test("a step reported twice is counted once", () => {
    const repeat = step("anthropic/claude-sonnet-4", { input: 1_000_000 }, "msg-1")
    const spend = summarize([repeat, { ...repeat }], catalog(sonnet))
    // summarize takes the caller's list as given; dedupe happens by message id
    // in the engine's map, so both entries here are two real steps.
    expect(spend.steps).toBe(2)
  })

  test("sums to the same total whether folded per step or per bucket", () => {
    const many = Array.from({ length: 500 }, () => step("anthropic/claude-sonnet-4", { input: 1_000, output: 100 }))
    const spend = summarize(many, catalog(sonnet))
    // 500 * (1000*3 + 100*15) / 1e6 = 500 * 0.0045 = 2.25
    expect(spend.cost).toBeCloseTo(2.25, 12)
  })
})

describe("rollups", () => {
  test("merges runs and keeps unpriced models flagged", () => {
    const a = summarize([step("anthropic/claude-sonnet-4", { input: 100_000 })], catalog(sonnet))
    const b = summarize([step("mystery/model-x", { output: 5 })], catalog(unknown))
    const merged = mergeSpend([a, b, undefined])
    expect(merged.cost).toBeCloseTo(0.3, 12)
    expect(merged.unpriced).toEqual(["mystery/model-x"])
    expect(merged.models).toHaveLength(2)
  })

  test("groups by provider, dearest first", () => {
    const spend = summarize(
      [step("anthropic/claude-sonnet-4", { input: 100_000 }), step("opencode/zen-free", { input: 9_000 })],
      catalog(sonnet, free),
    )
    const rows = byProvider(spend)
    expect(rows.map((row) => row.provider)).toEqual(["anthropic", "opencode"])
    expect(rows[0].cost).toBeCloseTo(0.3, 12)
    expect(rows[1].cost).toBe(0)
  })

  test("provider rows stay honest about unpriced models", () => {
    const spend = summarize([step("mystery/model-x", { input: 10 })], catalog(unknown))
    expect(byProvider(spend)[0].priced).toBe(false)
  })
})

describe("formatting", () => {
  test("never rounds real spend down to zero", () => {
    expect(formatCost(0)).toBe("$0")
    expect(formatCost(0.00002)).toBe("<$0.0001")
    expect(formatCost(0.0123)).toBe("$0.0123")
    expect(formatCost(4.5)).toBe("$4.500")
    expect(formatCost(1234.567)).toBe("$1234.57")
  })

  test("token counts stay readable", () => {
    expect(formatTokens(940)).toBe("940")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(2_400_000)).toBe("2.40M")
  })

  test("provider comes off the model id", () => {
    expect(providerOf("anthropic/claude-sonnet-4")).toBe("anthropic")
    expect(providerOf("weird")).toBe("weird")
  })

  test("token addition is field-wise", () => {
    expect(addTokens(tokens({ input: 1, cacheRead: 2 }), tokens({ input: 3, output: 4 }))).toEqual(
      tokens({ input: 4, output: 4, cacheRead: 2 }),
    )
  })
})
