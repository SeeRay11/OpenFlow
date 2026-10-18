import { describe, expect, test } from "bun:test"
import type { Finding } from "../graph/coach"
import { dismissKey, visibleFindings } from "./coach-strip"

const finding = (id: string, severity: Finding["severity"] = "warn"): Finding => ({
  kind: id.split(":")[0],
  id,
  severity,
  cards: [],
  evidence: `evidence for ${id}`,
  fix: `fix for ${id}`,
})

const all = [finding("unearned-pass:a", "error"), finding("silent-card:b"), finding("note:c", "info")]

describe("visibleFindings", () => {
  test("nothing dismissed shows every finding in order", () => {
    expect(visibleFindings(all, new Set(), "run-1")).toEqual(all)
  })

  test("a dismissed finding is hidden for that run only", () => {
    const dismissed = new Set([dismissKey("run-1", "silent-card:b")])
    expect(visibleFindings(all, dismissed, "run-1").map((f) => f.id)).toEqual(["unearned-pass:a", "note:c"])
    expect(visibleFindings(all, dismissed, "run-2")).toEqual(all)
  })

  test("no run shows nothing", () => {
    expect(visibleFindings(all, new Set(), undefined)).toEqual([])
  })

  test("an empty list stays empty", () => {
    expect(visibleFindings([], new Set([dismissKey("run-1", "x")]), "run-1")).toEqual([])
  })
})
