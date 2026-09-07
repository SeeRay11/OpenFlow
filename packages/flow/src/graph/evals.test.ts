import { describe, expect, test } from "bun:test"
import { CORPUS, EVAL_MODEL } from "./corpus"
import { compareScores, report, scoreRun, shapeOf, type Score } from "./evals"
import type { RunLog } from "./types"
import { preflight } from "./validate"

const log = (patch: Partial<RunLog> = {}): RunLog => ({
  id: "run-1",
  pipeline: "case",
  pipelineID: "p1",
  input: "do the thing",
  status: "done",
  started: 0,
  finished: 60_000,
  nodes: [{ id: "a", role: "coder", status: "done" }],
  ...patch,
})

describe("the corpus", () => {
  test("covers every mode and every document toggle", () => {
    // The point of a fixed corpus is that nothing quietly stops being covered.
    const shapes = CORPUS.map((entry) => shapeOf(entry.pipeline))
    expect(shapes.some((shape) => shape.startsWith("pipeline"))).toBe(true)
    expect(shapes.some((shape) => shape.startsWith("swarm"))).toBe(true)
    expect(shapes.some((shape) => shape.startsWith("orchestration"))).toBe(true)
    expect(shapes.some((shape) => shape.includes("gauntlet"))).toBe(true)
    expect(shapes.some((shape) => shape.includes("isolated"))).toBe(true)
    expect(shapes.some((shape) => shape.includes("verified"))).toBe(true)
  })

  test("every case has a unique id and says what it is for", () => {
    expect(new Set(CORPUS.map((entry) => entry.id)).size).toBe(CORPUS.length)
    for (const entry of CORPUS) expect(entry.covers.length).toBeGreaterThan(10)
  })

  test("every case still passes preflight", () => {
    // The regression this catches: a change to `validate.ts` that makes a legal
    // shape illegal. It is free, deterministic, and runs in CI — unlike the
    // half of an eval that spends money.
    for (const entry of CORPUS) {
      const result = preflight(entry.pipeline, { unlockedModels: new Set([EVAL_MODEL]), engineReachable: true })
      expect({ id: entry.id, blocking: result.blocking.map((problem) => problem.kind) }).toEqual({
        id: entry.id,
        blocking: [],
      })
    }
  })

  test("a case raises only the warnings it declares", () => {
    for (const entry of CORPUS) {
      const raised = preflight(entry.pipeline, {
        unlockedModels: new Set([EVAL_MODEL]),
        engineReachable: true,
      }).warnings.map((problem) => problem.kind)
      const undeclared = raised.filter((kind) => !(entry.warns ?? []).includes(kind))
      // Named rather than counted: a new warning appearing on a shipped
      // template is a thing to look at, and the id says which one.
      expect({ id: entry.id, undeclared }).toEqual({ id: entry.id, undeclared: [] })
    }
  })
})

describe("scoreRun", () => {
  test("keeps the numbers worth comparing and nothing else", () => {
    expect(
      scoreRun(
        "case",
        log({ nodes: [{ id: "a", role: "coder", status: "done", diff: { added: 40, removed: 2, files: 3 } }] }),
      ),
    ).toEqual({ id: "case", status: "done", seconds: 60, failed: [], added: 40, removed: 2 })
  })

  test("an unpriced run has no cost rather than a zero one", () => {
    // The rule every other total here follows: unpriced is unknown, not free.
    // A comparison that read it as zero would call every release an improvement
    // over an unpriced baseline.
    const unpriced = scoreRun(
      "case",
      log({
        usage: {
          cost: 0,
          steps: 3,
          tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          models: [],
          unpriced: ["openrouter/free"],
        },
      }),
    )
    expect(unpriced.cost).toBeUndefined()
  })

  test("failed cards are named by role, and rounds counted", () => {
    const scored = scoreRun(
      "case",
      log({
        status: "error",
        nodes: [
          { id: "a", role: "coder", status: "error" },
          { id: "b", role: "reviewer", status: "done" },
        ],
        rounds: [
          { card: "root", round: 1, at: 0, cards: [], added: 10, removed: 0 },
          { card: "root", round: 2, at: 1, cards: [], added: 0, removed: 0 },
        ],
      }),
    )
    expect(scored.failed).toEqual(["coder"])
    expect(scored.rounds).toBe(2)
    expect(scored.stalled).toBe(1)
  })
})

describe("compareScores", () => {
  const base: Score = {
    id: "gauntlet-loop",
    status: "done",
    verdict: "pass",
    cost: 2,
    seconds: 600,
    failed: [],
    rounds: 4,
  }

  test("a run that stopped passing is a regression", () => {
    const changes = compareScores([base], [{ ...base, status: "error", verdict: "fail" }])
    expect(changes.filter((change) => change.kind === "worse").map((change) => change.field)).toEqual([
      "status",
      "verdict",
    ])
  })

  test("a run that started passing is an improvement", () => {
    const changes = compareScores([{ ...base, status: "error", verdict: "fail" }], [base])
    expect(changes.every((change) => change.kind === "better")).toBe(true)
  })

  test("small movements in cost and clock are noise, not findings", () => {
    // A gauntlet costing 3% more is a provider's tokeniser, and flagging it
    // every release trains whoever reads this to skip the column.
    expect(compareScores([base], [{ ...base, cost: 2.05, seconds: 610 }])).toEqual([])
    expect(compareScores([base], [{ ...base, cost: 3 }]).map((change) => change.field)).toEqual(["cost"])
  })

  test("one more round counts even though it is a small number", () => {
    expect(compareScores([base], [{ ...base, rounds: 5 }]).map((change) => change.kind)).toEqual(["worse"])
  })

  test("lines changed are reported with no direction claimed", () => {
    // More lines is not better work and fewer is not tighter work. The moment
    // this claims otherwise it has invented a bar of its own.
    const changes = compareScores([{ ...base, added: 100 }], [{ ...base, added: 20 }])
    expect(changes).toEqual([{ id: "gauntlet-loop", field: "lines", was: "+100 −0", now: "+20 −0", kind: "changed" }])
  })

  test("a case that appeared or stopped being run is called out", () => {
    expect(compareScores([], [base])[0].now).toBe("new")
    expect(compareScores([base], [])[0].now).toBe("not run")
  })
})

describe("report", () => {
  test("regressions lead, and an unchanged release says so", () => {
    expect(report([])).toBe("No case changed.")
    const text = report([
      { id: "a", field: "lines", was: "1", now: "2", kind: "changed" },
      { id: "b", field: "status", was: "done", now: "error", kind: "worse" },
    ])
    expect(text.indexOf("1 regression")).toBeLessThan(text.indexOf("1 other change"))
  })
})
