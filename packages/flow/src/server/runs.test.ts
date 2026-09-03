import { describe, expect, test } from "bun:test"
import { RUN_DELETE, RUN_PRUNE, runDuration, runMenuOptions, runOption, runOptions, runTime } from "./runs"
import type { RunEntry } from "./store"

const at = new Date(2026, 8, 2, 14, 32).getTime()

function entry(over: Partial<RunEntry> = {}): RunEntry {
  return { id: "run-1", pipeline: "alpha", status: "done", started: at, finished: at + 124_000, ...over }
}

describe("runDuration", () => {
  test("seconds under a minute", () => {
    expect(runDuration(entry({ finished: at + 9_000 }))).toBe("9s")
  })

  test("minutes carry zero-padded seconds", () => {
    expect(runDuration(entry())).toBe("2m 04s")
  })

  test("hours carry zero-padded minutes", () => {
    expect(runDuration(entry({ finished: at + 3_780_000 }))).toBe("1h 03m")
  })

  test("a run with no ending has no duration rather than counting up", () => {
    expect(runDuration(entry({ status: "running", finished: undefined }))).toBe("")
  })
})

describe("runTime", () => {
  test("a run from today is the clock alone", () => {
    expect(runTime(at, at + 3_600_000)).not.toContain(",")
  })

  test("an older run carries its date", () => {
    expect(runTime(at, at + 5 * 86_400_000)).toContain(",")
  })

  test("a run with no start says so instead of showing the epoch", () => {
    expect(runTime(undefined, at)).toBe("unknown time")
  })
})

describe("runOption", () => {
  test("the id stays searchable even though it is not the label", () => {
    const option = runOption(entry(), "alpha", at)
    expect(option.value).toBe("run-1")
    expect(option.label).not.toBe("run-1")
  })

  test("the hint carries canvas, cards, duration and cost", () => {
    const option = runOption(
      entry({
        nodes: 3,
        usage: { cost: 0.42, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 7, models: [], unpriced: [] },
      }),
      "alpha",
      at,
    )
    expect(option.hint).toBe("alpha · 3 cards · 2m 04s · $0.4200")
  })

  test("one card is not pluralised", () => {
    expect(runOption(entry({ nodes: 1 }), "alpha", at).hint).toContain("1 card ·")
  })

  test("a run that measured nothing shows no money rather than $0", () => {
    const option = runOption(entry({ nodes: 2 }), "alpha", at)
    expect(option.hint).toBe("alpha · 2 cards · 2m 04s")
  })

  test("an unpriced model is reported as such, never as free", () => {
    const option = runOption(
      entry({
        usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 4, models: [], unpriced: ["local/thing"] },
      }),
      "alpha",
      at,
    )
    expect(option.hint).toContain("unpriced")
  })

  test("done is the expected ending and gets no pill", () => {
    expect(runOption(entry(), "alpha", at).tag).toBeUndefined()
  })

  test("every other ending is pilled", () => {
    expect(runOption(entry({ status: "error" }), "alpha", at).tag).toBe("error")
    expect(runOption(entry({ status: "running", finished: undefined }), "alpha", at).tag).toBe("running")
  })

  test("runs are grouped by whether they belong to the open canvas", () => {
    expect(runOption(entry(), "alpha", at).group).toBe("This canvas")
    expect(runOption(entry(), "beta", at).group).toBe("Other canvases")
  })
})

describe("runOptions", () => {
  test("the open canvas leads, because the menu groups in first-seen order", () => {
    const rows = runOptions(
      [entry({ id: "b", pipeline: "beta" }), entry({ id: "a", pipeline: "alpha" }), entry({ id: "c", pipeline: "beta" })],
      "alpha",
      at,
    )
    expect(rows.map((row) => row.value)).toEqual(["a", "b", "c"])
    expect(rows.map((row) => row.group)).toEqual(["This canvas", "Other canvases", "Other canvases"])
  })

  test("order inside a group is left as the listing gave it — newest first", () => {
    const rows = runOptions([entry({ id: "new" }), entry({ id: "old", started: at - 86_400_000 })], "alpha", at)
    expect(rows.map((row) => row.value)).toEqual(["new", "old"])
  })
})

describe("runMenuOptions", () => {
  const old = at - 40 * 86_400_000

  test("both actions sit under Manage, after every recording", () => {
    const rows = runMenuOptions([entry()], "alpha", undefined, at)
    expect(rows.slice(-2).map((row) => row.value)).toEqual([RUN_DELETE, RUN_PRUNE])
    expect(rows.slice(-2).every((row) => row.group === "Manage")).toBe(true)
  })

  test("delete is disabled until a run is open, and names it once one is", () => {
    expect(runMenuOptions([entry()], "alpha", undefined, at).find((row) => row.value === RUN_DELETE)?.disabled).toBe(true)
    const open = runMenuOptions([entry()], "alpha", "run-1", at).find((row) => row.value === RUN_DELETE)
    expect(open?.disabled).toBe(false)
    expect(open?.title).toContain("run-1")
  })

  test("prune counts what it would delete", () => {
    const rows = runMenuOptions([entry(), entry({ id: "old", started: old })], "alpha", undefined, at)
    const prune = rows.find((row) => row.value === RUN_PRUNE)
    expect(prune?.hint).toBe("1 run")
    expect(prune?.disabled).toBe(false)
  })

  test("prune is disabled when nothing is old enough", () => {
    const prune = runMenuOptions([entry()], "alpha", undefined, at).find((row) => row.value === RUN_PRUNE)
    expect(prune?.hint).toBe("nothing that old")
    expect(prune?.disabled).toBe(true)
  })

  // An interrupted run is the one the resume banner offers to pick back up, and
  // an old one is the most likely to have been forgotten about.
  test("an old run still marked running is not counted as prunable", () => {
    const prune = runMenuOptions(
      [entry({ id: "old", started: old, finished: undefined, status: "running" })],
      "alpha",
      undefined,
      at,
    ).find((row) => row.value === RUN_PRUNE)
    expect(prune?.disabled).toBe(true)
  })

  test("action values cannot be mistaken for a run id", () => {
    expect(RUN_DELETE.startsWith("action:")).toBe(true)
    expect(RUN_PRUNE.startsWith("action:")).toBe(true)
  })
})
