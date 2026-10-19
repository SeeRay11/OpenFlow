import { describe, expect, test } from "bun:test"
import { DISPATCH_TOOL, FINISH_TOOL } from "../../src/graph/dispatch"
import { HOST_DISPATCH_TOOL, HOST_FINISH_TOOL, HOST_TOOLS, createHostTools, hostToolsCommand } from "./host-tools"

function setup() {
  const sent: Array<Record<string, unknown>> = []
  return { tools: createHostTools({ send: (frame) => sent.push(frame) }), sent }
}

describe("definitions", () => {
  test("names equal the ones the engine reads from the history", () => {
    expect(HOST_DISPATCH_TOOL).toBe(DISPATCH_TOOL)
    expect(HOST_FINISH_TOOL).toBe(FINISH_TOOL)
    expect(HOST_TOOLS.map((tool) => tool.name)).toEqual([DISPATCH_TOOL, FINISH_TOOL])
  })

  test("both are essential and carry the MCP server's schemas", () => {
    expect(HOST_TOOLS.every((tool) => tool.loadMode === "essential")).toBe(true)
    const [dispatch, finish] = HOST_TOOLS
    expect(dispatch?.parameters).toMatchObject({ required: ["assignments"], properties: { assignments: { minItems: 1, items: { required: ["card", "task"] } } } })
    expect(finish?.parameters).toMatchObject({ required: ["answer"] })
    expect(hostToolsCommand()).toEqual({ type: "set_host_tools", tools: HOST_TOOLS })
  })
})

describe("calls", () => {
  test("dispatch is answered at once with wording that ends the turn", () => {
    const { tools, sent } = setup()
    expect(tools.handle({ type: "host_tool_call", id: "h1", toolCallId: "t1", toolName: DISPATCH_TOOL, arguments: { assignments: [] } })).toBe(true)
    expect(sent).toHaveLength(1)
    const reply = sent[0] as { type: string; id: string; result: { content: Array<{ text: string }> }; isError?: boolean }
    expect(reply.type).toBe("host_tool_result")
    expect(reply.id).toBe("h1")
    expect(reply.isError).toBeUndefined()
    expect(reply.result.content[0]?.text).toContain("Stop here and end your turn now")
  })

  test("finish is answered the same way", () => {
    const { tools, sent } = setup()
    tools.handle({ type: "host_tool_call", id: "h2", toolCallId: "t2", toolName: FINISH_TOOL, arguments: { answer: "x" } })
    expect(JSON.stringify(sent[0])).toContain("Answer recorded. Stop here and end your turn now")
  })

  test("an unknown tool is an error result", () => {
    const { tools, sent } = setup()
    tools.handle({ type: "host_tool_call", id: "h3", toolCallId: "t3", toolName: "mystery", arguments: {} })
    expect(sent[0]).toEqual({ type: "host_tool_result", id: "h3", isError: true, result: { content: [{ type: "text", text: "Unknown tool: mystery" }] } })
  })

  test("other frames are left alone", () => {
    const { tools, sent } = setup()
    expect(tools.handle({ type: "agent_start" })).toBe(false)
    expect(tools.handle({ type: "host_tool_cancel", id: "c", targetId: "h1" })).toBe(false)
    expect(sent).toEqual([])
  })
})
