import type { BusEvent } from "../../shared/engine"
import { capText, stripControl } from "../substrate/guard"
import { asArray, asNumber, asRecord, asString, messageKey, NOTICE_LIMIT, providerError, textOf, type Wire } from "./messages"
import type { OmpFrame } from "./rpc-types"

/**
 * Omp frames -> the `BusEvent` names `src/server/engine.ts` and
 * `src/server/activity.ts` already read (documented on `BusEvent` in
 * `shared/engine.ts`). One mapper per session; it holds only the little state
 * that conversion needs (which parts started, which calls were announced).
 *
 * Connections are `messageUpdates: "delta"`, so a `message_update` carries no
 * `partial`: a tool call's name and id are only known at `toolcall_end`.
 *
 * `agent_start` / `turn_start` map to nothing: a `step.started` needs the
 * assistant message id, which only `message_start` carries, and the activity
 * view would otherwise show a step row named `undefined`.
 */

/** One tool result piece, cut so a `read` of a large file cannot fill the SSE queue. */
const TOOL_TEXT_LIMIT = 32 * 1024

export interface EventMapper {
  map(frame: OmpFrame): BusEvent[]
}

export type EventMapperOptions = {
  sessionID: string
  /** Random per spawn: see `messageKey`. */
  epoch: string
  /** The card key; the activity view labels the step with it. */
  agent: string
  /** `provider/id` the card was asked to run on, until a message says otherwise. */
  model?: string
}

type Child = { sessionID: string; mapper: EventMapper; lastCall?: string }

function modelRef(provider: string | undefined, id: string | undefined, fallback: string | undefined) {
  if (provider && id) return { providerID: provider, id }
  if (!fallback) return undefined
  const slash = fallback.indexOf("/")
  return slash < 0 ? { providerID: "", id: fallback } : { providerID: fallback.slice(0, slash), id: fallback.slice(slash + 1) }
}

function clip(text: string): string {
  return text.length > TOOL_TEXT_LIMIT ? `${text.slice(0, TOOL_TEXT_LIMIT)}\n… ${text.length - TOOL_TEXT_LIMIT} more characters` : text
}

/** The text pieces of a tool result (`{ content: [{ type: "text", text }] }`, or a bare string). Images and files are named, not inlined. */
function contentOf(result: unknown): Array<{ type: "text"; text: string }> {
  if (typeof result === "string") return result ? [{ type: "text", text: clip(result) }] : []
  const blocks = asArray(asRecord(result)?.content)
  const parts: Array<{ type: "text"; text: string }> = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block?.type === "text" && asString(block.text)) parts.push({ type: "text", text: clip(block.text as string) })
    if (block?.type === "image") parts.push({ type: "text", text: "[image]" })
  }
  return parts
}

const MOUNT_NOTICE = /^xd:\/\/: mounted\b/

/** Text from the child that reaches the browser: control characters stripped, length capped. */
function clean(text: string): string {
  return capText(stripControl(text), NOTICE_LIMIT).text
}

export function createEventMapper(options: EventMapperOptions): EventMapper {
  const sessionID = options.sessionID
  const textStarted = new Set<string>()
  const textEnded = new Set<string>()
  const reasoningEnded = new Set<string>()
  const announced = new Set<string>()
  const called = new Set<string>()
  const children = new Map<string, Child>()

  function ended(sessionID: string, kind: "text" | "reasoning", id: string, text: string): BusEvent {
    return { type: `session.next.${kind}.ended`, data: { sessionID, [kind === "text" ? "textID" : "reasoningID"]: id, text } }
  }

  function announce(callID: string, name: string, out: BusEvent[]) {
    if (announced.has(callID)) return
    announced.add(callID)
    out.push({ type: "session.next.tool.input.started", data: { sessionID, callID, name } })
  }

  function onMessageUpdate(frame: OmpFrame, out: BusEvent[]) {
    const event = asRecord(frame.assistantMessageEvent)
    const messageId = asString(frame.messageId)
    if (!event || !messageId) return
    const key = messageKey(options.epoch, messageId)
    const index = asNumber(event.contentIndex)
    const partID = `${key}:${index}`
    switch (event.type) {
      case "text_delta": {
        const delta = asString(event.delta)
        if (delta === undefined || index === undefined) return
        if (!textStarted.has(partID)) {
          textStarted.add(partID)
          out.push({ type: "session.next.text.started", data: { sessionID, textID: partID } })
        }
        out.push({ type: "session.next.text.delta", data: { sessionID, textID: partID, delta } })
        return
      }
      case "thinking_delta": {
        const delta = asString(event.delta)
        if (delta === undefined || index === undefined) return
        out.push({ type: "session.next.reasoning.delta", data: { sessionID, reasoningID: partID, delta } })
        return
      }
      case "text_end": {
        if (index === undefined || textEnded.has(partID)) return
        if (!textStarted.has(partID)) out.push({ type: "session.next.text.started", data: { sessionID, textID: partID } })
        textStarted.add(partID)
        textEnded.add(partID)
        out.push(ended(sessionID, "text", partID, asString(event.content) ?? ""))
        return
      }
      case "thinking_end": {
        if (index === undefined || reasoningEnded.has(partID)) return
        reasoningEnded.add(partID)
        out.push(ended(sessionID, "reasoning", partID, asString(event.content) ?? ""))
        return
      }
      case "toolcall_end": {
        const call = asRecord(event.toolCall)
        const id = asString(call?.id)
        if (id) announce(id, asString(call?.name) ?? "tool", out)
        return
      }
    }
  }

  function onAssistantEnd(frame: OmpFrame, message: Wire, out: BusEvent[]) {
    const messageId = asString(frame.messageId)
    if (!messageId) return
    const key = messageKey(options.epoch, messageId)
    asArray(message.content).forEach((raw, index) => {
      const block = asRecord(raw)
      const partID = `${key}:${index}`
      if (block?.type === "text" && !textEnded.has(partID)) {
        if (!textStarted.has(partID)) out.push({ type: "session.next.text.started", data: { sessionID, textID: partID } })
        textStarted.add(partID)
        textEnded.add(partID)
        out.push(ended(sessionID, "text", partID, asString(block.text) ?? ""))
        return
      }
      if (block?.type === "thinking" && !reasoningEnded.has(partID)) {
        reasoningEnded.add(partID)
        out.push(ended(sessionID, "reasoning", partID, asString(block.thinking) ?? ""))
        return
      }
      if (block?.type !== "toolCall") return
      const id = asString(block.id)
      if (id) announce(id, asString(block.name) ?? "tool", out)
    })
    if (message.stopReason === "error")
      out.push({
        type: "session.next.step.failed",
        data: { sessionID, assistantMessageID: key, error: providerError(asString(message.errorMessage) ?? "unknown error", asNumber(message.errorStatus)) },
      })
    const usage = asRecord(message.usage)
    if (!usage) return
    out.push({
      type: "session.next.step.ended",
      data: {
        sessionID,
        assistantMessageID: key,
        // Omp folds reasoning tokens into `output`; reporting them again would bill them twice.
        tokens: {
          input: asNumber(usage.input) ?? 0,
          output: asNumber(usage.output) ?? 0,
          reasoning: 0,
          cache: { read: asNumber(usage.cacheRead) ?? 0, write: asNumber(usage.cacheWrite) ?? 0 },
        },
      },
    })
  }

  function child(id: string, agent: string, out: BusEvent[]): Child {
    const existing = children.get(id)
    if (existing) return existing
    const childID = `${sessionID}/${id}`
    const created: Child = { sessionID: childID, mapper: createEventMapper({ sessionID: childID, epoch: `${options.epoch}-${id}`, agent, model: options.model }) }
    children.set(id, created)
    out.push({ type: "session.created", data: { sessionID: childID, info: { parentID: sessionID } } })
    out.push({ type: "session.next.step.started", data: { sessionID: childID, assistantMessageID: `${childID}:run`, agent } })
    return created
  }

  function finishChildCall(entry: Child, failed: boolean, out: BusEvent[]) {
    if (!entry.lastCall) return
    out.push({
      type: failed ? "session.next.tool.failed" : "session.next.tool.success",
      data: { sessionID: entry.sessionID, callID: entry.lastCall, ...(failed ? { error: "tool failed" } : { content: [] }) },
    })
    entry.lastCall = undefined
  }

  function onSubagent(frame: OmpFrame, out: BusEvent[]) {
    const payload = asRecord(frame.payload)
    if (!payload) return
    if (frame.type === "subagent_lifecycle") {
      const id = asString(payload.id)
      if (!id) return
      const entry = child(id, asString(payload.agent) ?? "subagent", out)
      const status = asString(payload.status)
      if (status === "started") return
      finishChildCall(entry, status !== "completed", out)
      if (status === "failed" || status === "aborted")
        out.push({
          type: "session.next.step.failed",
          data: { sessionID: entry.sessionID, assistantMessageID: `${entry.sessionID}:run`, error: `subagent ${asString(payload.agent) ?? id} ${status}` },
        })
      return
    }
    if (frame.type === "subagent_event") {
      const id = asString(payload.id)
      const event = asRecord(payload.event)
      if (!id || !event || typeof event.type !== "string") return
      const entry = child(id, "subagent", out)
      out.push(...entry.mapper.map({ ...event, type: event.type }))
      return
    }
    const progress = asRecord(payload.progress)
    const id = asString(progress?.id)
    if (!progress || !id) return
    const entry = child(id, asString(payload.agent) ?? "subagent", out)
    const tool = asString(progress.currentTool)
    const callID = tool ? `${entry.sessionID}:${asNumber(progress.toolCount) ?? 0}:${tool}` : undefined
    if (entry.lastCall && entry.lastCall !== callID) {
      const recent = asRecord(asArray(progress.recentTools).at(-1))
      finishChildCall(entry, recent?.isError === true, out)
    }
    if (!tool || !callID || entry.lastCall === callID) return
    entry.lastCall = callID
    const args = asString(progress.currentToolArgs)
    out.push({ type: "session.next.tool.input.started", data: { sessionID: entry.sessionID, callID, name: tool } })
    out.push({ type: "session.next.tool.called", data: { sessionID: entry.sessionID, callID, tool, input: args === undefined ? {} : { [asString(progress.currentToolArgsKey) ?? "args"]: args } } })
  }

  return {
    map(frame) {
      const out: BusEvent[] = []
      switch (frame.type) {
        case "message_start": {
          const message = asRecord(frame.message)
          const messageId = asString(frame.messageId)
          if (message?.role !== "assistant" || !messageId) break
          out.push({
            type: "session.next.step.started",
            data: {
              sessionID,
              assistantMessageID: messageKey(options.epoch, messageId),
              model: modelRef(asString(message.provider), asString(message.model), options.model),
              agent: options.agent,
            },
          })
          break
        }
        case "message_update":
          onMessageUpdate(frame, out)
          break
        case "message_end": {
          const message = asRecord(frame.message)
          if (message?.role === "assistant") onAssistantEnd(frame, message, out)
          break
        }
        case "tool_execution_start": {
          const callID = asString(frame.toolCallId)
          const tool = asString(frame.toolName)
          if (!callID || !tool) break
          announce(callID, tool, out)
          if (called.has(callID)) break
          called.add(callID)
          out.push({ type: "session.next.tool.called", data: { sessionID, callID, tool, input: frame.args ?? {} } })
          break
        }
        case "tool_execution_update": {
          const callID = asString(frame.toolCallId)
          if (!callID) break
          const content = contentOf(frame.partialResult)
          if (content.length) out.push({ type: "session.next.tool.progress", data: { sessionID, callID, content } })
          break
        }
        case "tool_execution_end": {
          const callID = asString(frame.toolCallId)
          if (!callID) break
          const content = contentOf(frame.result)
          if (frame.isError === true) {
            out.push({ type: "session.next.tool.failed", data: { sessionID, callID, error: textOf(content) || "tool failed", result: frame.result } })
            break
          }
          out.push({ type: "session.next.tool.success", data: { sessionID, callID, content, ...(content.length ? {} : { result: frame.result }) } })
          break
        }
        case "auto_retry_start": {
          const delay = Math.round((asNumber(frame.delayMs) ?? 0) / 1000)
          const reason = clean(asString(frame.errorMessage) ?? "unknown error")
          out.push({
            type: "flow.notice",
            data: {
              sessionID,
              level: "info",
              message: `omp is retrying after a provider error (attempt ${asNumber(frame.attempt) ?? "?"} of ${asNumber(frame.maxAttempts) ?? "?"}, in ${delay}s): ${reason}`,
            },
          })
          break
        }
        case "auto_retry_end": {
          const finalError = asString(frame.finalError)
          if (frame.success === false && finalError) out.push({ type: "flow.notice", data: { sessionID, level: "error", message: `omp gave up retrying: ${clean(finalError)}` } })
          break
        }
        case "notice": {
          const message = asString(frame.message)
          const informational = frame.level !== "warning" && frame.level !== "error"
          // omp announces every xd:// device mount at session start: hundreds of internal tool names.
          if (message && !(informational && MOUNT_NOTICE.test(message))) {
            const text = clean(message)
            if (text) out.push({ type: "flow.notice", data: { sessionID, level: frame.level === "error" ? "error" : "info", message: text } })
          }
          break
        }
        case "extension_error": {
          const event = asString(frame.event)
          const detail = clean(asString(frame.error) ?? "unknown")
          out.push({ type: "flow.notice", data: { sessionID, level: "error", message: `omp extension error${event ? ` (${clean(event)})` : ""}: ${detail}` } })
          break
        }
        case "subagent_lifecycle":
        case "subagent_progress":
        case "subagent_event":
          onSubagent(frame, out)
          break
      }
      return out
    },
  }
}
