import { describe, expect, test } from "bun:test"
import {
  DEFAULT_OMP_SETTINGS,
  type OmpConfigEntry,
  type OmpSettings,
  type OmpStatusView,
  type ValidationError,
} from "../../shared/omp"
import type { SwarmPreflight } from "../../shared/swarm"
import {
  FIELDS,
  SECTIONS,
  TABS,
  UNGROUPED,
  buildPatch,
  canCopyLogins,
  copyLoginsOutcome,
  describedBy,
  dirtyPaths,
  displayValue,
  effectiveLines,
  entryDirty,
  entryDraft,
  entryInput,
  errorId,
  errorMap,
  escapeStep,
  fieldId,
  formErrors,
  groupEntries,
  parseEntry,
  problemActions,
  problemsOfferTerminal,
  readOnlyReason,
  remoteFrom,
  searchEntries,
  statusRows,
  statusSummary,
  swarmView,
  tabTarget,
  toDraft,
  trapTarget,
} from "./omp-settings-model"

const saved: OmpSettings = structuredClone(DEFAULT_OMP_SETTINGS)

function entry(overrides: Partial<OmpConfigEntry> & Pick<OmpConfigEntry, "key">): OmpConfigEntry {
  return { type: "string", description: "", value: undefined, editable: true, ...overrides }
}

describe("fields", () => {
  test("cover every settings leaf exactly once, so a contract change cannot leave a setting with no input", () => {
    const draftPaths = Object.keys(toDraft(saved)).sort()
    expect(FIELDS.map((field) => field.path).sort()).toEqual(draftPaths)
    expect(new Set(FIELDS.map((field) => field.path)).size).toBe(FIELDS.length)
  })

  test("choice fields only offer values the contract accepts", () => {
    const choices = (path: string) => FIELDS.find((field) => field.path === path)?.choices?.map((choice) => choice.value)
    expect(choices("swarm.mode")).toEqual(["off", "auto", "always"])
    expect(choices("memory.ttl")).toEqual(["graph", "30d", "permanent"])
    expect(choices("manualApproval")).toEqual(["write", "always-ask"])
  })

  test("sections each have a title and at least one field", () => {
    expect(SECTIONS.every((section) => section.title && section.fields.length > 0)).toBe(true)
  })
})

describe("toDraft / dirtyPaths", () => {
  test("flattens nested settings and keeps numbers as text", () => {
    const draft = toDraft(saved)
    expect(draft["uplift.timeoutMs"]).toBe("240000")
    expect(draft["swarm.mode"]).toBe("auto")
    expect(draft.loadUserExtensions).toBe(false)
  })

  test("an untouched draft is clean", () => {
    expect(dirtyPaths(saved, toDraft(saved))).toEqual([])
  })

  test("reports exactly the changed paths", () => {
    const draft = { ...toDraft(saved), profile: "work", "memory.readLimit": "3", "uplift.enabled": false }
    expect(dirtyPaths(saved, draft).sort()).toEqual(["memory.readLimit", "profile", "uplift.enabled"])
  })

  test("surrounding whitespace is not a change", () => {
    expect(dirtyPaths(saved, { ...toDraft(saved), profile: "  openflow  ", "uplift.timeoutMs": " 240000 " })).toEqual([])
  })

  test("typing a value back to what was saved is clean again", () => {
    const draft = { ...toDraft(saved), profile: "work" }
    draft.profile = "openflow"
    expect(dirtyPaths(saved, draft)).toEqual([])
  })
})

describe("buildPatch", () => {
  test("sends only changed leaves, nested, with numbers as numbers and text trimmed", () => {
    const draft = { ...toDraft(saved), profile: " work ", "uplift.timeoutMs": "60000", "uplift.enabled": false, "swarm.mode": "off" }
    expect(buildPatch(saved, draft)).toEqual({
      patch: { profile: "work", uplift: { timeoutMs: 60_000, enabled: false }, swarm: { mode: "off" } },
      errors: [],
    })
  })

  test("an unchanged draft is an empty patch", () => {
    expect(buildPatch(saved, toDraft(saved))).toEqual({ patch: {}, errors: [] })
  })

  test("a changed number that is not a number is reported against its field and left out of the patch", () => {
    const draft = { ...toDraft(saved), maxSessionMinutes: "soon", "memory.readLimit": "", "uplift.timeoutMs": "1e9" }
    const { patch, errors } = buildPatch(saved, draft)
    expect(errors.map((error) => error.path).sort()).toEqual(["maxSessionMinutes", "memory.readLimit"])
    expect(patch).toEqual({ uplift: { timeoutMs: 1e9 } })
  })

  test("clearing a text field sends an empty string, which the host reads as 'use the environment'", () => {
    const base = structuredClone(saved)
    base.swarm.root = "/swarm"
    expect(buildPatch(base, { ...toDraft(base), "swarm.root": "" }).patch).toEqual({ swarm: { root: "" } })
  })
})

describe("errors", () => {
  const errors: ValidationError[] = [
    { path: "uplift.timeoutMs", message: "too small" },
    { path: "uplift.timeoutMs", message: "whole number" },
    { path: "profile", message: "bad name" },
    { path: "", message: "The OpenFlow host did not answer." },
    { path: "nonsense.path", message: "unknown setting" },
  ]

  test("errorMap joins messages per known field and ignores the rest", () => {
    expect(errorMap(errors)).toEqual({ "uplift.timeoutMs": "too small whole number", profile: "bad name" })
  })

  test("formErrors keeps what no field can show", () => {
    expect(formErrors(errors)).toEqual(["The OpenFlow host did not answer.", "unknown setting"])
  })

  test("ids are stable and unique per path", () => {
    expect(fieldId("uplift.timeoutMs")).toBe("omp-setting-uplift-timeoutMs")
    expect(errorId("profile")).toBe("omp-setting-profile-error")
    expect(new Set(FIELDS.map((field) => fieldId(field.path))).size).toBe(FIELDS.length)
  })

  test("describedBy lists the error before the hint and omits what is absent", () => {
    const withHint = FIELDS.find((field) => field.path === "maxSessionMinutes")!
    const without = FIELDS.find((field) => field.path === "swarm.mode")!
    expect(describedBy(withHint, "bad")).toBe("omp-setting-maxSessionMinutes-error omp-setting-maxSessionMinutes-hint")
    expect(describedBy(withHint, undefined)).toBe("omp-setting-maxSessionMinutes-hint")
    expect(describedBy(without, undefined)).toBeUndefined()
    expect(describedBy(without, "bad")).toBe("omp-setting-swarm-mode-error")
  })
})

describe("effectiveLines", () => {
  test("says where each value comes from using variable names only", () => {
    const lines = effectiveLines({
      effective: {
        binary: { from: "default" },
        "substrate.url": { from: "env", env: "SUBSTRATE_URL" },
        "swarm.root": { from: "settings" },
        "uplift.root": { from: "default" },
      },
    })
    expect(lines.map((line) => line.text)).toEqual([
      "using omp from PATH",
      "from $SUBSTRATE_URL",
      "set here",
      "using omp's plugin directory",
    ])
    expect(lines[1]?.label).toBe("Substrate URL")
  })
})

describe("option list", () => {
  const entries = [
    entry({ key: "theme.dark", description: "Dark theme", group: "appearance" }),
    entry({ key: "symbolPreset", type: "enum", options: ["unicode", "nerd"], description: "Glyph set", group: "appearance" }),
    entry({ key: "compaction.thresholdPercent", type: "number", value: -1, description: "Context threshold", group: "context" }),
    entry({ key: "zzz.loose", description: "No category" }),
    entry({ key: "auth.broker.token", editable: false, redacted: true }),
  ]

  test("search needs every word and looks at key, description and group", () => {
    expect(searchEntries(entries, "").length).toBe(5)
    expect(searchEntries(entries, "theme").map((item) => item.key)).toEqual(["theme.dark"])
    expect(searchEntries(entries, "GLYPH set").map((item) => item.key)).toEqual(["symbolPreset"])
    expect(searchEntries(entries, "appearance").length).toBe(2)
    expect(searchEntries(entries, "appearance context")).toEqual([])
    expect(searchEntries(entries, "   ")).toBe(entries)
  })

  test("groups keep omp's order, sort keys inside a group, and put uncategorised entries last", () => {
    const groups = groupEntries(entries)
    expect(groups.map((group) => group.group)).toEqual(["appearance", "context", UNGROUPED])
    expect(groups[0]?.entries.map((item) => item.key)).toEqual(["symbolPreset", "theme.dark"])
    expect(groups[2]?.entries.map((item) => item.key)).toEqual(["auth.broker.token", "zzz.loose"])
  })

  test("grouping nothing is no groups", () => {
    expect(groupEntries([])).toEqual([])
  })

  test("the input follows type and editability, and an enum without choices degrades to text", () => {
    expect(entryInput(entry({ key: "a", type: "boolean" }))).toBe("toggle")
    expect(entryInput(entry({ key: "a", type: "number" }))).toBe("number")
    expect(entryInput(entry({ key: "a", type: "enum", options: ["x"] }))).toBe("choice")
    expect(entryInput(entry({ key: "a", type: "enum" }))).toBe("text")
    expect(entryInput(entry({ key: "a", type: "string" }))).toBe("text")
    expect(entryInput(entry({ key: "a", type: "array", editable: false }))).toBe("readonly")
    expect(entryInput(entry({ key: "a", redacted: true, editable: false }))).toBe("readonly")
  })
})

describe("entry values", () => {
  const flag = entry({ key: "f", type: "boolean", value: true })
  const count = entry({ key: "n", type: "number", value: 5 })
  const choice = entry({ key: "c", type: "enum", options: ["a", "b"], value: "a" })
  const text = entry({ key: "t", value: "hello" })

  test("drafts start from the current value; unset is empty text", () => {
    expect(entryDraft(flag)).toBe(true)
    expect(entryDraft(count)).toBe("5")
    expect(entryDraft(entry({ key: "u" }))).toBe("")
    expect(entryDraft(entry({ key: "b", type: "boolean" }))).toBe(false)
  })

  test("parse mirrors the host's checks", () => {
    expect(parseEntry(flag, false)).toEqual({ ok: true, value: false })
    expect(parseEntry(count, " 7.5 ")).toEqual({ ok: true, value: 7.5 })
    expect(parseEntry(count, "")).toEqual({ ok: false, message: "Enter a number." })
    expect(parseEntry(count, "Infinity")).toEqual({ ok: false, message: "Enter a number." })
    expect(parseEntry(choice, "b")).toEqual({ ok: true, value: "b" })
    expect(parseEntry(choice, "z")).toEqual({ ok: false, message: "Choose one of a, b." })
    expect(parseEntry(text, "")).toEqual({ ok: true, value: "" })
  })

  test("dirty compares by type, and an unparsable number counts as dirty so Save can explain it", () => {
    expect(entryDirty(flag, true)).toBe(false)
    expect(entryDirty(flag, false)).toBe(true)
    expect(entryDirty(count, "5")).toBe(false)
    expect(entryDirty(count, "5.0")).toBe(false)
    expect(entryDirty(count, "6")).toBe(true)
    expect(entryDirty(count, "x")).toBe(true)
    expect(entryDirty(choice, "a")).toBe(false)
    expect(entryDirty(text, "hello!")).toBe(true)
  })

  test("display never shows a redacted value and abbreviates long ones", () => {
    expect(displayValue(entry({ key: "k", redacted: true, editable: false }))).toBe("set")
    expect(displayValue(entry({ key: "k" }))).toBe("not set")
    expect(displayValue(entry({ key: "k", value: "" }))).toBe("empty")
    expect(displayValue(entry({ key: "k", type: "array", value: ["a", "b"], editable: false }))).toBe('["a","b"]')
    const long = displayValue(entry({ key: "k", value: "x".repeat(500) }))
    expect(long.length).toBe(140)
    expect(long.endsWith("...")).toBe(true)
  })

  test("a read-only reason names the terminal either way", () => {
    expect(readOnlyReason(entry({ key: "k", type: "array", editable: false }))).toContain("terminal")
    expect(readOnlyReason(entry({ key: "k", redacted: true, editable: false }))).toContain("Credentials")
  })
})

describe("status", () => {
  const healthy: OmpStatusView = {
    available: true,
    binary: "/usr/bin/omp",
    version: "18.12.2",
    minVersion: "18.12.2",
    profile: "openflow",
    configDir: "/home/u/.omp/profiles/openflow/agent",
    providers: { authenticated: 2, total: 84 },
    problems: [],
    warnings: [],
    checkedAt: 1,
  }

  test("rows carry the facts the dialog lists and mark what needs attention", () => {
    const rows = statusRows(healthy)
    expect(rows.map((row) => row.label)).toEqual(["omp binary", "Version", "Profile", "Config directory", "Providers"])
    expect(rows.at(-1)).toEqual({ label: "Providers", value: "2 of 84 authenticated", ok: true })
    const broken = statusRows({ ...healthy, binary: undefined, version: undefined, available: false, providers: { authenticated: 0, total: 3 } })
    expect(broken.filter((row) => !row.ok).map((row) => row.label)).toEqual(["omp binary", "Version", "Providers"])
  })

  test("rows omit providers when omp could not be asked", () => {
    expect(statusRows({ ...healthy, providers: undefined }).some((row) => row.label === "Providers")).toBe(false)
  })

  test("the summary counts problems", () => {
    expect(statusSummary(healthy)).toBe("omp 18.12.2 is ready.")
    expect(statusSummary({ ...healthy, problems: [{ code: "no-credentials", message: "m" }] })).toBe("1 problem to fix.")
    expect(statusSummary({ ...healthy, problems: [{ code: "missing", message: "m" }, { code: "version", message: "m" }] })).toBe(
      "2 problems to fix.",
    )
  })

  test("each problem points at where it is fixed", () => {
    expect(problemActions({ code: "no-credentials", message: "" })).toEqual(["terminal"])
    expect(problemActions({ code: "missing", message: "" })).toEqual(["settings"])
    expect(problemActions({ code: "version", message: "" })).toEqual(["terminal"])
    expect(problemActions({ code: "no-models", message: "" })).toEqual(["terminal"])
    expect(problemActions({ code: "spawn", message: "" })).toEqual(["settings", "terminal"])
    expect(problemActions({ code: "profile", message: "" })).toEqual(["settings", "terminal"])
  })

  test("the status actions row repeats Open terminal only when no problem card already offers it", () => {
    expect(problemsOfferTerminal([])).toBe(false)
    expect(problemsOfferTerminal([{ code: "missing", message: "" }])).toBe(false)
    expect(problemsOfferTerminal([{ code: "no-credentials", message: "" }])).toBe(true)
    expect(problemsOfferTerminal([{ code: "missing", message: "" }, { code: "profile", message: "" }])).toBe(true)
  })

  test("the copy-logins button is offered for a missing-credentials problem in a named profile only", () => {
    const missing = { code: "no-credentials", message: "m" } as const
    expect(canCopyLogins(healthy, missing)).toBe(true)
    expect(canCopyLogins({ ...healthy, profile: "" }, missing)).toBe(false)
    expect(canCopyLogins(healthy, { code: "no-models", message: "m" })).toBe(false)
    expect(canCopyLogins(healthy, { code: "profile", message: "m" })).toBe(false)
  })

  test("the copy outcome reports the count on success, and the host's sentence on failure", () => {
    const value = (imported: number) => ({ ok: true as const, value: { imported, status: healthy } })
    const three = copyLoginsOutcome(value(3))
    expect(three.ok).toBe(true)
    expect(three.text).toContain("3")
    expect(copyLoginsOutcome(value(1)).text).not.toBe(three.text)
    const refused = "the host's own sentence"
    expect(copyLoginsOutcome({ ok: false, status: 400, errors: [{ path: "", message: refused }] })).toEqual({
      ok: false,
      text: refused,
    })
    expect(copyLoginsOutcome({ ok: false, status: 0, errors: [{ path: "", message: "m" }] }).ok).toBe(false)
  })
})

describe("swarm view", () => {
  const ready: SwarmPreflight = { ok: true, effective: "auto", requested: "auto", problems: [], root: "/opt/agent-swarm" }
  const degraded: SwarmPreflight = {
    ok: false,
    effective: "off",
    requested: "always",
    root: undefined,
    problems: [{ code: "no-root", message: "No agent-swarm checkout was found.", fix: "Set the agent-swarm location in the Cards tab." }],
  }

  test("pending and failed checks are states of their own", () => {
    expect(swarmView(undefined)).toEqual({ tone: "pending", text: "Checking the swarm…", problems: [] })
    const failed = swarmView({ ok: false, error: "The OpenFlow host did not answer." })
    expect(failed.tone).toBe("error")
    expect(failed.text).toContain("The OpenFlow host did not answer.")
  })

  test("off and a ready swarm are fine", () => {
    expect(swarmView({ ok: true, value: { ok: true, effective: "off", requested: "off", problems: [] } })).toEqual({
      tone: "ok",
      text: "Swarm is off: cards run without it.",
      problems: [],
    })
    expect(swarmView({ ok: true, value: ready })).toEqual({ tone: "ok", text: "Swarm is ready in auto mode.", problems: [] })
  })

  test("degrading to off is a warning that carries every problem with its fix", () => {
    const view = swarmView({ ok: true, value: degraded })
    expect(view.tone).toBe("warning")
    expect(view.text).toBe("Swarm degraded to off: always mode cannot run yet, so cards run without it.")
    expect(view.problems).toEqual(degraded.problems)
    expect(view.problems[0]?.fix).toContain("Cards tab")
  })

  test("a mode that is not the requested one but not off is named as such", () => {
    const view = swarmView({ ok: true, value: { ...degraded, effective: "auto", requested: "always" } })
    expect(view.tone).toBe("warning")
    expect(view.text).toBe("Swarm is running as auto instead of always.")
  })
})

describe("remoteFrom", () => {
  test("ready, error and disconnected are different states", () => {
    expect(remoteFrom({ ok: true, value: 1 })).toEqual({ state: "ready", value: 1 })
    expect(remoteFrom({ ok: false, status: 503, errors: [{ path: "", message: "omp was not found" }] })).toEqual({
      state: "error",
      message: "omp was not found",
    })
    expect(remoteFrom({ ok: false, status: 0, errors: [{ path: "", message: "no answer" }] })).toEqual({
      state: "disconnected",
      message: "no answer",
    })
  })
})

describe("keyboard", () => {
  test("escape goes back one level at a time", () => {
    expect(escapeStep({ editing: true, query: "x" })).toBe("cancel-edit")
    expect(escapeStep({ editing: false, query: "x" })).toBe("clear-search")
    expect(escapeStep({ editing: false, query: "" })).toBe("close")
  })

  test("tab wraps at both ends and is otherwise left to the browser", () => {
    expect(trapTarget(2, 3, false)).toBe(0)
    expect(trapTarget(0, 3, true)).toBe(2)
    expect(trapTarget(1, 3, false)).toBeUndefined()
    expect(trapTarget(1, 3, true)).toBeUndefined()
    expect(trapTarget(-1, 3, false)).toBe(0)
    expect(trapTarget(-1, 3, true)).toBe(2)
    expect(trapTarget(0, 0, false)).toBeUndefined()
    expect(trapTarget(0, 1, false)).toBe(0)
  })

  test("arrow keys move between tabs, wrapping; other keys do nothing", () => {
    const count = TABS.length
    expect(tabTarget(0, count, "ArrowRight")).toBe(1)
    expect(tabTarget(count - 1, count, "ArrowRight")).toBe(0)
    expect(tabTarget(0, count, "ArrowLeft")).toBe(count - 1)
    expect(tabTarget(1, count, "Home")).toBe(0)
    expect(tabTarget(0, count, "End")).toBe(count - 1)
    expect(tabTarget(0, count, "a")).toBeUndefined()
  })

  test("the Memory tab sits between the cards and omp's own options", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["status", "cards", "memory", "options"])
  })
})
