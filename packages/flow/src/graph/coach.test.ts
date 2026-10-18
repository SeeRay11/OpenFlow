import { describe, expect, test } from "bun:test"
import { MAX_FINDINGS, coach, commandShaped } from "./coach"
import { pipeline } from "./test-support"
import type { Pipeline, RunLog, RunNodeLog } from "./types"

function run(nodes: RunNodeLog[], extra: Partial<RunLog> = {}): RunLog {
  return {
    id: "run",
    pipeline: "test",
    pipelineID: "test-pipeline",
    input: "",
    status: "done",
    started: 0,
    nodes,
    ...extra,
  }
}

function card(id: string, extra: Partial<RunNodeLog> = {}): RunNodeLog {
  return { id, role: id, status: "done", ...extra }
}

/** A gauntlet: orchestrator `lead` dispatching a builder and a `reviewer` critic. */
function gauntlet(bar: string): Pipeline {
  return { ...pipeline("lead->builder", "lead->reviewer"), mode: "orchestration", gauntlet: { bar } }
}

function orchestration(): Pipeline {
  return { ...pipeline("lead->a", "lead->b"), mode: "orchestration" }
}

const BAR = "`bun test` exits 0 and the page renders"
const passed = { verdict: { card: "reviewer", kind: "pass" as const } }

describe("commandShaped", () => {
  test("backticked commands and exit-code language count", () => {
    expect(commandShaped("`bun run build` succeeds")).toBe(true)
    expect(commandShaped("the build exits 0")).toBe(true)
    expect(commandShaped("tests exit with code 0")).toBe(true)
    expect(commandShaped("check the exit code")).toBe(true)
    expect(commandShaped("0 failures in the suite")).toBe(true)
  })

  test("prose-only bars do not", () => {
    expect(commandShaped("the essay is clear and cites three sources")).toBe(false)
    expect(commandShaped("")).toBe(false)
  })
})

describe("unearned-pass", () => {
  test("fires on a pass from a critic that ran nothing against a command bar", () => {
    const findings = coach(run([card("lead"), card("builder"), card("reviewer", { ranShell: false })], passed), gauntlet(BAR))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: "unearned-pass", id: "unearned-pass:reviewer", severity: "error", cards: ["reviewer"] })
  })

  test("fires on a recorded best round as well as a verdict", () => {
    const findings = coach(
      run([card("reviewer", { ranShell: false })], { best: { round: 2, card: "lead" } }),
      gauntlet(BAR),
    )
    expect(findings.map((entry) => entry.kind)).toEqual(["unearned-pass"])
  })

  test("reads a verify bar outside a gauntlet", () => {
    const verified: Pipeline = { ...pipeline("coder->reviewer"), verify: { bar: BAR } }
    expect(coach(run([card("coder"), card("reviewer", { ranShell: false })], passed), verified)).toHaveLength(1)
  })

  test("does not fire when the critic ran a shell call", () => {
    expect(coach(run([card("reviewer", { ranShell: true })], passed), gauntlet(BAR))).toEqual([])
  })

  test("does not fire on a prose-only bar", () => {
    expect(coach(run([card("reviewer", { ranShell: false })], passed), gauntlet("reads well, no typos"))).toEqual([])
  })

  test("does not fire without a pass", () => {
    const failed = { verdict: { card: "reviewer", kind: "fail" as const } }
    expect(coach(run([card("reviewer", { ranShell: false })], failed), gauntlet(BAR))).toEqual([])
  })

  test("does not fire on a non-critic card that ran nothing", () => {
    expect(coach(run([card("builder", { ranShell: false })], passed), gauntlet(BAR))).toEqual([])
  })

  test("absent ranShell is unknown, not false", () => {
    expect(coach(run([card("reviewer")], passed), gauntlet(BAR))).toEqual([])
  })
})

describe("never-dispatched", () => {
  const skipped = [card("lead"), card("a", { status: "skipped" }), card("b", { status: "skipped" })]

  test("fires when every child of the root was skipped and no round was recorded", () => {
    const findings = coach(run(skipped), orchestration())
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: "never-dispatched", id: "never-dispatched:lead", severity: "error", cards: ["lead"] })
  })

  test("an empty rounds list counts as none", () => {
    expect(coach(run(skipped, { rounds: [] }), orchestration())).toHaveLength(1)
  })

  test("does not fire on a run the user stopped", () => {
    expect(coach(run(skipped, { status: "stopped" }), orchestration())).toEqual([])
  })

  test("does not fire when a child ran", () => {
    expect(coach(run([card("lead"), card("a"), card("b", { status: "skipped" })]), orchestration())).toEqual([])
  })

  test("does not fire when rounds were recorded", () => {
    expect(coach(run(skipped, { rounds: [{ card: "lead", round: 1, at: 0, cards: [] }] }), orchestration())).toEqual([])
  })

  test("does not fire outside orchestration", () => {
    expect(coach(run(skipped), pipeline("lead->a", "lead->b"))).toEqual([])
  })

  test("children with no log entry stay silent", () => {
    expect(coach(run([card("lead")]), orchestration())).toEqual([])
  })
})

describe("tool-failures", () => {
  test("fires per card with rejected tool calls", () => {
    const findings = coach(run([card("coder", { toolFailures: 2 })]), pipeline("coder"))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: "tool-failures", id: "tool-failures:coder", severity: "warn", cards: ["coder"] })
    expect(findings[0].evidence).toContain("coder")
    expect(findings[0].evidence).toContain("2")
  })

  test("does not fire on zero", () => {
    expect(coach(run([card("coder", { toolFailures: 0 })]), pipeline("coder"))).toEqual([])
  })

  test("absent toolFailures stays silent", () => {
    expect(coach(run([card("coder")]), pipeline("coder"))).toEqual([])
  })
})

describe("coach", () => {
  test("a clean run has no findings", () => {
    expect(coach(run([card("coder"), card("reviewer", { ranShell: true })], passed), gauntlet(BAR))).toEqual([])
  })

  test("errors sort ahead of warnings", () => {
    const findings = coach(
      run([card("lead"), card("builder", { toolFailures: 1 }), card("reviewer", { ranShell: false })], passed),
      gauntlet(BAR),
    )
    expect(findings.map((entry) => entry.severity)).toEqual(["error", "warn"])
    expect(findings.map((entry) => entry.kind)).toEqual(["unearned-pass", "tool-failures"])
  })

  test("caps at MAX_FINDINGS, keeping the most severe", () => {
    const findings = coach(
      run(
        [
          card("lead", { toolFailures: 1 }),
          card("a", { status: "skipped", toolFailures: 1 }),
          card("b", { status: "skipped", toolFailures: 1 }),
        ],
      ),
      orchestration(),
    )
    expect(findings).toHaveLength(MAX_FINDINGS)
    expect(findings[0].kind).toBe("never-dispatched")
  })

  test("ids are stable across calls", () => {
    const log = run([card("coder", { toolFailures: 1 })])
    expect(coach(log, pipeline("coder")).map((entry) => entry.id)).toEqual(coach(log, pipeline("coder")).map((entry) => entry.id))
  })
})
