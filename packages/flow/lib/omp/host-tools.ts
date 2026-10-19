import { asString } from "./messages"
import type { OmpFrame } from "./rpc-types"

/**
 * The orchestrator's control tools as omp RPC host tools.
 *
 * Same schemas and same tool-result wording as `mcp/dispatch.ts` (the parked
 * MCP channel), which is the part that matters: a model that is answered "ok"
 * keeps working, and what the engine reads afterwards is whatever it did
 * after. The call itself is recorded by the session's message store; the
 * engine reads the decision back from `sessionCalls`. Nothing here executes
 * anything.
 *
 * The names equal `DISPATCH_TOOL` / `FINISH_TOOL` in `src/graph/dispatch.ts`
 * (`host-tools.test.ts` asserts it); `lib/` does not import from `src/`.
 */

export const HOST_DISPATCH_TOOL = "openflow_dispatch"
export const HOST_FINISH_TOOL = "openflow_finish"

export type HostToolDefinition = {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  loadMode: "essential"
}

export const HOST_TOOLS: HostToolDefinition[] = [
  {
    name: HOST_DISPATCH_TOOL,
    label: "OpenFlow dispatch",
    description:
      "Hand work to the cards below you. Every card named runs at the same time, so only batch work that does not depend on itself. Call this once, then stop and end your turn — their answers arrive in your next message. Do not call any other tool in the same turn.",
    parameters: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          minItems: 1,
          description: "One entry per card you are dispatching. A card may appear only once.",
          items: {
            type: "object",
            properties: {
              card: { type: "string", description: "The card id, exactly as listed in your briefing." },
              task: {
                type: "string",
                description:
                  "What that card must do, in full. It has not seen the run task, the other cards' answers, or anything you dispatched before.",
              },
              files: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional: the files this card is expected to create or change. Cards in a batch run at once and nothing locks a file, so a batch in which two cards declare the same file is refused before either runs.",
              },
            },
            required: ["card", "task"],
          },
        },
      },
      required: ["assignments"],
    },
    loadMode: "essential",
  },
  {
    name: HOST_FINISH_TOOL,
    label: "OpenFlow finish",
    description:
      "Answer the run. Call this when you can write the result from what you have, then stop and end your turn. The text you pass is the whole result of the run.",
    parameters: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer to the run's task, written for the person who started it." },
      },
      required: ["answer"],
    },
    loadMode: "essential",
  },
]

const DISPATCHED = "Dispatched. Stop here and end your turn now — say nothing further and call no other tool. What the cards return will arrive in your next message."
const FINISHED = "Answer recorded. Stop here and end your turn now — say nothing further and call no other tool."

export interface HostTools {
  /** True when the frame was a `host_tool_call` (answered here); other frames are left alone. */
  handle(frame: OmpFrame): boolean
}

export type HostToolsOptions = {
  send(frame: Record<string, unknown>): void
}

export function createHostTools(options: HostToolsOptions): HostTools {
  return {
    handle(frame) {
      if (frame.type !== "host_tool_call") return false
      const id = asString(frame.id)
      if (!id) return true
      const name = asString(frame.toolName)
      const known = name === HOST_DISPATCH_TOOL || name === HOST_FINISH_TOOL
      const text = name === HOST_DISPATCH_TOOL ? DISPATCHED : name === HOST_FINISH_TOOL ? FINISHED : `Unknown tool: ${String(name)}`
      options.send({
        type: "host_tool_result",
        id,
        result: { content: [{ type: "text", text }] },
        ...(known ? {} : { isError: true }),
      })
      return true
    },
  }
}

/** The `set_host_tools` command for a card. */
export function hostToolsCommand(): { type: "set_host_tools"; tools: HostToolDefinition[] } {
  return { type: "set_host_tools", tools: HOST_TOOLS }
}
