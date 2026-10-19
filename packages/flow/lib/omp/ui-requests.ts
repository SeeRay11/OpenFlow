import type { BusEvent, PermissionReply, QuestionInfo } from "../../shared/engine"
import { HttpError } from "../host/respond"
import { asArray, asRecord, asString } from "./messages"
import type { OmpFrame } from "./rpc-types"

/**
 * `extension_ui_request` frames: the only way omp asks a person anything.
 *
 *  - A tool approval is a `select` whose `title` is the whole prompt
 *    (`Allow tool: <name>` then detail lines) and whose options are
 *    `["Approve", "Approve <subject> for this session"?, "Deny"]`
 *    (omp `tools/approval.ts`, `requestApproval`). Anything but an exact
 *    option label is a deny.
 *  - `ask` (after `set_ask_dialog`) carries every question of one tool call.
 *  - Every other dialog is cancelled at once, with a notice: a dialog nobody
 *    can see would hang the card until omp's own timeout.
 */

const APPROVAL_PREFIX = "Allow tool: "
const APPROVE = "Approve"
const DENY = "Deny"

type AskQuestion = { id: string; question: string; header?: string; options: Array<{ label: string; description?: string }>; multi: boolean }

type Pending = { kind: "permission"; sessionOption?: string } | { kind: "question"; questions: AskQuestion[] }

export type UiRequestsOptions = {
  sessionID: string
  /** Writes one frame to the omp process; a no-op when it is gone. */
  send(frame: Record<string, unknown>): void
  emit(event: BusEvent): void
}

export interface UiRequests {
  /** True when the frame was an `extension_ui_request` and has been dealt with. */
  handle(frame: OmpFrame): boolean
  /** Throws `HttpError(404)` for an id that is unknown or already settled. */
  replyPermission(id: string, reply: PermissionReply): void
  replyQuestion(id: string, answers: string[][]): void
  rejectQuestion(id: string): void
  /** Cancels every open dialog, e.g. when the session is interrupted or closed. */
  cancelAll(): void
  pending(): number
}

function notFound(id: string, what: string): HttpError {
  return new HttpError(404, `${what} request not found or already answered: ${id}`, "request-not-found")
}

function parseQuestions(value: unknown): AskQuestion[] {
  const questions: AskQuestion[] = []
  for (const raw of asArray(value)) {
    const question = asRecord(raw)
    const id = asString(question?.id)
    const text = asString(question?.question)
    if (!question || id === undefined || text === undefined) continue
    const options = asArray(question.options).flatMap((entry) => {
      const option = asRecord(entry)
      const label = asString(option?.label)
      return option && label !== undefined ? [{ label, description: asString(option.description) }] : []
    })
    questions.push({ id, question: text, header: asString(question.header), options, multi: question.multi === true })
  }
  return questions
}

export function createUiRequests(options: UiRequestsOptions): UiRequests {
  const sessionID = options.sessionID
  const pending = new Map<string, Pending>()

  function notice(level: "info" | "error", message: string) {
    options.emit({ type: "flow.notice", data: { sessionID, level, message } })
  }

  function take(id: string, kind: Pending["kind"], what: string): Pending {
    const entry = pending.get(id)
    if (!entry || entry.kind !== kind) throw notFound(id, what)
    pending.delete(id)
    return entry
  }

  function approval(id: string, title: string, choices: string[]) {
    const lines = title.slice(APPROVAL_PREFIX.length).split("\n")
    const action = (lines[0] ?? "").trim()
    const resources = lines.slice(1).filter((line) => line.trim().length > 0)
    pending.set(id, { kind: "permission", sessionOption: choices.find((choice) => choice !== APPROVE && choice !== DENY) })
    options.emit({ type: "permission.v2.asked", data: { id, sessionID, action, resources } })
  }

  function onSelect(frame: OmpFrame, id: string) {
    const title = asString(frame.title) ?? ""
    const choices = asArray(frame.options).filter((choice): choice is string => typeof choice === "string")
    if (title.startsWith(APPROVAL_PREFIX) && choices.includes(APPROVE) && choices.includes(DENY)) return approval(id, title, choices)
    refuse(id, title)
  }

  function refuse(id: string, title: string) {
    options.send({ type: "extension_ui_response", id, cancelled: true })
    notice("info", `omp asked "${title.split("\n")[0]?.slice(0, 120) ?? ""}" and OpenFlow cancelled it: cards run without an interactive answer for this dialog`)
  }

  function onAsk(frame: OmpFrame, id: string) {
    const questions = parseQuestions(frame.questions)
    if (!questions.length) {
      options.send({ type: "extension_ui_response", id, cancelled: true })
      return
    }
    pending.set(id, { kind: "question", questions })
    const info: QuestionInfo[] = questions.map((question) => ({
      question: question.question,
      header: question.header ?? "",
      options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
      multiple: question.multi,
      custom: true,
    }))
    options.emit({ type: "question.v2.asked", data: { id, sessionID, questions: info } })
  }

  return {
    handle(frame) {
      if (frame.type !== "extension_ui_request") return false
      const id = asString(frame.id)
      const method = asString(frame.method)
      if (!id || !method) return true
      switch (method) {
        case "select":
          onSelect(frame, id)
          break
        case "ask":
          onAsk(frame, id)
          break
        case "confirm":
        case "input":
        case "editor":
          refuse(id, asString(frame.title) ?? method)
          break
        case "cancel": {
          const target = asString(frame.targetId)
          if (target) pending.delete(target)
          break
        }
        case "notify": {
          const type = asString(frame.notifyType)
          const message = asString(frame.message)
          if (message && (type === "error" || type === "warning")) notice(type === "error" ? "error" : "info", type === "warning" ? `warning: ${message}` : message)
          break
        }
        // setStatus, setWidget, setTitle, set_editor_text, open_url: presentation only.
      }
      return true
    },

    replyPermission(id, reply) {
      const entry = take(id, "permission", "permission")
      const sessionOption = entry.kind === "permission" ? entry.sessionOption : undefined
      const value = reply === "reject" ? DENY : reply === "always" ? (sessionOption ?? APPROVE) : APPROVE
      options.send({ type: "extension_ui_response", id, value })
    },

    replyQuestion(id, answers) {
      const entry = pending.get(id)
      if (!entry || entry.kind !== "question") throw notFound(id, "question")
      if (answers.length !== entry.questions.length)
        throw new HttpError(400, `expected ${entry.questions.length} answers (one list per question), got ${answers.length}`, "bad-request")
      pending.delete(id)
      const response = entry.questions.map((question, index) => {
        const given = answers[index] ?? []
        const labels = new Set(question.options.map((option) => option.label))
        const matched = [...new Set(given.filter((answer) => labels.has(answer)))]
        const custom = given.filter((answer) => !labels.has(answer)).join(", ").trim()
        // A single-select takes an option or free text, never both: an option wins.
        if (!question.multi && matched.length) return { id: question.id, selectedOptions: matched.slice(0, 1) }
        return { id: question.id, selectedOptions: matched, ...(custom ? { customInput: custom } : {}) }
      })
      options.send({ type: "extension_ui_response", id, answers: response })
    },

    rejectQuestion(id) {
      take(id, "question", "question")
      options.send({ type: "extension_ui_response", id, cancelled: true })
    },

    cancelAll() {
      for (const id of pending.keys()) options.send({ type: "extension_ui_response", id, cancelled: true })
      pending.clear()
    },

    pending() {
      return pending.size
    },
  }
}
