import { describe, expect, test } from "bun:test"
import { formatAge, matches, sessionLabel, sessionRows, transcriptTurns } from "./sessions"

describe("sessionRows", () => {
  test("projects a session as the server returns it", () => {
    const [row] = sessionRows([
      {
        id: "ses_01",
        title: "refactor auth",
        agent: "coder",
        model: { providerID: "anthropic", id: "claude-opus-5" },
        projectID: "prj_01",
        cost: 0,
        time: { created: 1000, updated: 2000 },
      },
    ])
    expect(row).toEqual({
      id: "ses_01",
      title: "refactor auth",
      agent: "coder",
      model: "anthropic/claude-opus-5",
      parent: undefined,
      created: 1000,
      updated: 2000,
    })
  })

  test("keeps an untitled session, since it is usually the newest one", () => {
    const [row] = sessionRows([{ id: "ses_02", title: "   ", time: { created: 5 } }])
    expect(row.title).toBe("untitled session")
    // no `updated` on the wire falls back to `created` rather than to 1970,
    // which would sort the newest session to the bottom
    expect(row.updated).toBe(5)
  })

  test("marks a child session so a subagent is not read as a node", () => {
    const [row] = sessionRows([{ id: "ses_03", title: "grep", parentID: "ses_01", time: { created: 1 } }])
    expect(row.parent).toBe("ses_01")
  })
})

describe("transcriptTurns", () => {
  // The shape the server actually returns: a user message holds a top-level
  // `text` and no `content`, an assistant message holds `content` parts.
  test("keeps user and assistant text in order, across both message shapes", () => {
    expect(
      transcriptTurns([
        { type: "user", text: "fix the test" },
        { type: "assistant", content: [{ type: "text", text: "done" }] },
      ]),
    ).toEqual([
      { role: "user", text: "fix the test" },
      { role: "assistant", text: "done" },
    ])
  })

  test("a user message is not dropped for having no content array", () => {
    expect(transcriptTurns([{ type: "user", text: "  hello  " }])).toEqual([{ role: "user", text: "hello" }])
  })

  test("drops tool parts and the turns that are only tool calls", () => {
    expect(
      transcriptTurns([
        { type: "assistant", content: [{ type: "tool", name: "grep" }] },
        { type: "assistant", content: [{ type: "tool", name: "read" }, { type: "text", text: "found it" }] },
      ]),
    ).toEqual([{ role: "assistant", text: "found it" }])
  })

  test("ignores message kinds that are not turns", () => {
    expect(transcriptTurns([{ type: "summary", content: [{ type: "text", text: "compacted" }] }])).toEqual([])
  })
})

describe("sessionLabel", () => {
  const base = { id: "ses_01", created: 0, updated: 0 }

  test("a real title wins", () => {
    expect(sessionLabel({ ...base, title: "refactor auth", agent: "coder" })).toBe("refactor auth")
  })

  test("falls back to the agent, because every node session is auto-titled", () => {
    expect(sessionLabel({ ...base, title: "New session - 2026-08-26T00:26:27.570Z", agent: "plan-and-code-coder-nmt6c" }))
      .toBe("plan-and-code-coder-nmt6c")
  })

  test("keeps the auto-title when there is no agent to name instead", () => {
    expect(sessionLabel({ ...base, title: "New session - 2026-08-26T00:26:27.570Z" })).toBe(
      "New session - 2026-08-26T00:26:27.570Z",
    )
  })

  test("a title that merely starts similarly is still a real title", () => {
    expect(sessionLabel({ ...base, title: "New sessions dashboard", agent: "coder" })).toBe("New sessions dashboard")
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
