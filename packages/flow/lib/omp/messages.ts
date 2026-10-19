import type { ToolCall, Transcript, Turn, WireStep } from "../../shared/engine"
import type { OmpFrame, OmpProcess } from "./rpc-types"

/**
 * What a session remembers about its own conversation, built from the frame
 * stream so the hot paths (`/final`, `/steps`, `/calls`) never ask omp.
 *
 * Omp has no "read the last turn" command: `get_messages_page` fails with
 * `session_busy` while streaming, and `agent_end` can drop leading messages
 * when oversized. The stream is therefore the primary record, and history is
 * only paged in for a session this host just resumed, when nothing has
 * streamed yet.
 */

const DEFAULT_LIMIT = 300
const HISTORY_PAGE = 256
const HISTORY_PAGES = 40
const PAGE_TIMEOUT_MS = 30_000

/** A `flow.notice` is one activity row: omp can send thousands of characters (tool lists, stack traces). */
export const NOTICE_LIMIT = 240

/* ------------------------------------------------------------ wire readers */

/** Frames are JSON from a child process: every read goes through one of these instead of a cast. */
export type Wire = Record<string, unknown>

export function asRecord(value: unknown): Wire | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Omp numbers messages per process (`msg-1`, `msg-2`, ...), so a resumed
 * session would reuse ids the engine already keyed usage on. The epoch is
 * random per spawn.
 */
export function messageKey(epoch: string, messageId: string): string {
  return `${epoch}-${messageId}`
}

/** The text the engine's error classification reads. The status is omitted when unknown, never guessed. */
export function providerError(message: string, status?: number): string {
  if (/^Provider request failed/i.test(message)) return message
  return status === undefined ? `Provider request failed: ${message}` : `Provider request failed with HTTP ${status}: ${message}`
}

/** Text blocks of a message `content` (string or block array), joined by newlines. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  return asArray(content)
    .map((block) => {
      const record = asRecord(block)
      return record?.type === "text" ? (asString(record.text) ?? "") : ""
    })
    .filter(Boolean)
    .join("\n")
}

/* ------------------------------------------------------------------- store */

export type StoredMessage = {
  id: string
  role: "user" | "assistant"
  /** Text blocks in content order. */
  texts: string[]
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }
  /** `provider/model` the message ran on. */
  model?: string
  stopReason?: string
  errorMessage?: string
  errorStatus?: number
  done: boolean
}

type StoredCall = ToolCall & { seq: number; result?: { text: string; isError: boolean } }

export interface MessageStore {
  /** Feed one non-response frame. `epoch` is the spawn the frame came from. */
  observe(frame: OmpFrame, epoch: string): void
  /**
   * Pages the persisted history of a resumed session in front of the live
   * messages. Only when nothing has streamed: a page walk fails with
   * `session_busy` mid-stream and mixing the two would double-count steps.
   * Returns false when history was not available yet (busy), true otherwise.
   */
  loadHistory(proc: OmpProcess): Promise<boolean>
  /** True once the persisted history was paged in: the store then holds the whole conversation, not only what streamed since this host adopted the session. */
  loaded(): boolean
  recordCall(id: string, name: string, input: unknown): void
  /** The final assistant message of the latest turn: its text, and the provider error when it ended in one. */
  transcript(): Transcript
  /** HTTP status of the newest assistant message that failed, for a `prompt_result` that carried none. */
  latestErrorStatus(): number | undefined
  steps(): WireStep[]
  /** Newest first. */
  calls(max?: number): ToolCall[]
  /** Oldest first, the last `max`; tool-only assistant messages carry no words and are skipped. */
  turns(max?: number): Turn[]
  /** First user message, for a session list title. */
  firstUserText(): string | undefined
}

export function createMessageStore(options: { limit?: number } = {}): MessageStore {
  const limit = options.limit ?? DEFAULT_LIMIT
  let messages: StoredMessage[] = []
  const calls = new Map<string, StoredCall>()
  let seq = 0
  let historyLoaded = false

  function trim() {
    if (messages.length > limit) messages = messages.slice(messages.length - limit)
    if (calls.size <= limit) return
    const keep = [...calls.values()].sort((a, b) => b.seq - a.seq).slice(0, limit)
    calls.clear()
    for (const call of keep) calls.set(call.id, call)
  }

  function recordCall(id: string, name: string, input: unknown) {
    const existing = calls.get(id)
    if (existing) {
      existing.name = name || existing.name
      if (input !== undefined) existing.input = input
      return
    }
    calls.set(id, { id, name, input: input ?? {}, seq: seq++ })
    trim()
  }

  function attachResult(id: string, content: unknown, isError: boolean) {
    const call = calls.get(id)
    if (call) call.result = { text: textOf(content), isError }
  }

  function absorbAssistant(target: StoredMessage, message: Wire) {
    const blocks = asArray(message.content).map(asRecord)
    target.texts = blocks.filter((block) => block?.type === "text").map((block) => asString(block?.text) ?? "")
    for (const block of blocks) {
      const id = asString(block?.id)
      if (block?.type === "toolCall" && id) recordCall(id, asString(block.name) ?? "", block.arguments)
    }
    const usage = asRecord(message.usage)
    if (usage) {
      target.usage = {
        input: asNumber(usage.input) ?? 0,
        output: asNumber(usage.output) ?? 0,
        cacheRead: asNumber(usage.cacheRead) ?? 0,
        cacheWrite: asNumber(usage.cacheWrite) ?? 0,
        cost: asNumber(asRecord(usage.cost)?.total),
      }
    }
    const provider = asString(message.provider)
    const model = asString(message.model)
    if (provider && model) target.model = `${provider}/${model}`
    target.stopReason = asString(message.stopReason) ?? target.stopReason
    target.errorMessage = asString(message.errorMessage) ?? target.errorMessage
    target.errorStatus = asNumber(message.errorStatus) ?? target.errorStatus
    target.done = true
  }

  function open(id: string): StoredMessage {
    const found = messages.findLast((message) => message.id === id)
    if (found) return found
    const created: StoredMessage = { id, role: "assistant", texts: [], done: false }
    messages.push(created)
    trim()
    return created
  }

  return {
    observe(frame, epoch) {
      const messageId = asString(frame.messageId)
      switch (frame.type) {
        case "message_start": {
          if (asRecord(frame.message)?.role === "assistant" && messageId) open(messageKey(epoch, messageId))
          return
        }
        case "message_update": {
          const event = asRecord(frame.assistantMessageEvent)
          if (!event || !messageId) return
          const delta = asString(event.delta)
          const index = asNumber(event.contentIndex)
          if (event.type === "text_delta" && delta !== undefined && index !== undefined) {
            const target = open(messageKey(epoch, messageId))
            target.texts[index] = (target.texts[index] ?? "") + delta
          }
          const call = asRecord(event.toolCall)
          const callId = asString(call?.id)
          if (event.type === "toolcall_end" && call && callId) recordCall(callId, asString(call.name) ?? "", call.arguments)
          return
        }
        case "message_end": {
          const message = asRecord(frame.message)
          if (!message) return
          if (message.role === "assistant" && messageId) {
            absorbAssistant(open(messageKey(epoch, messageId)), message)
            return
          }
          if (message.role === "user") {
            messages.push({ id: `${epoch}-user-${seq++}`, role: "user", texts: [textOf(message.content)], done: true })
            trim()
            return
          }
          const toolCallId = asString(message.toolCallId)
          if (message.role === "toolResult" && toolCallId) attachResult(toolCallId, message.content, message.isError === true)
          return
        }
        case "tool_execution_end": {
          const toolCallId = asString(frame.toolCallId)
          if (toolCallId) attachResult(toolCallId, asRecord(frame.result)?.content, frame.isError === true)
          return
        }
        case "host_tool_call": {
          const toolCallId = asString(frame.toolCallId)
          const toolName = asString(frame.toolName)
          if (toolCallId && toolName) recordCall(toolCallId, toolName, frame.arguments)
          return
        }
      }
    },

    async loadHistory(proc) {
      if (historyLoaded) return true
      if (messages.some((message) => message.role === "assistant")) return true
      const loaded: StoredMessage[] = []
      let cursor: string | undefined
      for (let page = 0; page < HISTORY_PAGES; page++) {
        let data: unknown
        try {
          data = await proc.command({ type: "get_messages_page", limit: HISTORY_PAGE, ...(cursor ? { cursor } : {}) }, { timeoutMs: PAGE_TIMEOUT_MS })
        } catch (error) {
          const code = asString(asRecord(asRecord(error)?.rpc)?.code)
          if (code === "session_busy" || code === "stale_cursor") return false
          throw error
        }
        const body = asRecord(data)
        for (const raw of asArray(body?.messages)) {
          const message = asRecord(raw)
          if (!message) continue
          const index = loaded.length
          if (message.role === "user") {
            loaded.push({ id: `h${index}-user`, role: "user", texts: [textOf(message.content)], done: true })
            continue
          }
          if (message.role === "assistant") {
            const entry: StoredMessage = { id: `h${index}-${asNumber(message.timestamp) ?? index}`, role: "assistant", texts: [], done: true }
            absorbAssistant(entry, message)
            loaded.push(entry)
            continue
          }
          const toolCallId = asString(message.toolCallId)
          if (message.role === "toolResult" && toolCallId) attachResult(toolCallId, message.content, message.isError === true)
        }
        cursor = asString(body?.nextCursor)
        if (!cursor) break
      }
      messages = [...loaded, ...messages]
      trim()
      historyLoaded = true
      return true
    },

    recordCall,

    transcript() {
      const lastUser = messages.findLastIndex((message) => message.role === "user")
      const last = messages.findLast((message, index) => message.role === "assistant" && index > lastUser)
      if (!last) return { text: "" }
      const text = last.texts.filter(Boolean).join("\n\n")
      if (last.stopReason !== "error") return { text }
      return { text, error: providerError(last.errorMessage ?? "unknown error", last.errorStatus) }
    },

    latestErrorStatus() {
      return messages.findLast((message) => message.role === "assistant" && message.errorStatus !== undefined)?.errorStatus
    },

    steps() {
      const steps: WireStep[] = []
      for (const message of messages) {
        if (message.role !== "assistant" || !message.done || !message.usage) continue
        steps.push({
          messageID: message.id,
          model: message.model ?? "unknown",
          tokens: { input: message.usage.input, output: message.usage.output, reasoning: 0, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
          ...(message.usage.cost === undefined ? {} : { reportedCost: message.usage.cost }),
        })
      }
      return steps
    },

    calls(max = 30) {
      return [...calls.values()]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, max)
        .map((call) => ({ id: call.id, name: call.name, input: call.input }))
    },

    turns(max = 50) {
      const turns: Turn[] = []
      for (const message of messages) {
        const text = message.texts.filter(Boolean).join("\n\n")
        if (text) turns.push({ role: message.role, text })
      }
      return turns.slice(Math.max(0, turns.length - max))
    },

    loaded() {
      return historyLoaded
    },

    firstUserText() {
      return messages.find((message) => message.role === "user" && message.texts.some(Boolean))?.texts.filter(Boolean).join(" ")
    },
  }
}
