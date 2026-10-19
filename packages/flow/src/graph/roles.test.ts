import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  allRoles,
  customRoles,
  forgetCustomRoles,
  hydrateCustomRoles,
  isCustomRole,
  mergeRoles,
  onRolesSyncError,
  removeCustomRole,
  role,
  rolesOnOpen,
  saveCustomRole,
  type Role,
} from "./roles"

const original = globalThis.fetch
const sent: { method: string; body: string }[] = []
/** What the project's `roles.json` read answers; `undefined` is a read that fails. */
let stored: unknown = []
/** Holds the read until it resolves: a host that is slow to answer. */
let readGate: Promise<void> | undefined

beforeEach(() => {
  sent.length = 0
  stored = []
  readGate = undefined
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (method === "GET") {
      await readGate
      return Response.json(stored ?? { error: "unreadable" }, { status: stored === undefined ? 500 : 200 })
    }
    sent.push({ method, body: String(init?.body) })
    return Response.json({ saved: true })
  }) as typeof fetch
  forgetCustomRoles()
})
afterEach(() => {
  globalThis.fetch = original
  onRolesSyncError(() => undefined)
  forgetCustomRoles()
})

const mine: Role = { id: "mine", label: "mine", color: "#fff", agent: { prompt: "a" } }
const browser: Role = { id: "browser", label: "browser", color: "#fff", agent: { prompt: "b" } }

/**
 * The signal is the source of truth and localStorage is best-effort, so these
 * round-trip with no storage at all — `bun test` has no `localStorage`, which is
 * exactly the "storage refused the write" case the UI has to report.
 */
describe("custom roles", () => {
  beforeEach(async () => {
    await hydrateCustomRoles("/p")
  })

  test("a saved role is readable from the signal and reports whether it persisted", () => {
    const saved = saveCustomRole({
      label: "design planner",
      color: "#9ad1f0",
      agent: { prompt: "plan the design", tools: { read: true } },
    })
    expect(saved.role.id).toBe("design planner")
    expect(saved.persisted).toBe(false)
    expect(role("design planner")?.color).toBe("#9ad1f0")
    expect(isCustomRole("design planner")).toBe(true)
    expect(allRoles().at(-1)?.label).toBe("design planner")
    removeCustomRole("design planner")
  })

  test("renaming replaces the old entry instead of leaving both", () => {
    saveCustomRole({ label: "auditor", color: "#fff", agent: { prompt: "audit" } })
    saveCustomRole({ id: "auditor", label: "senior auditor", color: "#fff", agent: { prompt: "audit" } })
    expect(customRoles().map((entry) => entry.id)).toEqual(["senior auditor"])
    removeCustomRole("senior auditor")
  })

  test("removing reports whether the deletion reached storage", () => {
    saveCustomRole({ label: "throwaway", color: "#fff", agent: { prompt: "" } })
    expect(removeCustomRole("throwaway")).toBe(false)
    expect(isCustomRole("throwaway")).toBe(false)
    expect(customRoles()).toEqual([])
  })
})

describe("roles follow the project", () => {
  test("opening a project without roles does not copy the previous project's into it", async () => {
    stored = [mine]
    await hydrateCustomRoles("/p")
    expect(customRoles()).toEqual([mine])

    stored = []
    forgetCustomRoles()
    await hydrateCustomRoles("/p")

    expect(customRoles()).toEqual([])
    expect(sent).toEqual([])
  })

  test("a project whose roles cannot be read is not written to, and says so", async () => {
    const reasons: string[] = []
    onRolesSyncError((reason) => reasons.push(reason))
    stored = undefined
    await hydrateCustomRoles("/p")

    saveCustomRole({ label: "late", color: "#fff", agent: { prompt: "" } })
    await hydrateCustomRoles("/p")

    expect(sent).toEqual([])
    // One for the edit that could not be saved yet, one for the read that failed again.
    expect(reasons).toHaveLength(2)
    expect(customRoles().map((entry) => entry.id)).toEqual(["late"])
  })

  test("after the roles were read, edits are written through", async () => {
    stored = [mine]
    await hydrateCustomRoles("/p")
    saveCustomRole({ label: "second", color: "#fff", agent: { prompt: "" } })
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe("PUT")
    expect(JSON.parse(sent[0].body).map((entry: Role) => entry.id)).toEqual(["mine", "second"])
  })

  test("a role made while the project's roles are still loading survives an empty answer, and is written to the project", async () => {
    const gate = Promise.withResolvers<void>()
    readGate = gate.promise
    stored = []
    const loading = hydrateCustomRoles("/p")

    saveCustomRole({ label: "early", color: "#fff", agent: { prompt: "x" } })
    expect(sent).toEqual([])
    gate.resolve()
    await loading

    expect(customRoles().map((entry) => entry.id)).toEqual(["early"])
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0].body).map((entry: Role) => entry.id)).toEqual(["early"])
  })

  test("a role made while loading is merged after the project's own", async () => {
    const gate = Promise.withResolvers<void>()
    readGate = gate.promise
    stored = [mine]
    const loading = hydrateCustomRoles("/p")
    saveCustomRole({ label: "early", color: "#fff", agent: { prompt: "x" } })
    gate.resolve()
    await loading

    expect(customRoles().map((entry) => entry.id)).toEqual(["mine", "early"])
    expect(JSON.parse(sent[0].body).map((entry: Role) => entry.id)).toEqual(["mine", "early"])
  })
})

/** A browser's storage, which `bun test` does not have: a plain map behind the same three calls. */
function installStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  })
  return {
    data,
    restore() {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous)
      else Reflect.deleteProperty(globalThis, "localStorage")
    },
  }
}

describe("roles written before the project's own were read", () => {
  let browser!: { data: Map<string, string>; restore(): void }
  beforeEach(() => {
    browser = installStorage({ "openflow.customRoles.v1": JSON.stringify([browserOnly]), "openflow.customRolesMigrated.v1": "1" })
  })
  afterEach(() => browser.restore())

  const browserOnly: Role = { id: "old", label: "old", color: "#fff", agent: { prompt: "from the mirror" } }

  test("an edit goes to a pending key of its own, never over the mirror, and says it is not in the project yet", async () => {
    const reasons: string[] = []
    onRolesSyncError((reason) => reasons.push(reason))
    stored = undefined
    await hydrateCustomRoles("/p")

    const saved = saveCustomRole({ label: "late", color: "#fff", agent: { prompt: "x" } })

    expect(saved.persisted).toBe(true)
    expect(JSON.parse(browser.data.get("openflow.customRolesPending.v1:/p")!).map((entry: Role) => entry.id)).toEqual(["late"])
    expect(JSON.parse(browser.data.get("openflow.customRoles.v1")!)).toEqual([browserOnly])
    expect(reasons).toHaveLength(1)
    saveCustomRole({ label: "later", color: "#fff", agent: { prompt: "y" } })
    expect(reasons).toHaveLength(2)
  })

  test("an edit that cannot even be stored says so", () => {
    browser.restore()
    // No storage at all: the role lives in this tab only, and the editor is told.
    expect(saveCustomRole({ label: "tab only", color: "#fff", agent: { prompt: "" } }).persisted).toBe(false)
  })

  test("when the read works, pending roles are merged into the project's and the key is cleared", async () => {
    browser.data.set("openflow.customRolesPending.v1:/p", JSON.stringify([{ ...browserOnly, id: "left", label: "left" }]))
    stored = [mine]
    await hydrateCustomRoles("/p")

    expect(customRoles().map((entry) => entry.id)).toEqual(["mine", "left"])
    expect(JSON.parse(sent[0].body).map((entry: Role) => entry.id)).toEqual(["mine", "left"])
    expect(browser.data.has("openflow.customRolesPending.v1:/p")).toBe(false)
  })

  test("pending roles belong to their own project: another project neither reads, pushes nor clears them", async () => {
    browser.data.set("openflow.customRolesPending.v1:/a", JSON.stringify([{ ...browserOnly, id: "a-only", label: "a-only" }]))
    stored = [mine]
    await hydrateCustomRoles("/b")

    expect(customRoles().map((entry) => entry.id)).toEqual(["mine"])
    expect(sent).toEqual([])
    expect(browser.data.has("openflow.customRolesPending.v1:/a")).toBe(true)

    // Switching away from an unread project keeps what it was holding, under its own key.
    forgetCustomRoles()
    stored = undefined
    await hydrateCustomRoles("/c")
    saveCustomRole({ label: "for-c", color: "#fff", agent: { prompt: "" } })
    expect(JSON.parse(browser.data.get("openflow.customRolesPending.v1:/c")!).map((entry: Role) => entry.id)).toEqual(["for-c"])
    forgetCustomRoles()
    stored = []
    await hydrateCustomRoles("/d")
    expect(customRoles()).toEqual([])
    expect(browser.data.has("openflow.customRolesPending.v1:/c")).toBe(true)
  })

  test("a read that finishes after a project switch changes and writes nothing in the next project", async () => {
    const gate = Promise.withResolvers<void>()
    readGate = gate.promise
    stored = [mine]
    const stale = hydrateCustomRoles("/p")
    saveCustomRole({ label: "early", color: "#fff", agent: { prompt: "x" } })

    // The user switched project: the new project answers at once, and has no roles.
    forgetCustomRoles()
    readGate = undefined
    stored = []
    await hydrateCustomRoles("/p")
    const roles = customRoles()
    sent.length = 0

    gate.resolve()
    await stale

    expect(customRoles()).toBe(roles)
    expect(sent).toEqual([])
  })
})

describe("mergeRoles", () => {
  test("the project's roles come first, the local ones after, and local wins on one id", () => {
    const edited: Role = { ...mine, color: "#000" }
    expect(mergeRoles([mine, browser], [edited])).toEqual([browser, edited])
    expect(mergeRoles([mine], [])).toEqual([mine])
    expect(mergeRoles([], [mine])).toEqual([mine])
  })
})

describe("rolesOnOpen", () => {
  test("an unreadable project changes nothing", () => {
    expect(rolesOnOpen(undefined, [browser], false)).toBeUndefined()
    expect(rolesOnOpen(undefined, [browser], false, [mine])).toBeUndefined()
  })

  test("a project's own roles win over the browser's copy", () => {
    expect(rolesOnOpen([mine], [browser], false)).toEqual({ roles: [mine], push: false })
  })

  test("the browser's copy is offered once, to the first project that has none", () => {
    expect(rolesOnOpen([], [browser], false)).toEqual({ roles: [browser], push: true })
    expect(rolesOnOpen([], [browser], true)).toEqual({ roles: [], push: false })
  })

  test("nothing to offer means nothing to push", () => {
    expect(rolesOnOpen([], [], false)).toEqual({ roles: [], push: false })
  })

  test("edits made while loading are kept, merged and pushed whatever the project held", () => {
    expect(rolesOnOpen([], [], true, [mine])).toEqual({ roles: [mine], push: true })
    expect(rolesOnOpen([browser], [], true, [mine])).toEqual({ roles: [browser, mine], push: true })
  })
})
