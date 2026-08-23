import { describe, expect, test } from "bun:test"
import { allRoles, customRoles, isCustomRole, removeCustomRole, role, saveCustomRole } from "./roles"

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
