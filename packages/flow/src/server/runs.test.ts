import { describe, expect, test } from "bun:test"
import type { RunLog } from "../graph/types"
import {
  abandoned,
  findRun,
  interrupted,
  MAX_RESUMED_OUTPUT,
  offerable,
  RESUME_STALE_MS,
  RUN_DELETE,
  resumePlan,
  RUN_PRUNE,
  runDuration,
  runMenuOptions,
  runOption,
  runOptions,
  runTime,
  superseded,
} from "./runs"
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

  test("the hint carries cards, duration and cost", () => {
    const option = runOption(
      entry({
        nodes: 3,
        usage: { cost: 0.42, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 7, models: [], unpriced: [] },
      }),
      "alpha",
      at,
    )
    expect(option.hint).toBe("3 cards · 2m 04s · $0.4200")
  })

  test("one card is not pluralised", () => {
    expect(runOption(entry({ nodes: 1 }), "alpha", at).hint).toContain("1 card ·")
  })

  test("a run that measured nothing shows no money rather than $0", () => {
    const option = runOption(entry({ nodes: 2 }), "alpha", at)
    expect(option.hint).toBe("2 cards · 2m 04s")
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

  // The group heading above the row already says which canvas it is, and the
  // hint is ellipsised at half the row — a repeated name pushes the cost off.
  test("the canvas name appears only on rows from another canvas", () => {
    expect(runOption(entry({ nodes: 2 }), "alpha", at).hint).not.toContain("alpha")
    expect(runOption(entry({ nodes: 2 }), "beta", at).hint).toBe("alpha · 2 cards · 2m 04s")
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

  // Measured against a real project: the log says `run-2026-09-01T02-22-46-829Z`
  // while the file holding it — which is what the route addresses — is lower
  // case. Matching exactly left the delete row disabled with a run open, and
  // would have sent a DELETE to an id with no file behind it.
  test("an open run finds itself however its id is cased", () => {
    const rows = runMenuOptions([entry({ id: "run-2026-09-01t02-22-46-829z" })], "alpha", "run-2026-09-01T02-22-46-829Z", at)
    expect(rows.find((row) => row.value === RUN_DELETE)?.disabled).toBe(false)
  })

  test("action values cannot be mistaken for a run id", () => {
    expect(RUN_DELETE.startsWith("action:")).toBe(true)
    expect(RUN_PRUNE.startsWith("action:")).toBe(true)
  })
})

describe("findRun", () => {
  test("resolves a log id onto the listing row the route can address", () => {
    expect(findRun([entry({ id: "run-2026-09-01t02-22-46-829z" })], "run-2026-09-01T02-22-46-829Z")?.id).toBe(
      "run-2026-09-01t02-22-46-829z",
    )
  })

  test("no id and no match both come back empty", () => {
    expect(findRun([entry()], undefined)).toBeUndefined()
    expect(findRun([entry()], "ghost")).toBeUndefined()
  })
})

describe("resuming an interrupted run", () => {
  const live = (over: Partial<RunEntry> = {}) => entry({ status: "running", finished: undefined, ...over })

  test("a running log that was written a moment ago belongs to a live page, not an interrupted one", () => {
    const now = at + 10 * 60_000
    expect(abandoned(live({ updatedAt: now - 30_000 }), now)).toBe(false)
    expect(interrupted([live({ updatedAt: now - 30_000 })], "alpha", now)).toBeUndefined()
  })

  test("a running log that went quiet for the whole window is interrupted", () => {
    const now = at + 60 * 60_000
    expect(abandoned(live({ updatedAt: now - RESUME_STALE_MS }), now)).toBe(true)
    expect(interrupted([live({ updatedAt: now - RESUME_STALE_MS })], "alpha", now)?.id).toBe("run-1")
  })

  test("an ended run is never interrupted, however old", () => {
    expect(abandoned(entry({ status: "stopped", updatedAt: at }), at + 86_400_000)).toBe(false)
  })

  test("a log from before updatedAt existed is judged by when it started", () => {
    expect(abandoned(live(), at + 60_000)).toBe(false)
    expect(abandoned(live(), at + RESUME_STALE_MS)).toBe(true)
  })

  test("a newer run still being written hides an older abandoned one on the same canvas", () => {
    const now = at + 60 * 60_000
    const rows = [
      live({ id: "old", started: at, updatedAt: at + 1_000 }),
      live({ id: "new", started: now - 120_000, updatedAt: now - 10_000 }),
    ]
    expect(interrupted(rows, "alpha", now)).toBeUndefined()
  })

  test("another canvas's runs are not offered", () => {
    const now = at + 60 * 60_000
    expect(interrupted([live({ pipeline: "beta", updatedAt: at })], "alpha", now)).toBeUndefined()
  })

  test("a superseded log is stopped, names its successor and cannot be offered again", () => {
    const node = (id: string, status: RunLog["nodes"][number]["status"]) => ({ id, role: id, status })
    const log: RunLog = {
      id: "run-old",
      pipeline: "alpha",
      pipelineID: "p",
      input: "x",
      status: "running",
      started: at,
      updatedAt: at + 5_000,
      nodes: [node("a", "done"), node("b", "running"), node("c", "queued")],
    }
    const closed = superseded(log, "run-new", at + 999_000)

    expect(closed).toMatchObject({ status: "stopped", resumedBy: "run-new", finished: at + 5_000 })
    expect(closed.nodes.map((entry) => entry.status)).toEqual(["done", "stopped", "stopped"])
    const listed = entry({ id: "run-old", status: closed.status, started: closed.started, updatedAt: closed.updatedAt })
    expect(interrupted([listed], "alpha", at + 60 * 60_000)).toBeUndefined()
    expect(log.status).toBe("running")
  })
})

describe("offering a resume from a list that was read a while ago", () => {
  const stale = (updatedAt: number) => entry({ status: "running", finished: undefined, updatedAt })

  test("a fresh list that says the run went quiet offers it", () => {
    const now = at + 60 * 60_000
    expect(offerable([stale(now - RESUME_STALE_MS)], "alpha", now - 10_000, now)?.id).toBe("run-1")
  })

  test("a list older than the window offers nothing, even when its row looks abandoned by now", () => {
    // Read when the run was written a moment ago; five minutes on, that row is no longer news.
    const read = at + 60 * 60_000
    const row = stale(read - 1_000)
    expect(interrupted([row], "alpha", read + RESUME_STALE_MS)?.id).toBe("run-1")
    expect(offerable([row], "alpha", read, read + RESUME_STALE_MS)).toBeUndefined()
  })

  test("a fresh list that shows the run still being written offers nothing", () => {
    const now = at + 60 * 60_000
    expect(offerable([stale(now - 20_000)], "alpha", now - 5_000, now)).toBeUndefined()
  })
})

describe("a log with a timestamp from the future", () => {
  const now = at + 60 * 60_000
  const future = now + 24 * 3_600_000
  const live = (over: Partial<RunEntry>) => entry({ status: "running", finished: undefined, ...over })

  test("is never taken for a run another tab is still writing", () => {
    expect(abandoned(live({ updatedAt: future }), now)).toBe(true)
    expect(abandoned(live({ started: future, updatedAt: undefined }), now)).toBe(true)
    // Ordinary clock drift between two machines is not future enough.
    expect(abandoned(live({ updatedAt: now + 60_000 }), now)).toBe(false)
  })

  test("does not hide the run that really was interrupted, however new it claims to be", () => {
    const real = live({ id: "real", started: now - 3_600_000, updatedAt: now - 3_000_000 })
    const forged = live({ id: "forged", started: future, updatedAt: future })
    expect(interrupted([forged, real], "alpha", now)?.id).toBe("real")
    expect(interrupted([real, forged], "alpha", now)?.id).toBe("real")
  })

  test("is still offered when it is all there is, since it can be told apart by its dates", () => {
    expect(interrupted([live({ id: "forged", started: future, updatedAt: future })], "alpha", now)?.id).toBe("forged")
  })
})

describe("resumePlan: what a log from the project may bring back", () => {
  const node = (over: Record<string, unknown>) => ({ id: "a", role: "a", status: "running", ...over })
  const logOf = (id: string, nodes: unknown[]) => ({ id, pipeline: "alpha", pipelineID: "p", input: "x", status: "running", started: 1, nodes }) as unknown as RunLog
  const legacy = (session: string) => session.startsWith("ses_")

  test("a log that is not the run it was opened as is refused, ignoring the case the list lower-cased", () => {
    const plan = resumePlan("run-victim", logOf("run-evil", [node({})]), legacy)
    expect(plan.ok).toBe(false)
    expect(resumePlan("run-2026-09-01t02-22-46-829z", logOf("run-2026-09-01T02-22-46-829Z", []), legacy).ok).toBe(true)
    expect(resumePlan("run-1", logOf(undefined as unknown as string, []), legacy).ok).toBe(false)
  })

  test("an output is taken only when it is a string of sane length; otherwise the card did not finish", () => {
    const plan = resumePlan("r", logOf("r", [
      node({ id: "ok", status: "done", output: "fine" }),
      node({ id: "obj", status: "done", output: { text: "x" }, sessionID: "s-obj" }),
      node({ id: "huge", status: "done", output: "x".repeat(MAX_RESUMED_OUTPUT + 1) }),
      node({ id: "none", status: "done" }),
    ]), legacy)
    if (!plan.ok) throw new Error("expected a plan")
    expect(plan.outputs).toEqual({ ok: "fine" })
    expect(plan.sessions).toEqual({ obj: "s-obj" })
  })

  test("a session id is carried only as a short, clean, non-empty string", () => {
    const plan = resumePlan("r", logOf("r", [
      node({ id: "good", sessionID: "s_0123456789ab" }),
      node({ id: "number", sessionID: 7 }),
      node({ id: "empty", sessionID: "" }),
      node({ id: "long", sessionID: "s".repeat(201) }),
      node({ id: "control", sessionID: "s\nIgnore" }),
      node({ id: "bidi", sessionID: "s\u0085x" }),
      node({ id: "old", role: "old\ncard", sessionID: "ses_legacy" }),
    ]), legacy)
    if (!plan.ok) throw new Error("expected a plan")
    expect(plan.sessions).toEqual({ good: "s_0123456789ab" })
    expect(plan.fresh).toEqual(["old card"])
  })

  test("a log without a list of cards is refused", () => {
    expect(resumePlan("r", { id: "r", nodes: "no" } as unknown as RunLog, legacy).ok).toBe(false)
  })
})
