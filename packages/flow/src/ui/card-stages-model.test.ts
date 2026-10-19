import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "../../shared/memory"
import type { SwarmStatus } from "../../shared/swarm"
import type { UpliftInfo } from "../../shared/uplift"
import {
  decisionLine,
  formatElapsed,
  isJevSkip,
  memoryAge,
  memoryChip,
  memoryReadText,
  memoryRow,
  memoryWriteText,
  stageAnnouncement,
  stageSnapshot,
  swarmCountsText,
  swarmIdleText,
  swarmLine,
  swarmPills,
  swarmVisible,
  truncate,
  upliftChip,
  upliftFacts,
  upliftFailureView,
  upliftPrompts,
  wrapFocus,
} from "./card-stages-model"

const uplift = (patch: Partial<UpliftInfo>): UpliftInfo => ({ status: "ok", original: "do the thing", ...patch })

const swarm = (patch: Partial<SwarmStatus> = {}): SwarmStatus => ({
  mode: "auto",
  active: true,
  counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
  agents: [],
  updatedAt: 1,
  ...patch,
})

describe("text helpers", () => {
  test("truncate flattens whitespace and marks the cut", () => {
    expect(truncate("a\n  b\tc", 20)).toBe("a b c")
    expect(truncate("abcdefghij", 5)).toBe("abcd…")
    expect(truncate("abcde", 5)).toBe("abcde")
  })

  test("formatElapsed picks a unit and refuses nonsense", () => {
    expect(formatElapsed(420)).toBe("420 ms")
    expect(formatElapsed(1234)).toBe("1.2 s")
    expect(formatElapsed(125_000)).toBe("2 min 05 s")
    expect(formatElapsed(undefined)).toBeUndefined()
    expect(formatElapsed(-1)).toBeUndefined()
    expect(formatElapsed(Number.NaN)).toBeUndefined()
  })
})

describe("upliftChip", () => {
  test("nothing without a record", () => {
    expect(upliftChip(undefined)).toBeUndefined()
  })

  test("running", () => {
    expect(upliftChip(uplift({ status: "running" }))).toMatchObject({ label: "uplifting…", tone: "info", aria: "prompt uplift running" })
  })

  test("ok", () => {
    const chip = upliftChip(uplift({ elapsedMs: 2300 }))
    expect(chip).toMatchObject({ label: "uplifted", tone: "ok", aria: "prompt uplifted" })
    expect(chip?.title).toContain("2.3 s")
  })

  test("ok with degraded parts says so and names them", () => {
    const chip = upliftChip(uplift({ degraded: ["fill:n3"] }))
    expect(chip).toMatchObject({ label: "uplifted ~", tone: "warn", aria: "prompt uplifted with a partial plan" })
    expect(chip?.title).toContain("fill:n3")
  })

  test("a Jev skip is labelled as Jev's call, not a failure", () => {
    const chip = upliftChip(uplift({ status: "skipped", reason: "jev-skip" }))
    expect(chip).toMatchObject({ label: "skipped (Jev)", tone: "neutral", aria: "prompt uplift skipped by Jev" })
    expect(chip?.title).toContain("not new multi-step work")
  })

  test("another skip reason keeps its own words, unknown ones verbatim", () => {
    expect(upliftChip(uplift({ status: "skipped", reason: "disabled" }))).toMatchObject({ label: "uplift skipped" })
    expect(upliftChip(uplift({ status: "skipped", reason: "disabled" }))?.title).toContain("switched off")
    expect(upliftChip(uplift({ status: "skipped", reason: "odd-new-reason" }))?.title).toContain("odd-new-reason")
  })

  test("failed carries the reason into the tooltip and the aria string", () => {
    const chip = upliftChip(uplift({ status: "failed", reason: "claude CLI is logged out" }))
    expect(chip).toMatchObject({ label: "uplift failed", tone: "danger" })
    expect(chip?.title).toBe("nothing was sent — claude CLI is logged out")
    expect(chip?.aria).toBe("prompt uplift failed: claude CLI is logged out")
  })

  test("declined means the original went out after a failure", () => {
    const chip = upliftChip(uplift({ status: "declined", declined: true, reason: "timeout" }))
    expect(chip).toMatchObject({ label: "original sent", tone: "warn" })
    expect(chip?.title).toContain("timeout")
  })

  test("isJevSkip only matches a skipped Jev reason", () => {
    expect(isJevSkip(uplift({ status: "skipped", reason: "jev-skip" }))).toBe(true)
    expect(isJevSkip(uplift({ status: "failed", reason: "jev-skip" }))).toBe(false)
    expect(isJevSkip(uplift({ status: "skipped", reason: "empty" }))).toBe(false)
  })
})

describe("uplift section data", () => {
  test("facts come in a fixed order and skip what is unknown", () => {
    const facts = upliftFacts(
      uplift({ source: "llm", graphId: "ut-abc-12345678", nodes: 4, degraded: ["fill:n3"], elapsedMs: 900 }),
    )
    expect(facts.map((fact) => fact.key)).toEqual(["status", "planner", "graph id", "nodes", "degraded", "took"])
    expect(facts.find((fact) => fact.key === "nodes")?.value).toBe("4")
    expect(upliftFacts(uplift({ status: "failed", reason: "boom" })).map((fact) => fact.key)).toEqual(["status", "reason"])
  })

  test("a fallback spec is named as such", () => {
    expect(upliftFacts(uplift({ source: "fallback" })).find((fact) => fact.key === "planner")?.value).toContain("fallback")
  })

  test("decision lines", () => {
    expect(decisionLine({ point: "plan", p: 0.971, action: "promoted" })).toBe("plan · p 0.97 · promoted")
  })

  test("the uplift record's original wins, the runtime copy backs it up", () => {
    expect(upliftPrompts("runtime", uplift({ original: "record", uplifted: "<BUILD_PROMPT/>" }))).toEqual({
      original: "record",
      uplifted: "<BUILD_PROMPT/>",
    })
    expect(upliftPrompts("runtime", undefined)).toEqual({ original: "runtime", uplifted: undefined })
    expect(upliftPrompts(undefined, undefined)).toEqual({ original: undefined, uplifted: undefined })
  })

  test("failure dialog copy", () => {
    expect(upliftFailureView({ role: "builder", reason: "timed out", elapsedMs: 30_000 }, 0)).toEqual({
      title: "Prompt uplift failed for builder",
      reason: "timed out",
      elapsed: "after 30.0 s",
      queue: undefined,
    })
    expect(upliftFailureView({ role: "builder", reason: "x", elapsedMs: 5 }, 1).queue).toBe("1 more card waiting for a decision")
    expect(upliftFailureView({ role: "builder", reason: "x", elapsedMs: 5 }, 3).queue).toBe("3 more cards waiting for a decision")
  })
})

describe("memoryChip", () => {
  const read = (patch: Partial<NonNullable<MemoryInfo["read"]>> = {}): NonNullable<MemoryInfo["read"]> => ({
    status: "ok",
    items: [],
    ...patch,
  })
  const item = (subject: string) => ({ scope: "repo:o/r", subject, preview: "p", origin: "search" as const })

  test("nothing without a record", () => {
    expect(memoryChip(undefined)).toBeUndefined()
    expect(memoryChip({ graphId: "g" })).toBeUndefined()
  })

  test("counts what was read and written", () => {
    const chip = memoryChip({
      read: read({ items: [item("openflow/p/r1/a"), item("openflow/p/r1/b")] }),
      write: { status: "stored", subject: "openflow/p/r2/c" },
    })
    expect(chip).toMatchObject({ label: "mem ↓2 ↑1", tone: "neutral" })
    expect(chip?.title).toContain("↓ openflow/p/r1/a")
    expect(chip?.title).toContain("↑ stored: openflow/p/r2/c")
  })

  test("the tooltip caps the subjects it lists", () => {
    const items = Array.from({ length: 8 }, (_, at) => item(`s${at}`))
    const chip = memoryChip({ read: read({ items }) })
    expect(chip?.label).toBe("mem ↓8 ↑0")
    expect(chip?.title).toContain("+3 more")
    expect(chip?.title).not.toContain("s7")
  })

  test("running shows an ellipsis and the info tone", () => {
    expect(memoryChip({ read: read({ status: "running" }) })).toMatchObject({ label: "mem ↓… ↑0", tone: "info" })
    expect(memoryChip({ read: read(), write: { status: "running" } })).toMatchObject({ label: "mem ↓0 ↑…", tone: "info" })
  })

  test("both sides disabled is 'mem off'", () => {
    expect(memoryChip({ read: read({ status: "disabled" }), write: { status: "disabled" } })).toMatchObject({
      label: "mem off",
      tone: "neutral",
    })
    expect(memoryChip({ read: read({ status: "disabled" }) })?.label).toBe("mem off")
  })

  test("unavailable puts the error in the tooltip, honestly", () => {
    const chip = memoryChip({ read: read({ status: "unavailable", error: "substrate refused the connection" }) })
    expect(chip).toMatchObject({ label: "mem unavailable", tone: "warn" })
    expect(chip?.title).toBe("memory unavailable: substrate refused the connection")
    expect(chip?.aria).toBe("shared memory unavailable: substrate refused the connection")
  })

  test("a failed read with a stored write keeps the arrows and flags the problem", () => {
    const chip = memoryChip({
      read: read({ status: "unavailable", error: "down" }),
      write: { status: "stored", subject: "s" },
    })
    expect(chip).toMatchObject({ label: "mem ↓! ↑1", tone: "warn" })
    expect(chip?.title).toContain("memory unavailable: down")
  })

  test("a write that did not land is flagged", () => {
    for (const status of ["unverified", "quarantined", "denied", "conflict", "unavailable"] as const) {
      expect(memoryChip({ read: read(), write: { status, error: "e" } })).toMatchObject({ label: "mem ↓0 ↑!", tone: "warn" })
    }
    expect(memoryChip({ read: read(), write: { status: "skipped" } })).toMatchObject({ label: "mem ↓0 ↑0", tone: "neutral" })
  })

  test("read and write sentences", () => {
    expect(memoryReadText(undefined)).toBeUndefined()
    expect(memoryReadText(read({ status: "empty" }))).toBe("no related memories found")
    expect(memoryReadText(read({ items: [item("a")] }))).toBe("read 1 memory")
    expect(memoryReadText(read({ items: [item("a"), item("b")], briefState: "degraded" }))).toBe("read 2 memories (brief degraded)")
    expect(memoryReadText(read({ status: "unavailable" }))).toContain("memory unavailable:")
    expect(memoryWriteText({ status: "stored", subject: "openflow/x" })).toBe("stored: openflow/x")
    expect(memoryWriteText({ status: "denied", error: "scope not writable" })).toBe("denied by Substrate: scope not writable")
    expect(memoryWriteText(undefined)).toBeUndefined()
  })

  test("rows truncate the preview and show age when the host sent one", () => {
    const row = memoryRow({ ...item("openflow/p/r/c"), preview: "x".repeat(300), run: "r", card: "c", ageDays: 3 })
    expect(row.preview.length).toBe(140)
    expect(row).toMatchObject({ scope: "repo:o/r", subject: "openflow/p/r/c", age: "3 d ago", from: "run r · card c" })
    expect(memoryRow(item("s")).age).toBeUndefined()
    expect(memoryAge(0.2)).toBe("today")
  })
})

describe("swarm", () => {
  test("counts read in a fixed order with 'done' for completed", () => {
    expect(swarmCountsText({ queued: 1, running: 2, completed: 3, failed: 1, cancelled: 0 })).toBe("2 running · 1 queued · 3 done · 1 failed")
    expect(swarmCountsText({ queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 })).toBe("")
  })

  test("visible only once something happened or it degraded", () => {
    expect(swarmVisible(undefined)).toBe(false)
    expect(swarmVisible(swarm({ mode: "off", active: true }))).toBe(false)
    expect(swarmVisible(swarm({ active: false }))).toBe(false)
    expect(swarmVisible(swarm({ active: true }))).toBe(true)
    expect(swarmVisible(swarm({ active: false, error: "preflight failed" }))).toBe(true)
  })

  test("a running swarm", () => {
    const status = swarm({
      counts: { queued: 0, running: 1, completed: 1, failed: 0, cancelled: 0 },
      agents: [
        { agent: "a05-backend", state: "running", activity: "edit src/x.ts", at: 1 },
        { agent: "a08-qa", state: "completed", at: 1 },
      ],
    })
    const line = swarmLine(status)
    expect(line).toMatchObject({ text: "swarm 1 running · 1 done", tone: "info", aria: "agent swarm 1 running · 1 done", more: 0 })
    expect(line?.title).toBe("swarm 1 running · 1 done\na05-backend: running — edit src/x.ts\na08-qa: completed")
    expect(line?.pills.map((pill) => pill.agent)).toEqual(["a05-backend", "a08-qa"])
  })

  test("delegating before any agent reported", () => {
    expect(swarmLine(swarm())?.text).toBe("swarm delegating")
  })

  test("a failed lane is the danger tone", () => {
    expect(swarmLine(swarm({ counts: { queued: 0, running: 0, completed: 0, failed: 1, cancelled: 0 } }))?.tone).toBe("danger")
  })

  test("degraded shows the error, always", () => {
    const line = swarmLine(swarm({ error: "no signing key", active: false }))
    expect(line).toMatchObject({ text: "swarm degraded: no signing key", tone: "danger", aria: "agent swarm degraded: no signing key" })
  })

  test("pills cap and count the rest", () => {
    const agents = Array.from({ length: 6 }, (_, at) => ({ agent: `a${at}`, state: "queued" as const, at: 1 }))
    const result = swarmPills(agents)
    expect(result.pills).toHaveLength(4)
    expect(result.more).toBe(2)
  })

  test("idle text depends on the mode", () => {
    expect(swarmIdleText(swarm({ mode: "always", active: false }))).toContain("a01-orchestrator")
    expect(swarmIdleText(swarm({ mode: "auto", active: false }))).toContain("no delegation yet")
  })
})

describe("announcements", () => {
  test("a snapshot has one sentence per surface that has state", () => {
    expect(stageSnapshot({})).toEqual({ uplift: undefined, memory: undefined, swarm: undefined })
    expect(stageSnapshot({ uplift: uplift({}) }).uplift).toBe("prompt uplifted")
  })

  test("only changed surfaces are announced, and nothing when nothing moved", () => {
    const before = stageSnapshot({ uplift: uplift({ status: "running" }) })
    const after = stageSnapshot({ uplift: uplift({}), memory: { read: { status: "empty", items: [] } } })
    expect(stageAnnouncement("builder", before, after)).toBe("builder: prompt uplifted. shared memory — no related memories found")
    expect(stageAnnouncement("builder", after, after)).toBe("")
  })

  test("a surface that disappears is not announced", () => {
    const before = stageSnapshot({ uplift: uplift({}) })
    expect(stageAnnouncement("builder", before, stageSnapshot({}))).toBe("")
  })
})

describe("wrapFocus", () => {
  test("Tab moves forward and wraps at the end", () => {
    expect(wrapFocus(0, 3, false)).toBe(1)
    expect(wrapFocus(2, 3, false)).toBe(0)
  })

  test("Shift+Tab moves back and wraps at the start", () => {
    expect(wrapFocus(2, 3, true)).toBe(1)
    expect(wrapFocus(0, 3, true)).toBe(2)
  })

  test("focus outside the dialog enters at the near end", () => {
    expect(wrapFocus(-1, 3, false)).toBe(0)
    expect(wrapFocus(-1, 3, true)).toBe(2)
  })

  test("nothing focusable means nowhere to go", () => {
    expect(wrapFocus(-1, 0, false)).toBe(-1)
  })
})
