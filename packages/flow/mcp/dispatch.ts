/**
 * The MCP server that lets an orchestrator card hand work out.
 *
 * Why this exists: an orchestrator used to say what it wanted by ending its
 * message with a fenced JSON block, and measured against real providers that
 * loses three ways. A model sends the JSON with no fence. A model emits the
 * block and then keeps calling tools, so the block is no longer in the message
 * OpenFlow reads. And a model that is good at instructions tries to *call*
 * `dispatch` as a tool, because that is what the schema in front of it looks
 * like. The last one is the tell: models want this to be a tool, so it is one.
 *
 * The tools record nothing. OpenFlow reads the call back out of the session's
 * own message history, which is the authoritative record the server persists —
 * the same reason usage is reconciled from history rather than from the event
 * bus. So this process is a schema and a nudge to stop talking, nothing more,
 * and it holds no state that could disagree with the run.
 *
 * Hand-rolled JSON-RPC over stdio rather than the MCP SDK: `packages/flow` may
 * add no dependency (`bun.lock` gains only the workspace entry), and the three
 * methods a tools-only server needs are short enough to own.
 */

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> }

const NAME = "openflow"
const VERSION = "1.0.0"
/** Spoken when the client asks for something we do not recognise. */
const FALLBACK_PROTOCOL = "2025-06-18"

const TOOLS = [
  {
    name: "dispatch",
    description:
      "Hand work to the cards below you. Every card named runs at the same time, so only batch work that does not depend on itself. Call this once, then stop and end your turn — their answers arrive in your next message. Do not call any other tool in the same turn.",
    inputSchema: {
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
  },
  {
    name: "finish",
    description:
      "Answer the run. Call this when you can write the result from what you have, then stop and end your turn. The text you pass is the whole result of the run.",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer to the run's task, written for the person who started it." },
      },
      required: ["answer"],
    },
  },
]

/**
 * What a tool call answers with.
 *
 * The point of the wording is to end the turn. A model that gets "ok" back
 * keeps working, and the next thing OpenFlow reads is whatever it did after —
 * which is exactly the failure the fenced block had.
 */
function result(text: string) {
  return { content: [{ type: "text", text }] }
}

function handle(request: Request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion:
          typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      }
    case "tools/list":
      return { tools: TOOLS }
    case "tools/call": {
      const tool = request.params?.name
      if (tool === "dispatch")
        return result("Dispatched. Stop here and end your turn now — say nothing further and call no other tool. What the cards return will arrive in your next message.")
      if (tool === "finish")
        return result("Answer recorded. Stop here and end your turn now — say nothing further and call no other tool.")
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${String(tool)}` }] }
    }
    case "ping":
      return {}
    default:
      return undefined
  }
}

/**
 * Line-delimited JSON in, line-delimited JSON out.
 *
 * A method we do not know gets a `-32601` rather than silence: a client left
 * waiting on a response that never comes hangs the session that owns it, which
 * would surface as a card that runs until its timeout.
 */
async function main() {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (!line) continue

      let request: Request
      try {
        request = JSON.parse(line) as Request
      } catch {
        Bun.write(Bun.stdout, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n")
        continue
      }
      // A notification carries no id and takes no reply — `notifications/initialized`
      // is the one every client sends, and answering it is a protocol error.
      if (request.id === undefined) continue

      const payload = handle(request)
      const response =
        payload === undefined
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method: ${request.method}` } }
          : { jsonrpc: "2.0", id: request.id, result: payload }
      Bun.write(Bun.stdout, JSON.stringify(response) + "\n")
    }
  }
}

await main()
