import { describe, expect, test } from "bun:test"
import type { MemoryEntriesResult, MemoryEntryRow, MemoryStatus } from "../../shared/memory"
import {
  FORGET_WARNING,
  ageText,
  entryView,
  forgetOutcome,
  listSummary,
  listView,
  memoryHealth,
  memoryLine,
  memoryLineView,
  statusFacts,
} from "./memory-panel-model"

const status: MemoryStatus = {
  enabled: true,
  reachable: true,
  url: "127.0.0.1:8787",
  surface: "omp",
  project: "swcstudio/flow",
  retention: { ttl: "30d", deletable: false, note: "Substrate cannot delete entries." },
  problems: [],
}

function row(patch: Partial<MemoryEntryRow> = {}): MemoryEntryRow {
  return {
    id: "e1",
    scope: "repo:swcstudio/flow",
    kind: "fact",
    subject: "openflow/ship/run-1/card-a",
    preview: "Added the retry.",
    origin: "search",
    retracted: false,
    ageDays: 2,
    ...patch,
  }
}

describe("health and the status line", () => {
  test("off, unreachable and reachable are three different states", () => {
    expect(memoryHealth({ ...status, enabled: false })).toBe("disabled")
    expect(memoryHealth({ ...status, reachable: false })).toBe("unavailable")
    expect(memoryHealth(status)).toBe("ready")
  })

  test("the line says what happens to cards in each state", () => {
    expect(memoryLine({ ...status, enabled: false })).toBe("Shared memory is off: cards run without it.")
    expect(memoryLine(status)).toBe("Shared memory is reachable at 127.0.0.1:8787.")
    expect(memoryLine({ ...status, url: undefined })).toBe("Shared memory is reachable.")
    expect(memoryLine({ ...status, reachable: false, problems: ["SUBSTRATE_URL is not set."] })).toBe(
      "Shared memory is unavailable: SUBSTRATE_URL is not set. Cards run without it.",
    )
    expect(memoryLine({ ...status, reachable: false })).toContain("Substrate did not answer.")
  })
})

describe("status line view", () => {
  test("an unreachable or disabled memory is not an error: cards run without it", () => {
    expect(memoryLineView(undefined).tone).toBe("pending")
    expect(memoryLineView({ ok: true, value: status })).toEqual({ tone: "ok", text: "Shared memory is reachable at 127.0.0.1:8787." })
    expect(memoryLineView({ ok: true, value: { ...status, enabled: false } }).tone).toBe("ok")
    expect(memoryLineView({ ok: true, value: { ...status, reachable: false } }).tone).toBe("warning")
  })

  test("a host that never answered is the only error", () => {
    const view = memoryLineView({ ok: false, error: "The OpenFlow host did not answer." })
    expect(view.tone).toBe("error")
    expect(view.text).toContain("did not answer")
  })
})

describe("status facts", () => {
  test("a healthy status lists every fact the panel promises", () => {
    expect(statusFacts(status)).toEqual([
      { label: "Shared memory", value: "on", ok: true },
      { label: "Substrate", value: "reachable at 127.0.0.1:8787", ok: true },
      { label: "Surface", value: "omp", ok: true },
      { label: "Project", value: "swcstudio/flow", ok: true },
      { label: "Keep memories", value: "30 days", ok: true },
    ])
  })

  test("what needs attention is marked, and an unresolved project says so", () => {
    const rows = statusFacts({ ...status, reachable: false, project: "" })
    expect(rows.filter((fact) => !fact.ok).map((fact) => fact.label)).toEqual(["Substrate", "Project"])
    expect(rows.find((fact) => fact.label === "Project")?.value).toBe("not resolved")
    expect(rows.find((fact) => fact.label === "Substrate")?.value).toBe("not reachable at 127.0.0.1:8787")
  })

  test("a disabled memory shows only that it is off", () => {
    expect(statusFacts({ ...status, enabled: false })).toEqual([{ label: "Shared memory", value: "off", ok: true }])
  })

  test("every ttl has a readable label", () => {
    const labels = (["graph", "30d", "permanent"] as const).map(
      (ttl) => statusFacts({ ...status, retention: { ...status.retention, ttl } }).at(-1)?.value,
    )
    expect(labels).toEqual(["for the graph they belong to", "30 days", "permanently"])
  })

  test("the forget warning says plainly that nothing is deleted", () => {
    expect(FORGET_WARNING).toContain("cannot delete")
    expect(FORGET_WARNING).toContain("ttl")
  })
})

describe("entries", () => {
  test("age reads as days, today, or unknown", () => {
    expect(ageText(undefined)).toBe("age unknown")
    expect(ageText(0)).toBe("today")
    expect(ageText(0.4)).toBe("today")
    expect(ageText(1)).toBe("1 day ago")
    expect(ageText(1.9)).toBe("1 day ago")
    expect(ageText(12)).toBe("12 days ago")
  })

  test("a row keeps its scope, subject, preview and retraction marker", () => {
    expect(entryView(row({ retracted: true }))).toEqual({
      key: "e1",
      scope: "repo:swcstudio/flow",
      subject: "openflow/ship/run-1/card-a",
      age: "2 days ago",
      preview: "Added the retry.",
      retracted: true,
    })
  })

  test("each listing status maps to its own view", () => {
    const listing = (value: MemoryEntriesResult) => listView({ ok: true, value })
    expect(listView(undefined)).toEqual({ kind: "loading" })
    expect(listView({ ok: false, error: "no answer" })).toEqual({ kind: "error", message: "no answer" })
    expect(listing({ status: "disabled", items: [] })).toEqual({ kind: "disabled" })
    expect(listing({ status: "unavailable", items: [], error: "Substrate is down." })).toEqual({
      kind: "unavailable",
      message: "Substrate is down.",
    })
    expect(listing({ status: "unavailable", items: [] })).toEqual({ kind: "unavailable", message: "Substrate did not answer." })
    expect(listing({ status: "empty", items: [] })).toEqual({ kind: "empty" })
    expect(listing({ status: "ok", items: [] })).toEqual({ kind: "empty" })
    const rows = listing({ status: "ok", items: [row(), row({ id: "e2", retracted: true })] })
    expect(rows.kind === "rows" && rows.rows.map((entry) => entry.retracted)).toEqual([false, true])
  })

  test("the summary counts entries and retractions", () => {
    const view = listView({ ok: true, value: { status: "ok", items: [row(), row({ id: "e2", retracted: true })] } })
    expect(listSummary(view, "ship")).toBe("2 entries for ship, 1 retracted.")
    const one = listView({ ok: true, value: { status: "ok", items: [row()] } })
    expect(listSummary(one, "ship")).toBe("1 entry for ship.")
    expect(listSummary({ kind: "empty" }, "ship")).toBe("No memory entries for ship yet.")
    expect(listSummary({ kind: "disabled" }, "ship")).toBe("Shared memory is off.")
    expect(listSummary({ kind: "unavailable", message: "down" }, "ship")).toBe("down")
  })
})

describe("forget outcome", () => {
  test("a clean retraction reports the count", () => {
    expect(forgetOutcome({ ok: true, value: { status: "retracted", retracted: 3 } })).toEqual({ ok: true, text: "3 subjects retracted." })
    expect(forgetOutcome({ ok: true, value: { status: "retracted", retracted: 1 } }).text).toBe("1 subject retracted.")
    expect(forgetOutcome({ ok: true, value: { status: "retracted", retracted: 0 } }).text).toBe("0 subjects retracted.")
  })

  test("a partial retraction keeps the count and the host's sentence, and is not a success", () => {
    const result = forgetOutcome({
      ok: true,
      value: { status: "retracted", retracted: 2, error: "1 retraction marker could not be written to Substrate." },
    })
    expect(result.ok).toBe(false)
    expect(result.text).toBe("2 subjects retracted. 1 retraction marker could not be written to Substrate.")
  })

  test("unavailable, disabled and host failures are failures with a reason", () => {
    expect(forgetOutcome({ ok: true, value: { status: "unavailable", retracted: 0, error: "Substrate is down." } })).toEqual({
      ok: false,
      text: "Substrate is down.",
    })
    expect(forgetOutcome({ ok: true, value: { status: "unavailable", retracted: 0 } }).text).toContain("nothing was retracted")
    expect(forgetOutcome({ ok: true, value: { status: "disabled", retracted: 0 } }).ok).toBe(false)
    expect(forgetOutcome({ ok: false, error: "no answer" })).toEqual({ ok: false, text: "no answer" })
  })
})
