import { describe, expect, test } from "bun:test"
import type { BusEvent } from "../../shared/engine"
import { HttpError } from "../host/respond"
import { createUiRequests } from "./ui-requests"
import { frames } from "./testing/fake-process"

function setup() {
  const sent: Array<Record<string, unknown>> = []
  const events: BusEvent[] = []
  const ui = createUiRequests({ sessionID: "s_1", send: (frame) => sent.push(frame), emit: (event) => events.push(event) })
  return { ui, sent, events }
}

const PROMPT = "Allow tool: bash\nReason: runs a command\ncommand: rm -rf build"

describe("tool approvals", () => {
  test("a select that starts Allow tool: becomes permission.v2.asked with the details as resources", () => {
    const { ui, events, sent } = setup()
    expect(ui.handle(frames.approval("r1", PROMPT))).toBe(true)
    expect(events).toEqual([{ type: "permission.v2.asked", data: { id: "r1", sessionID: "s_1", action: "bash", resources: ["Reason: runs a command", "command: rm -rf build"] } }])
    expect(sent).toEqual([])
    expect(ui.pending()).toBe(1)
  })

  test("once answers Approve", () => {
    const { ui, sent } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    ui.replyPermission("r1", "once")
    expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }])
    expect(ui.pending()).toBe(0)
  })

  test("always answers the session option label when omp offered one", () => {
    const { ui, sent } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    ui.replyPermission("r1", "always")
    expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve bash for this session" }])
  })

  test("always falls back to Approve when the prompt offered no session option", () => {
    const { ui, sent } = setup()
    ui.handle(frames.approval("r1", PROMPT, ["Approve", "Deny"]))
    ui.replyPermission("r1", "always")
    expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }])
  })

  test("reject answers Deny", () => {
    const { ui, sent } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    ui.replyPermission("r1", "reject")
    expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Deny" }])
  })

  test("an unknown or already answered id is a 404 and sends nothing", () => {
    const { ui, sent } = setup()
    expect(() => ui.replyPermission("nope", "once")).toThrow(HttpError)
    ui.handle(frames.approval("r1", PROMPT))
    ui.replyPermission("r1", "once")
    try {
      ui.replyPermission("r1", "once")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as HttpError).status).toBe(404)
    }
    expect(sent).toHaveLength(1)
  })
})

describe("ask", () => {
  const ask = {
    type: "extension_ui_request",
    id: "q1",
    method: "ask",
    questions: [
      { id: "db", question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "SQL" }, { label: "SQLite" }] },
      { id: "features", question: "Which features?", multi: true, options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }] },
    ],
  }

  test("becomes question.v2.asked with QuestionInfo", () => {
    const { ui, events } = setup()
    ui.handle(ask)
    expect(events).toEqual([
      {
        type: "question.v2.asked",
        data: {
          id: "q1",
          sessionID: "s_1",
          questions: [
            { question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "SQL" }, { label: "SQLite", description: "" }], multiple: false, custom: true },
            { question: "Which features?", header: "", options: [{ label: "Auth", description: "" }, { label: "Billing", description: "" }, { label: "Search", description: "" }], multiple: true, custom: true },
          ],
        },
      },
    ])
  })

  test("answers match options by label; the rest is custom input", () => {
    const { ui, sent } = setup()
    ui.handle(ask)
    ui.replyQuestion("q1", [["SQLite"], ["Auth", "Search", "and tracing"]])
    expect(sent).toEqual([
      {
        type: "extension_ui_response",
        id: "q1",
        answers: [
          { id: "db", selectedOptions: ["SQLite"] },
          { id: "features", selectedOptions: ["Auth", "Search"], customInput: "and tracing" },
        ],
      },
    ])
  })

  test("a custom answer to a single-select carries only customInput", () => {
    const { ui, sent } = setup()
    ui.handle(ask)
    ui.replyQuestion("q1", [["DuckDB"], []])
    expect(sent[0]?.answers).toEqual([
      { id: "db", selectedOptions: [], customInput: "DuckDB" },
      { id: "features", selectedOptions: [] },
    ])
  })

  test("a single-select never sends an option and free text together", () => {
    const { ui, sent } = setup()
    ui.handle(ask)
    ui.replyQuestion("q1", [["Postgres", "also this"], []])
    expect((sent[0]?.answers as Array<Record<string, unknown>>)[0]).toEqual({ id: "db", selectedOptions: ["Postgres"] })
  })

  test("the wrong number of answers is a 400 and the question stays open", () => {
    const { ui, sent } = setup()
    ui.handle(ask)
    try {
      ui.replyQuestion("q1", [["Postgres"]])
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as HttpError).status).toBe(400)
    }
    expect(sent).toEqual([])
    expect(ui.pending()).toBe(1)
  })

  test("reject cancels the dialog; a second reject is a 404", () => {
    const { ui, sent } = setup()
    ui.handle(ask)
    ui.rejectQuestion("q1")
    expect(sent).toEqual([{ type: "extension_ui_response", id: "q1", cancelled: true }])
    expect(() => ui.rejectQuestion("q1")).toThrow(HttpError)
  })

  test("a permission id cannot answer a question", () => {
    const { ui } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    expect(() => ui.replyQuestion("r1", [])).toThrow(HttpError)
    expect(() => ui.rejectQuestion("r1")).toThrow(HttpError)
    expect(ui.pending()).toBe(1)
  })
})

describe("everything else", () => {
  test("a select that is not an approval is cancelled and noticed so nothing hangs", () => {
    const { ui, sent, events } = setup()
    ui.handle({ type: "extension_ui_request", id: "d1", method: "select", title: "Pick a branch", options: ["a", "b"] })
    expect(sent).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }])
    expect(events[0]?.type).toBe("flow.notice")
    expect(events[0]?.data?.message).toContain("Pick a branch")
    expect(ui.pending()).toBe(0)
  })

  test("confirm, input and editor are cancelled too", () => {
    const { ui, sent } = setup()
    for (const method of ["confirm", "input", "editor"]) ui.handle({ type: "extension_ui_request", id: method, method, title: "t" })
    expect(sent.map((frame) => frame.id)).toEqual(["confirm", "input", "editor"])
    expect(sent.every((frame) => frame.cancelled === true)).toBe(true)
  })

  test("fire-and-forget methods are consumed silently; error and warning notifies are noticed", () => {
    const { ui, sent, events } = setup()
    for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]) expect(ui.handle({ type: "extension_ui_request", id: "x", method })).toBe(true)
    ui.handle({ type: "extension_ui_request", id: "n1", method: "notify", message: "fine", notifyType: "info" })
    ui.handle({ type: "extension_ui_request", id: "n2", method: "notify", message: "bad", notifyType: "error" })
    ui.handle({ type: "extension_ui_request", id: "n3", method: "notify", message: "hmm", notifyType: "warning" })
    expect(sent).toEqual([])
    expect(events.map((event) => event.data)).toEqual([
      { sessionID: "s_1", level: "error", message: "bad" },
      { sessionID: "s_1", level: "info", message: "warning: hmm" },
    ])
  })

  test("a cancel request drops the dialog it targets", () => {
    const { ui } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    ui.handle({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "r1" })
    expect(ui.pending()).toBe(0)
    expect(() => ui.replyPermission("r1", "once")).toThrow(HttpError)
  })

  test("other frames are not consumed", () => {
    const { ui } = setup()
    expect(ui.handle({ type: "agent_start" })).toBe(false)
  })

  test("cancelAll cancels every open dialog on the wire", () => {
    const { ui, sent } = setup()
    ui.handle(frames.approval("r1", PROMPT))
    ui.handle({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "a", question: "?", options: [] }] })
    ui.cancelAll()
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "r1", cancelled: true },
      { type: "extension_ui_response", id: "q1", cancelled: true },
    ])
    expect(ui.pending()).toBe(0)
  })
})
