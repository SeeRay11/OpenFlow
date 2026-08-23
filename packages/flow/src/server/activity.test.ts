import { describe as group, expect, test } from "bun:test"
import type { NodeEvent } from "../graph/types"
import {
  applyEvent,
  clip,
  createActivity,
  describe as label,
  EVENT_LIMIT,
  LIVE_BODY_LIMIT,
  PERSIST_BODY_LIMIT,
  PERSIST_EVENT_LIMIT,
  persistable,
} from "./activity"

function collector(owner: Record<string, string>) {
  const seen: Array<{ node: string; event: NodeEvent }> = []
  const activity = createActivity({
    owner: (sessionID) => owner[sessionID],
    emit: (node, event) => seen.push({ node, event }),
    now: () => 1,
  })
  return { activity, seen, last: () => seen[seen.length - 1] }
}

group("createActivity", () => {
  test("streams text deltas into one growing row", () => {
    const { activity, seen, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.text.delta", data: { sessionID: "s1", textID: "t1", delta: "he" } })
    activity.consume({ type: "session.next.text.delta", data: { sessionID: "s1", textID: "t1", delta: "llo" } })
    expect(seen).toHaveLength(2)
    expect(last().node).toBe("n1")
    expect(last().event.id).toBe("text:t1")
    expect(last().event.body).toBe("hello")
    expect(last().event.status).toBe("running")

    activity.consume({
      type: "session.next.text.ended",
      data: { sessionID: "s1", textID: "t1", text: "hello there" },
    })
    expect(last().event.body).toBe("hello there")
    expect(last().event.status).toBe("done")
  })

  test("a tool call carries its arguments and its result", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.tool.input.started", data: { sessionID: "s1", callID: "c1", name: "grep" } })
    activity.consume({
      type: "session.next.tool.called",
      data: { sessionID: "s1", callID: "c1", tool: "grep", input: { pattern: "handler", path: "src" } },
    })
    expect(last().event.id).toBe("tool:c1")
    expect(last().event.title).toBe("grep pattern=handler path=src")
    expect(last().event.input).toContain("handler")

    activity.consume({
      type: "session.next.tool.success",
      data: { sessionID: "s1", callID: "c1", content: [{ type: "text", text: "3 matches" }] },
    })
    expect(last().event.status).toBe("done")
    expect(last().event.body).toBe("3 matches")
  })

  test("a tool that returned no readable content falls back to its structured payload", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.tool.input.started", data: { sessionID: "s1", callID: "c1", name: "glob" } })
    activity.consume({
      type: "session.next.tool.success",
      data: { sessionID: "s1", callID: "c1", content: [], structured: { count: 4 } },
    })
    expect(last().event.body).toContain("\"count\": 4")
  })

  test("a failed tool keeps the reason it failed", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.tool.input.started", data: { sessionID: "s1", callID: "c1", name: "bash" } })
    activity.consume({
      type: "session.next.tool.failed",
      data: { sessionID: "s1", callID: "c1", error: { message: "exit 1" } },
    })
    expect(last().event.status).toBe("error")
    expect(last().event.body).toBe("exit 1")
  })

  test("a subagent's work lands on the node that spawned it", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.tool.input.started", data: { sessionID: "s1", callID: "c9", name: "task" } })
    activity.consume({ type: "session.created", data: { sessionID: "child", info: { parentID: "s1" } } })
    activity.consume({
      type: "session.next.tool.called",
      data: { sessionID: "child", callID: "c2", tool: "read", input: { filePath: "a.ts" } },
    })
    expect(last().node).toBe("n1")
    expect(last().event.depth).toBe(1)
    expect(last().event.parentCallID).toBe("c9")
    expect(last().event.sessionID).toBe("child")
  })

  test("a subagent of a subagent nests one level deeper", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.tool.input.started", data: { sessionID: "s1", callID: "c1", name: "task" } })
    activity.consume({ type: "session.created", data: { sessionID: "child", info: { parentID: "s1" } } })
    activity.consume({ type: "session.created", data: { sessionID: "grandchild", info: { parentID: "child" } } })
    activity.consume({
      type: "session.next.text.delta",
      data: { sessionID: "grandchild", textID: "t9", delta: "deep" },
    })
    expect(last().node).toBe("n1")
    expect(last().event.depth).toBe(2)
  })

  test("events from a session this run does not own are dropped", () => {
    const { activity, seen } = collector({ s1: "n1" })
    activity.consume({ type: "session.next.text.delta", data: { sessionID: "other", textID: "t1", delta: "x" } })
    expect(seen).toHaveLength(0)
  })

  test("a step names the agent and the model it ran on", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({
      type: "session.next.step.started",
      data: { sessionID: "s1", assistantMessageID: "m1", agent: "build", model: { providerID: "opencode", id: "zen" } },
    })
    expect(last().event.kind).toBe("step")
    expect(last().event.title).toBe("build · opencode/zen")
  })

  test("a body longer than the live limit is clipped, and says so", () => {
    const { activity, last } = collector({ s1: "n1" })
    activity.consume({
      type: "session.next.tool.input.started",
      data: { sessionID: "s1", callID: "c1", name: "read" },
    })
    activity.consume({
      type: "session.next.tool.success",
      data: { sessionID: "s1", callID: "c1", content: [{ type: "text", text: "x".repeat(20_000) }] },
    })
    expect(last().event.body!.length).toBeLessThan(LIVE_BODY_LIMIT + 60)
    expect(last().event.body).toContain("more characters")
  })

  test("a note is attributed to a node directly, without a session", () => {
    const { activity, last } = collector({})
    activity.note("n1", "permission:p1", "permission bash: once", "rm -rf", "done")
    expect(last().node).toBe("n1")
    expect(last().event.id).toBe("note:permission:p1")
    expect(last().event.body).toBe("rm -rf")
  })
})

group("applyEvent", () => {
  const base: NodeEvent = { id: "a", at: 1, kind: "tool", depth: 0, title: "grep" }

  test("replaces a row in place rather than appending it again", () => {
    const events = applyEvent([base], { ...base, status: "done", at: 9 })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe("done")
    // The row keeps where it happened, not when it finished.
    expect(events[0].at).toBe(1)
  })

  test("holds the list to the cap, dropping the oldest", () => {
    let events: NodeEvent[] = []
    for (let index = 0; index < EVENT_LIMIT + 5; index += 1) {
      events = applyEvent(events, { ...base, id: `e${index}` })
    }
    expect(events).toHaveLength(EVENT_LIMIT)
    expect(events[0].id).toBe("e5")
  })
})

group("persistable", () => {
  test("keeps the tail and clips the bodies", () => {
    const events: NodeEvent[] = Array.from({ length: PERSIST_EVENT_LIMIT + 10 }, (_, index) => ({
      id: `e${index}`,
      at: index,
      kind: "tool",
      depth: 0,
      title: "read",
      body: "y".repeat(PERSIST_BODY_LIMIT + 500),
    }))
    const saved = persistable(events)
    expect(saved).toHaveLength(PERSIST_EVENT_LIMIT)
    expect(saved[0].id).toBe("e10")
    expect(saved[0].body!.length).toBeLessThan(PERSIST_BODY_LIMIT + 60)
  })
})

group("helpers", () => {
  test("clip leaves a short body alone", () => {
    expect(clip("short", 10)).toBe("short")
  })

  test("a tool with no interesting arguments is just its name", () => {
    expect(label("todoread", {})).toBe("todoread")
  })

  test("an argument is flattened onto one line", () => {
    expect(label("bash", { command: "ls\n  -la" })).toBe("bash command=ls -la")
  })
})
