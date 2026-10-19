import { describe, expect, test } from "bun:test"
import { createMessageStore, providerError, textOf, type MessageStore } from "./messages"
import type { OmpFrame } from "./rpc-types"
import { assistantMessage, createFakeProcess, frames, rpcError } from "./testing/fake-process"

function feed(store: MessageStore, list: OmpFrame[], epoch = "e1") {
  for (const frame of list) store.observe(frame, epoch)
}

describe("transcript", () => {
  test("is the final assistant message of the latest turn, not an earlier one", () => {
    const store = createMessageStore()
    feed(store, [
      frames.userMessage("u1", "first"),
      frames.messageEnd("m1", assistantMessage({ texts: ["old answer"] })),
      frames.userMessage("u2", "second"),
      frames.messageStart("m2"),
      frames.textDelta("m2", 0, "Hel"),
      frames.textDelta("m2", 0, "lo"),
    ])
    expect(store.transcript()).toEqual({ text: "Hello" })
    feed(store, [frames.messageEnd("m2", assistantMessage({ texts: ["Hello there"] }))])
    expect(store.transcript()).toEqual({ text: "Hello there" })
  })

  test("joins separate text blocks and is empty before any assistant message", () => {
    const store = createMessageStore()
    expect(store.transcript()).toEqual({ text: "" })
    feed(store, [frames.userMessage("u", "q"), frames.messageEnd("m", assistantMessage({ texts: ["a", "b"] }))])
    expect(store.transcript().text).toBe("a\n\nb")
  })

  test("a provider failure carries its status in the error text", () => {
    const store = createMessageStore()
    feed(store, [frames.userMessage("u", "q"), frames.messageEnd("m", assistantMessage({ stopReason: "error", errorMessage: "Too Many Requests", errorStatus: 429 }))])
    expect(store.transcript().error).toBe("Provider request failed with HTTP 429: Too Many Requests")
    expect(store.latestErrorStatus()).toBe(429)
  })

  test("providerError omits an unknown status and does not double-wrap", () => {
    expect(providerError("socket closed")).toBe("Provider request failed: socket closed")
    expect(providerError("Provider request failed with HTTP 500: x", 500)).toBe("Provider request failed with HTTP 500: x")
  })
})

describe("steps", () => {
  test("one per finished assistant message, keyed by epoch so a resumed process cannot collide", () => {
    const store = createMessageStore()
    feed(store, [frames.messageEnd("msg-1", assistantMessage())], "aaaa")
    feed(store, [frames.messageEnd("msg-1", assistantMessage())], "bbbb")
    const steps = store.steps()
    expect(steps.map((step) => step.messageID)).toEqual(["aaaa-msg-1", "bbbb-msg-1"])
    expect(steps[0]).toEqual({
      messageID: "aaaa-msg-1",
      model: "anthropic/claude-test",
      tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 7 },
      reportedCost: 0.3,
    })
  })

  test("a message still streaming is not a step yet", () => {
    const store = createMessageStore()
    feed(store, [frames.messageStart("m"), frames.textDelta("m", 0, "x")])
    expect(store.steps()).toEqual([])
  })
})

describe("calls", () => {
  test("newest first, with parsed input, deduped across stream and host-tool frames", () => {
    const store = createMessageStore()
    feed(store, [
      frames.update("m1", { type: "toolcall_end", contentIndex: 0, toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } } }),
      { type: "host_tool_call", id: "h1", toolCallId: "c2", toolName: "openflow_dispatch", arguments: { assignments: [{ card: "a", task: "t" }] } },
      frames.messageEnd("m1", assistantMessage({ tools: [{ id: "c2", name: "openflow_dispatch", arguments: { assignments: [{ card: "a", task: "t" }] } }] })),
    ])
    expect(store.calls()).toEqual([
      { id: "c2", name: "openflow_dispatch", input: { assignments: [{ card: "a", task: "t" }] } },
      { id: "c1", name: "bash", input: { command: "ls" } },
    ])
    expect(store.calls(1)).toHaveLength(1)
  })

  test("is bounded", () => {
    const store = createMessageStore({ limit: 5 })
    for (let index = 0; index < 20; index++) store.recordCall(`c${index}`, "bash", {})
    expect(store.calls(100).map((call) => call.id)).toEqual(["c19", "c18", "c17", "c16", "c15"])
  })
})

describe("turns", () => {
  test("user and assistant words in order, tool-only messages skipped, last N kept", () => {
    const store = createMessageStore()
    feed(store, [
      frames.userMessage("u1", "q1"),
      frames.messageEnd("m1", assistantMessage({ tools: [{ id: "c", name: "bash", arguments: {} }] })),
      frames.messageEnd("m2", assistantMessage({ texts: ["a1"] })),
      frames.userMessage("u2", "q2"),
      frames.messageEnd("m3", assistantMessage({ texts: ["a2"] })),
    ])
    expect(store.turns()).toEqual([
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ])
    expect(store.turns(2)).toEqual([
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ])
    expect(store.firstUserText()).toBe("q1")
  })

  test("the message list is bounded", () => {
    const store = createMessageStore({ limit: 3 })
    for (let index = 0; index < 10; index++) feed(store, [frames.userMessage(`u${index}`, `q${index}`)])
    expect(store.turns(100).map((turn) => turn.text)).toEqual(["q7", "q8", "q9"])
  })
})

describe("history", () => {
  test("pages a resumed session in front of nothing", async () => {
    const proc = createFakeProcess()
    const pages = [
      { messages: [{ role: "user", content: "hello", timestamp: 1 }, assistantMessage({ texts: ["hi"] })], nextCursor: "next" },
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "again" }], timestamp: 3 },
          { ...assistantMessage({ tools: [{ id: "c", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" }), timestamp: 4 },
          { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "out" }], isError: false, timestamp: 5 },
          { ...assistantMessage({ texts: ["final"] }), timestamp: 6 },
        ],
      },
    ]
    proc.on("get_messages_page", (command) => (command.cursor ? pages[1] : pages[0]))
    const store = createMessageStore()
    expect(await store.loadHistory(proc)).toBe(true)
    expect(proc.of("get_messages_page").map((command) => command.cursor)).toEqual([undefined, "next"])
    expect(store.transcript()).toEqual({ text: "final" })
    expect(store.calls()).toEqual([{ id: "c", name: "bash", input: { command: "ls" } }])
    expect(store.turns().map((turn) => turn.text)).toEqual(["hello", "hi", "again", "final"])
    expect(await store.loadHistory(proc)).toBe(true)
    expect(proc.of("get_messages_page")).toHaveLength(2)
  })

  test("session_busy means not yet: nothing is loaded and a later call may retry", async () => {
    const proc = createFakeProcess()
    proc.on("get_messages_page", () => {
      throw rpcError("get_messages_page", "busy", "session_busy")
    })
    const store = createMessageStore()
    expect(await store.loadHistory(proc)).toBe(false)
    proc.on("get_messages_page", { messages: [assistantMessage({ texts: ["x"] })] })
    expect(await store.loadHistory(proc)).toBe(true)
    expect(store.transcript().text).toBe("x")
  })

  test("any other failure is thrown", async () => {
    const proc = createFakeProcess()
    proc.on("get_messages_page", () => {
      throw rpcError("get_messages_page", "disk gone", "io")
    })
    await expect(createMessageStore().loadHistory(proc)).rejects.toThrow("disk gone")
  })

  test("is skipped once live messages have streamed, so steps are never counted twice", async () => {
    const proc = createFakeProcess()
    const store = createMessageStore()
    feed(store, [frames.messageEnd("m", assistantMessage({ texts: ["live"] }))])
    expect(await store.loadHistory(proc)).toBe(true)
    expect(proc.commands).toEqual([])
  })
})

test("textOf reads strings and text blocks only", () => {
  expect(textOf("plain")).toBe("plain")
  expect(textOf([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }])).toBe("a\nb")
  expect(textOf(undefined)).toBe("")
})
