import { describe, expect, test } from "bun:test"
import { statusLabel } from "./status-label"

describe("statusLabel", () => {
  test("maps engine statuses onto the harness words", () => {
    expect(statusLabel("queued")).toBe("starting")
    expect(statusLabel("done")).toBe("succeeded")
    expect(statusLabel("error")).toBe("failed")
    expect(statusLabel("skipped")).toBe("blocked")
    expect(statusLabel("running")).toBe("running")
  })
})
