import { describe, expect, test } from "bun:test"
import { createEventMapper } from "./events"
import type { OmpFrame } from "./rpc-types"
import { assistantMessage, frames } from "./testing/fake-process"

function mapper() {
  return createEventMapper({ sessionID: "s_1", epoch: "e1", agent: "card-key", model: "anthropic/claude-test" })
}

function run(frameList: OmpFrame[]) {
  const map = mapper()
  return frameList.flatMap((frame) => map.map(frame))
}

describe("assistant messages", () => {
  test("message_start of an assistant message is a step with the model and agent", () => {
    expect(run([frames.messageStart("msg-1")])).toEqual([
      {
        type: "session.next.step.started",
        data: { sessionID: "s_1", assistantMessageID: "e1-msg-1", model: { providerID: "anthropic", id: "claude-test" }, agent: "card-key" },
      },
    ])
  })

  test("agent_start, turn_start and user messages map to nothing", () => {
    expect(run([frames.agentStart(), { type: "turn_start" }, frames.messageStart("msg-0", "user"), frames.userMessage("msg-0", "hi")])).toEqual([])
  })

  test("text deltas open the part once and carry ids from message id and content index", () => {
    const events = run([frames.textDelta("msg-1", 0, "Hel"), frames.textDelta("msg-1", 0, "lo"), frames.textDelta("msg-1", 1, "!")])
    expect(events.map((event) => event.type)).toEqual([
      "session.next.text.started",
      "session.next.text.delta",
      "session.next.text.delta",
      "session.next.text.started",
      "session.next.text.delta",
    ])
    expect(events[0]?.data).toEqual({ sessionID: "s_1", textID: "e1-msg-1:0" })
    expect(events[2]?.data).toEqual({ sessionID: "s_1", textID: "e1-msg-1:0", delta: "lo" })
    expect(events[3]?.data?.textID).toBe("e1-msg-1:1")
  })

  test("thinking deltas and ends map to reasoning events", () => {
    const events = run([frames.update("msg-1", { type: "thinking_delta", contentIndex: 0, delta: "hmm" }), frames.update("msg-1", { type: "thinking_end", contentIndex: 0, content: "hmm" })])
    expect(events).toEqual([
      { type: "session.next.reasoning.delta", data: { sessionID: "s_1", reasoningID: "e1-msg-1:0", delta: "hmm" } },
      { type: "session.next.reasoning.ended", data: { sessionID: "s_1", reasoningID: "e1-msg-1:0", text: "hmm" } },
    ])
  })

  test("text_end carries the whole text and message_end does not end it twice", () => {
    const events = run([
      frames.textDelta("msg-1", 0, "Hi"),
      frames.update("msg-1", { type: "text_end", contentIndex: 0, content: "Hi" }),
      frames.messageEnd("msg-1", assistantMessage({ texts: ["Hi"] })),
    ])
    expect(events.filter((event) => event.type === "session.next.text.ended")).toEqual([{ type: "session.next.text.ended", data: { sessionID: "s_1", textID: "e1-msg-1:0", text: "Hi" } }])
  })

  test("a message that never streamed still gets its text from message_end", () => {
    const events = run([frames.messageEnd("msg-2", assistantMessage({ texts: ["whole"] }))])
    expect(events.map((event) => event.type)).toEqual(["session.next.text.started", "session.next.text.ended", "session.next.step.ended"])
    expect(events[1]?.data?.text).toBe("whole")
  })

  test("message_end ends the step with tokens: cache split, reasoning zero", () => {
    const events = run([frames.messageEnd("msg-1", assistantMessage())])
    expect(events).toEqual([
      {
        type: "session.next.step.ended",
        data: { sessionID: "s_1", assistantMessageID: "e1-msg-1", tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 7 } } },
      },
    ])
  })

  test("an errored assistant message fails the step with the HTTP status in the text, then still reports usage", () => {
    const events = run([frames.messageEnd("msg-1", assistantMessage({ stopReason: "error", errorMessage: "slow down", errorStatus: 429 }))])
    expect(events.map((event) => event.type)).toEqual(["session.next.step.failed", "session.next.step.ended"])
    expect(events[0]?.data?.error).toBe("Provider request failed with HTTP 429: slow down")
  })

  test("an aborted assistant message is not a failed step", () => {
    const events = run([frames.messageEnd("msg-1", assistantMessage({ stopReason: "aborted" }))])
    expect(events.map((event) => event.type)).toEqual(["session.next.step.ended"])
  })
})

describe("tools", () => {
  test("toolcall_end announces the call by name; execution start adds the input, once", () => {
    const events = run([
      frames.update("msg-1", { type: "toolcall_end", contentIndex: 1, toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } } }),
      frames.toolStart("call_1", "bash", { command: "ls" }),
      frames.toolStart("call_1", "bash", { command: "ls" }),
    ])
    expect(events).toEqual([
      { type: "session.next.tool.input.started", data: { sessionID: "s_1", callID: "call_1", name: "bash" } },
      { type: "session.next.tool.called", data: { sessionID: "s_1", callID: "call_1", tool: "bash", input: { command: "ls" } } },
    ])
  })

  test("a tool that starts without a toolcall_end is still announced first", () => {
    const events = run([frames.toolStart("call_2", "edit", { path: "a.ts" })])
    expect(events.map((event) => event.type)).toEqual(["session.next.tool.input.started", "session.next.tool.called"])
  })

  test("updates become progress; text results become success content", () => {
    const events = run([
      { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
      frames.toolEnd("call_1", "bash", "done"),
    ])
    expect(events).toEqual([
      { type: "session.next.tool.progress", data: { sessionID: "s_1", callID: "call_1", content: [{ type: "text", text: "partial" }] } },
      { type: "session.next.tool.success", data: { sessionID: "s_1", callID: "call_1", content: [{ type: "text", text: "done" }] } },
    ])
  })

  test("an erroring tool is tool.failed with its text", () => {
    const events = run([frames.toolEnd("call_1", "bash", "exit 2", true)])
    expect(events[0]?.type).toBe("session.next.tool.failed")
    expect(events[0]?.data?.error).toBe("exit 2")
  })

  test("a tool result with no text falls back to the raw result", () => {
    const events = run([{ type: "tool_execution_end", toolCallId: "c", toolName: "x", result: { details: { n: 1 } } }])
    expect(events[0]?.data).toEqual({ sessionID: "s_1", callID: "c", content: [], result: { details: { n: 1 } } })
  })

  test("a huge tool result is clipped and says so", () => {
    const events = run([frames.toolEnd("c", "read", "x".repeat(100_000))])
    const text = (events[0]?.data?.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text.length).toBeLessThan(40_000)
    expect(text).toContain("more characters")
  })
})

describe("notices", () => {
  test("auto retry is an info notice, a lost retry an error notice", () => {
    const events = run([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "HTTP 529" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" },
    ])
    expect(events[0]?.type).toBe("flow.notice")
    expect(events[0]?.data).toMatchObject({ sessionID: "s_1", level: "info" })
    expect(events[0]?.data?.message).toContain("attempt 1 of 3")
    expect(events[1]?.data).toEqual({ sessionID: "s_1", level: "error", message: "omp gave up retrying: overloaded" })
  })

  test("notice frames keep error, soften warning to info; extension errors are errors", () => {
    const events = run([
      { type: "notice", level: "error", message: "disk full" },
      { type: "notice", level: "warning", message: "careful" },
      { type: "extension_error", extensionPath: "/x", event: "tool_call", error: "boom" },
    ])
    expect(events.map((event) => event.data?.level)).toEqual(["error", "info", "error"])
    expect(events[2]?.data?.message).toBe("omp extension error (tool_call): boom")
  })

  test("unknown and presentation frames are ignored", () => {
    expect(run([{ type: "cache_warming_start" }, { type: "queue_update", steering: [], followUp: [] }, { type: "something_new_in_omp_19" }, { type: "extension_ui_request", method: "setStatus", id: "1" }])).toEqual([])
  })
})

describe("subagents", () => {
  test("lifecycle started creates a child session under the parent", () => {
    const events = run([{ type: "subagent_lifecycle", payload: { id: "OmpWorker", agent: "a05-backend", status: "started", index: 0 } }])
    expect(events[0]).toEqual({ type: "session.created", data: { sessionID: "s_1/OmpWorker", info: { parentID: "s_1" } } })
    expect(events[1]?.type).toBe("session.next.step.started")
    expect(events[1]?.data).toMatchObject({ sessionID: "s_1/OmpWorker", agent: "a05-backend" })
  })

  test("progress turns the current tool into child tool events, and ends it when the tool changes", () => {
    const map = mapper()
    const progress = (currentTool: string | undefined, toolCount: number) => ({
      type: "subagent_progress",
      payload: { index: 0, agent: "a05-backend", task: "t", progress: { id: "W", currentTool, currentToolArgs: "src/a.ts", currentToolArgsKey: "path", toolCount, recentTools: [] } },
    })
    const first = map.map(progress("read", 0))
    expect(first.map((event) => event.type)).toEqual(["session.created", "session.next.step.started", "session.next.tool.input.started", "session.next.tool.called"])
    expect(first[3]?.data).toMatchObject({ sessionID: "s_1/W", tool: "read", input: { path: "src/a.ts" } })
    expect(map.map(progress("read", 0))).toEqual([])
    const second = map.map(progress("edit", 1))
    expect(second.map((event) => event.type)).toEqual(["session.next.tool.success", "session.next.tool.input.started", "session.next.tool.called"])
  })

  test("a failed subagent fails its step and its open call", () => {
    const map = mapper()
    map.map({ type: "subagent_progress", payload: { index: 0, agent: "a", task: "t", progress: { id: "W", currentTool: "bash", toolCount: 0 } } })
    const events = map.map({ type: "subagent_lifecycle", payload: { id: "W", agent: "a", status: "failed", index: 0 } })
    expect(events.map((event) => event.type)).toEqual(["session.next.tool.failed", "session.next.step.failed"])
  })

  test("subagent_event frames are mapped by a child mapper under the child session", () => {
    const events = run([{ type: "subagent_event", payload: { id: "W", event: frames.textDelta("msg-1", 0, "hi") } }])
    expect(events.at(-1)).toEqual({ type: "session.next.text.delta", data: { sessionID: "s_1/W", textID: "e1-W-msg-1:0", delta: "hi" } })
  })
})

test("a full text, tool and usage turn in order", () => {
  const events = run([
    frames.agentStart(),
    frames.userMessage("msg-0", "do it"),
    frames.messageStart("msg-1"),
    frames.textDelta("msg-1", 0, "Let me look."),
    frames.update("msg-1", { type: "text_end", contentIndex: 0, content: "Let me look." }),
    frames.update("msg-1", { type: "toolcall_end", contentIndex: 1, toolCall: { id: "call_1", name: "read", arguments: { path: "a.ts" } } }),
    frames.messageEnd("msg-1", assistantMessage({ texts: ["Let me look."], tools: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse" })),
    frames.toolStart("call_1", "read", { path: "a.ts" }),
    frames.toolEnd("call_1", "read", "contents"),
    frames.messageStart("msg-2"),
    frames.textDelta("msg-2", 0, "Done."),
    frames.messageEnd("msg-2", assistantMessage({ texts: ["Done."] })),
  ])
  expect(events.map((event) => event.type)).toEqual([
    "session.next.step.started",
    "session.next.text.started",
    "session.next.text.delta",
    "session.next.text.ended",
    "session.next.tool.input.started",
    "session.next.step.ended",
    "session.next.tool.called",
    "session.next.tool.success",
    "session.next.step.started",
    "session.next.text.started",
    "session.next.text.delta",
    "session.next.text.ended",
    "session.next.step.ended",
  ])
  const started = events.filter((event) => event.type === "session.next.step.started").map((event) => event.data?.assistantMessageID)
  expect(started).toEqual(["e1-msg-1", "e1-msg-2"])
})
