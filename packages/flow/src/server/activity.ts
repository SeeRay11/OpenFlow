import type { NodeEvent } from "../graph/types"
import type { BusEvent } from "./client"

/**
 * How much of one body is kept while the app holds the run in memory. Long
 * enough to read a file the agent read; short enough that a runaway `bash`
 * cannot grow the page without bound.
 */
export const LIVE_BODY_LIMIT = 8_000
/** How much survives into the saved run log — a run file is not a transcript store. */
export const PERSIST_BODY_LIMIT = 2_000
/** Events kept per node, live. Oldest are dropped first. */
export const EVENT_LIMIT = 300
/** Events kept per node in the saved run log. */
export const PERSIST_EVENT_LIMIT = 200

/** The tool opencode spawns a subagent with. Its child session is nested under it. */
const SUBAGENT_TOOL = "task"

/**
 * Argument names worth putting in a tool row's one-line title, most specific
 * first. Everything else stays in the expandable input.
 */
const TITLE_KEYS = [
  "description",
  "subagent_type",
  "command",
  "pattern",
  "query",
  "filePath",
  "file_path",
  "path",
  "url",
  "prompt",
  "old_string",
]

export type ActivityOptions = {
  /** The node that owns a session, or undefined when it is not this run's. */
  owner: (sessionID: string) => string | undefined
  emit: (nodeID: string, event: NodeEvent) => void
  now?: () => number
}

/**
 * Turns the server's event stream into per-node activity rows.
 *
 * The bus speaks in deltas against ids; a reader wants rows. This holds the
 * small amount of state that conversion needs — which text part is still
 * streaming, what a call id was named, which child session belongs to which
 * node — and emits a whole row every time one changes.
 *
 * A subagent runs in its own session, so its events arrive under a session id
 * this run never created. `session.created` carries the parent, which is the
 * only link back: without it a spawned agent's work looks like it happened
 * nowhere.
 */
export function createActivity(options: ActivityOptions) {
  const now = options.now ?? (() => Date.now())
  /** Child sessions, by their own id. */
  const children = new Map<string, { node: string; depth: number; callID?: string }>()
  /** The most recent `task` call in a session — what a child session hangs off. */
  const spawning = new Map<string, string>()
  /** Streaming bodies, by their part id. */
  const streams = new Map<string, string>()
  /**
   * The row title for a call id. Only `tool.input.started` carries the name and
   * only `tool.called` carries the arguments, while the result events carry
   * neither — so the title is remembered rather than rebuilt, otherwise a call
   * would lose its arguments the moment it finished.
   */
  const names = new Map<string, string>()

  function place(sessionID: string) {
    const own = options.owner(sessionID)
    if (own) return { node: own, depth: 0, callID: undefined as string | undefined }
    return children.get(sessionID)
  }

  function emit(sessionID: string, event: Omit<NodeEvent, "depth" | "at" | "sessionID">) {
    const at = place(sessionID)
    if (!at) return
    options.emit(at.node, {
      ...event,
      body: event.body === undefined ? undefined : clip(event.body, LIVE_BODY_LIMIT),
      at: now(),
      depth: at.depth,
      sessionID,
      ...(at.callID ? { parentCallID: at.callID } : {}),
    })
  }

  return {
    /** A line the engine itself wants on the card's stream. */
    note(nodeID: string, id: string, title: string, body?: string, status?: NodeEvent["status"]) {
      options.emit(nodeID, {
        id: `note:${id}`,
        at: now(),
        kind: "note",
        depth: 0,
        title,
        status,
        ...(body === undefined ? {} : { body: clip(body, LIVE_BODY_LIMIT) }),
      })
    },

    consume(event: BusEvent) {
      const data = event.data ?? {}
      const sessionID = data.sessionID as string | undefined
      if (!sessionID) return

      switch (event.type) {
        case "session.created": {
          const parent = data.info?.parentID as string | undefined
          if (!parent) return
          const at = place(parent)
          if (!at) return
          children.set(sessionID, {
            node: at.node,
            depth: at.depth + 1,
            callID: spawning.get(parent) ?? at.callID,
          })
          return
        }

        case "session.next.step.started": {
          const model = data.model ? `${data.model.providerID}/${data.model.id}` : undefined
          const label = [data.agent, model].filter(Boolean).join(" · ")
          return emit(sessionID, {
            id: `step:${data.assistantMessageID}`,
            kind: "step",
            title: label || "step",
          })
        }

        case "session.next.text.delta":
        case "session.next.reasoning.delta": {
          const reasoning = event.type.endsWith("reasoning.delta")
          const partID = (reasoning ? data.reasoningID : data.textID) as string
          const body = (streams.get(partID) ?? "") + (data.delta ?? "")
          streams.set(partID, body)
          return emit(sessionID, {
            id: `${reasoning ? "reasoning" : "text"}:${partID}`,
            kind: reasoning ? "reasoning" : "text",
            title: reasoning ? "thinking" : "response",
            status: "running",
            body,
          })
        }

        case "session.next.text.ended":
        case "session.next.reasoning.ended": {
          const reasoning = event.type.endsWith("reasoning.ended")
          const partID = (reasoning ? data.reasoningID : data.textID) as string
          const body = (data.text as string | undefined) ?? streams.get(partID) ?? ""
          streams.delete(partID)
          return emit(sessionID, {
            id: `${reasoning ? "reasoning" : "text"}:${partID}`,
            kind: reasoning ? "reasoning" : "text",
            title: reasoning ? "thinking" : "response",
            status: "done",
            body,
          })
        }

        case "session.next.tool.input.started": {
          const name = data.name as string
          names.set(data.callID, name)
          if (name === SUBAGENT_TOOL) spawning.set(sessionID, data.callID)
          return emit(sessionID, {
            id: `tool:${data.callID}`,
            kind: "tool",
            title: name,
            status: "running",
          })
        }

        case "session.next.tool.called": {
          const name = (data.tool as string) ?? "tool"
          const title = describe(name, data.input)
          names.set(data.callID, title)
          if (name === SUBAGENT_TOOL) spawning.set(sessionID, data.callID)
          return emit(sessionID, {
            id: `tool:${data.callID}`,
            kind: "tool",
            title,
            status: "running",
            input: render(data.input),
          })
        }

        case "session.next.tool.progress": {
          const body = content(data.content)
          if (!body) return
          return emit(sessionID, {
            id: `tool:${data.callID}`,
            kind: "tool",
            title: names.get(data.callID) ?? "tool",
            status: "running",
            body,
          })
        }

        case "session.next.tool.success": {
          return emit(sessionID, {
            id: `tool:${data.callID}`,
            kind: "tool",
            title: names.get(data.callID) ?? "tool",
            status: "done",
            // `content` is the tool's own rendering of what it did; `structured`
            // and `result` are the machine forms behind it, and only stand in
            // when a tool returned nothing to read.
            body: content(data.content) || render(data.result) || record(data.structured) || "",
          })
        }

        case "session.next.tool.failed": {
          return emit(sessionID, {
            id: `tool:${data.callID}`,
            kind: "tool",
            title: names.get(data.callID) ?? "tool",
            status: "error",
            body: message(data.error) ?? render(data.result) ?? "failed",
          })
        }

        case "session.next.step.failed": {
          return emit(sessionID, {
            id: `step:${data.assistantMessageID}:failed`,
            kind: "note",
            title: "step failed",
            status: "error",
            body: message(data.error),
          })
        }

        default:
          return
      }
    },
  }
}

/**
 * Upserts an event into a node's list and holds the list to `EVENT_LIMIT`.
 *
 * Returned as a new array: both callers hand it straight to a reactive store,
 * and mutating in place would not be seen.
 */
export function applyEvent(events: NodeEvent[], event: NodeEvent, limit = EVENT_LIMIT): NodeEvent[] {
  const index = events.findIndex((entry) => entry.id === event.id)
  if (index >= 0) {
    const next = [...events]
    // Keep the row where it first appeared: a tool that finishes after the text
    // below it started did not happen last, and reordering it would say it did.
    next[index] = { ...next[index], ...event, at: next[index].at }
    return next
  }
  const next = [...events, event]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** The tail of a node's activity, small enough to sit in a saved run log. */
export function persistable(events: NodeEvent[]): NodeEvent[] {
  return events.slice(Math.max(0, events.length - PERSIST_EVENT_LIMIT)).map((event) => ({
    ...event,
    ...(event.input === undefined ? {} : { input: clip(event.input, PERSIST_BODY_LIMIT) }),
    ...(event.body === undefined ? {} : { body: clip(event.body, PERSIST_BODY_LIMIT) }),
  }))
}

/**
 * Cuts a body to `limit`, saying how much was cut.
 *
 * The head is kept rather than the tail: a tool result leads with what it
 * found, and a truncation that says nothing about itself reads like the whole
 * answer.
 */
export function clip(text: string, limit: number) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters`
}

/** `grep pattern="handler" path=src` — the row a reader scans. */
export function describe(tool: string, input: unknown) {
  if (!input || typeof input !== "object") return tool
  const record = input as Record<string, unknown>
  const parts: string[] = []
  for (const key of TITLE_KEYS) {
    const value = record[key]
    if (typeof value !== "string" || !value) continue
    parts.push(`${key}=${oneLine(value, 80)}`)
    if (parts.length === 2) break
  }
  if (!parts.length) {
    const first = Object.entries(record).find(([, value]) => typeof value === "string" && value)
    if (first) parts.push(`${first[0]}=${oneLine(String(first[1]), 80)}`)
  }
  return parts.length ? `${tool} ${parts.join(" ")}` : tool
}

function oneLine(value: string, limit: number) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Text out of an `LlmToolContent[]`; files are named rather than inlined. */
function content(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part: any) => (part?.type === "file" ? `[file ${part.name ?? part.uri ?? "?"}]` : (part?.text ?? "")))
    .filter(Boolean)
    .join("\n")
}

/** A tool's structured payload, when it returned no readable content at all. */
function record(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return undefined
  return render(value)
}

function render(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function message(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  const record = error as Record<string, any>
  if (typeof record.message === "string" && record.message) return record.message
  if (typeof record.data?.message === "string") return record.data.message
  return render(error)
}
