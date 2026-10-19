import { isCritic, orchestrationShape } from "./orchestration"
import { swarmShape } from "./swarm"
import { dispatchesOf, gauntletOf, modeOf, roundsOf, spendCapOf, verifyOf, type Pipeline } from "./types"

/**
 * What a run is likely to cost, said before anything is spent.
 *
 * This is the one number in OpenFlow that is a guess, so it is built to be an
 * honest one rather than a precise-looking one:
 *
 * - **A range, never a point.** A card's turn is a whole agentic loop — read
 *   files, call tools, write — and its size depends on the task and the repo,
 *   which nothing here can see. The two ends are a short turn and a heavy one
 *   at list price, and the label says "rough".
 * - **Turns are counted from the graph.** That part is not a guess: a pipeline
 *   card answers once, a swarm peer once a round, and an orchestration's ceiling
 *   is `worstCase`'s arithmetic. The low end assumes every orchestrator hands
 *   each child one task; the high end assumes it uses every dispatch it has.
 * - **An unpriced model is named, not counted as free.** Same rule as
 *   `server/usage.ts`. A local model is priced — at zero — by its config.
 * - **A gauntlet has no high end.** It loops until the bar clears, so the only
 *   honest ceiling is the cap.
 *
 * Measured spend always beats this: once a canvas has run, the runbar shows the
 * last run's real number beside it.
 */

/** USD per 1M tokens, the base row of a catalog price. */
export type TurnPrice = { input: number; output: number }

/**
 * Tokens one card turn uses, at the two ends. Input dominates an agentic turn:
 * every tool step re-sends the growing context, which is also what a provider's
 * prompt cache discounts — so this is list price before any cache hit.
 */
export const TURN_TOKENS = {
  low: { input: 15_000, output: 1_500 },
  high: { input: 150_000, output: 8_000 },
}

export type Estimate = {
  /** USD at the light end, priced models only. */
  low: number
  /** USD at the heavy end; undefined when the run has no ceiling but the cap. */
  high?: number
  /** Card turns at each end. */
  turns: { low: number; high?: number }
  /** `providerID/modelID` of every model with no published price. */
  unpriced: string[]
  cap: number
}

export function estimate(pipeline: Pipeline, prices: Map<string, TurnPrice>): Estimate {
  const turns = turnsOf(pipeline)
  const unpriced = new Set<string>()
  let low = 0
  let high = 0
  for (const node of pipeline.nodes) {
    const count = turns.get(node.id)
    if (!count) continue
    const model = node.agent.model
    const price = model ? prices.get(model) : undefined
    if (!price) {
      if (model) unpriced.add(model)
      continue
    }
    low += count.low * cost(TURN_TOKENS.low, price)
    high += (count.high ?? 0) * cost(TURN_TOKENS.high, price)
  }
  const open = [...turns.values()].some((count) => count.high === undefined)
  const total = (pick: (count: { low: number; high?: number }) => number | undefined) =>
    [...turns.values()].reduce((sum, count) => sum + (pick(count) ?? 0), 0)
  return {
    low,
    high: open ? undefined : high,
    turns: { low: total((count) => count.low), high: open ? undefined : total((count) => count.high) },
    unpriced: [...unpriced],
    cap: spendCapOf(pipeline),
  }
}

/**
 * How many turns each card can take, at each end.
 *
 * Verification adds one turn per reviewer card, in every mode it applies to.
 */
export function turnsOf(pipeline: Pipeline) {
  const result = new Map<string, { low: number; high?: number }>()
  const mode = modeOf(pipeline)

  if (mode === "swarm") {
    const shape = swarmShape(pipeline)
    const rounds = roundsOf(pipeline)
    for (const node of shape.agents) result.set(node.id, { low: rounds, high: rounds })
    for (const node of shape.synthesizers.slice(0, 1)) result.set(node.id, { low: 1, high: 1 })
  }

  if (mode === "orchestration") {
    const shape = orchestrationShape(pipeline)
    const open = !!gauntletOf(pipeline)
    const dispatches = dispatchesOf(pipeline)
    // `runs` is how many assignments a card can receive; a card with children
    // takes one turn per dispatch it makes, plus the one that answers.
    const walk = (id: string, runs: { low: number; high: number }, guard: Set<string>) => {
      if (guard.has(id)) return
      guard.add(id)
      const children = shape.children(id)
      const own = children.length
        ? { low: runs.low * 2, high: runs.high * (dispatches + 1) }
        : { low: runs.low, high: runs.high }
      result.set(id, open ? { low: own.low } : own)
      for (const child of children) walk(child, { low: runs.low, high: runs.high * dispatches }, guard)
      guard.delete(id)
    }
    if (shape.roots.length === 1) walk(shape.root.id, { low: 1, high: 1 }, new Set())
  }

  if (mode === "pipeline") for (const node of pipeline.nodes) result.set(node.id, { low: 1, high: 1 })

  if (verifyOf(pipeline))
    for (const node of pipeline.nodes.filter(isCritic)) {
      const count = result.get(node.id) ?? { low: 0, high: 0 }
      result.set(node.id, { low: count.low + 1, high: count.high === undefined ? undefined : count.high + 1 })
    }

  return result
}

function cost(tokens: { input: number; output: number }, price: TurnPrice) {
  return (tokens.input * price.input + tokens.output * price.output) / 1_000_000
}

/** One line for the runbar: "≈ $0.04–$0.61", or "up to the $5 cap" for an open run. */
export function estimateLabel(value: Estimate) {
  const money = (amount: number) => (amount === 0 ? "$0" : amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`)
  // Part of the run has no price, so whatever is shown is a floor.
  const floor = value.unpriced.length ? "≥ " : "≈ "
  if (value.high === undefined) return `${floor}${money(value.low)}+, up to the $${value.cap} cap`
  if (value.high === 0 && value.low === 0) return value.unpriced.length ? "unpriced" : "$0"
  return `${floor}${money(value.low)}–${money(Math.min(value.high, value.cap))}${value.high > value.cap ? " (capped)" : ""}`
}
