import { describe, expect, test } from "bun:test"
import { formatAge, matches, sessionLabel } from "./sessions"

describe("sessionLabel", () => {
  const base = { id: "ses_01", created: 0, updated: 0 }

  test("a real title wins", () => {
    expect(sessionLabel({ ...base, title: "refactor auth", agent: "coder" })).toBe("refactor auth")
  })

  test("a blank title falls back to the card's agent key", () => {
    expect(sessionLabel({ ...base, title: "   ", agent: "plan-and-code-coder-nmt6c" })).toBe("plan-and-code-coder-nmt6c")
  })

  test("keeps a placeholder when there is neither, since a blank row is unclickable", () => {
    expect(sessionLabel({ ...base, title: "" })).toBe("untitled session")
  })
})

describe("formatAge", () => {
  const now = 1_000_000_000
  test.each([
    [now, "now"],
    [now - 59_000, "now"],
    [now - 60_000, "1m"],
    [now - 3_599_000, "59m"],
    [now - 3_600_000, "1h"],
    [now - 86_400_000, "1d"],
    // a clock skew that puts a session in the future must not render "-3m"
    [now + 60_000, "now"],
  ])("%p -> %p", (time, label) => {
    expect(formatAge(time, now)).toBe(label)
  })
})

describe("matches", () => {
  const row = {
    id: "ses_01K",
    title: "Refactor Auth",
    agent: "coder",
    model: "anthropic/claude-opus-5",
    created: 0,
    updated: 0,
  }

  test("an empty query keeps everything", () => {
    expect(matches(row, "   ")).toBe(true)
  })

  test("matches title, agent, model and id case-insensitively", () => {
    expect(matches(row, "auth")).toBe(true)
    expect(matches(row, "CODER")).toBe(true)
    expect(matches(row, "opus")).toBe(true)
    expect(matches(row, "ses_01k")).toBe(true)
    expect(matches(row, "planner")).toBe(false)
  })

  test("survives a row with no agent or model", () => {
    expect(matches({ id: "ses_02", title: "x", created: 0, updated: 0 }, "coder")).toBe(false)
  })
})
