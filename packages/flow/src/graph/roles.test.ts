import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  allRoles,
  customRoles,
  forgetCustomRoles,
  hydrateCustomRoles,
  isCustomRole,
  onRolesSyncError,
  removeCustomRole,
  role,
  rolesOnOpen,
  saveCustomRole,
  type Role,
} from "./roles"

/**
 * The signal is the source of truth and localStorage is best-effort, so these
 * round-trip with no storage at all — `bun test` has no `localStorage`, which is
 * exactly the "storage refused the write" case the UI has to report.
 */
describe("custom roles", () => {
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
  const original = globalThis.fetch
  const sent: { method: string; body: string }[] = []
  let stored: unknown = []

  beforeEach(() => {
    sent.length = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method === "GET") return Response.json(stored, { status: stored === undefined ? 500 : 200 })
      sent.push({ method, body: String(init?.body) })
      return Response.json({ saved: true })
    }) as typeof fetch
    forgetCustomRoles()
  })
  afterEach(() => {
    globalThis.fetch = original
    forgetCustomRoles()
  })

  const mine: Role = { id: "mine", label: "mine", color: "#fff", agent: { prompt: "a" } }

  test("opening a project without roles does not copy the previous project's into it", async () => {
    stored = [mine]
    await hydrateCustomRoles()
    expect(customRoles()).toEqual([mine])

    stored = []
    await hydrateCustomRoles()

    expect(customRoles()).toEqual([])
    expect(sent).toEqual([])
  })

  test("a project whose roles cannot be read is not written to, and says so", async () => {
    const reasons: string[] = []
    onRolesSyncError((reason) => reasons.push(reason))
    stored = undefined
    await hydrateCustomRoles()

    saveCustomRole({ label: "late", color: "#fff", agent: { prompt: "" } })

    expect(sent).toEqual([])
    expect(reasons).toHaveLength(1)
  })

  test("after the roles were read, edits are written through", async () => {
    stored = [mine]
    await hydrateCustomRoles()
    saveCustomRole({ label: "second", color: "#fff", agent: { prompt: "" } })
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe("PUT")
    expect(JSON.parse(sent[0].body).map((entry: Role) => entry.id)).toEqual(["mine", "second"])
  })
})

describe("rolesOnOpen", () => {
  const mine: Role = { id: "mine", label: "mine", color: "#fff", agent: { prompt: "a" } }
  const browser: Role = { id: "browser", label: "browser", color: "#fff", agent: { prompt: "b" } }

  test("an unreadable project changes nothing", () => {
    expect(rolesOnOpen(undefined, [browser], false)).toBeUndefined()
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
})
