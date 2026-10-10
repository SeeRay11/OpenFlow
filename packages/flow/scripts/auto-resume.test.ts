/**
 * Tests für auto-resume.ts — reine Funktionen (Next-Move-Schnitt,
 * Budget-Entscheidung, Debounce-Logik) gegen Event-Fixtures
 * (step.ended/text.ended-Sequenzen), ohne echten Server.
 * Aufruf: bun test packages/flow/scripts/auto-resume.test.ts
 */
import { describe, expect, test } from "bun:test"
import { budgetDecision, debounceAction, eventData, extractNextMove } from "../plugins/auto-resume"

const MAX_STEPS_TEXT =
  "I have reached the maximum steps limit.\n\nSummary: Analysed the corpus and wrote the digest.\n\nNext I would grep the scorecard and re-run the failing check."

describe("extractNextMove", () => {
  test("(1) NEXT-MOVE-Marker → Schnitt ab Marker", () => {
    const r = extractNextMove(`Arbeit fertig bis Limit.\n\nNEXT MOVE: grep the scorecard and re-run checks`)
    expect(r).not.toBeNull()
    expect(r!.trigger).toBe("marker")
    expect(r!.nextMove).toBe("grep the scorecard and re-run checks")
  })

  test("(2) maximum steps ohne Marker → letzter Absatz", () => {
    const r = extractNextMove(MAX_STEPS_TEXT)
    expect(r).not.toBeNull()
    expect(r!.trigger).toBe("max-steps")
    expect(r!.nextMove).toBe("Next I would grep the scorecard and re-run the failing check.")
  })

  test("(3) normal beendete Karte (kein Muster, kein Marker) → null", () => {
    expect(extractNextMove("Alles erledigt, Tests grün, nichts offen.")).toBeNull()
  })

  test("(4) leerer Text → null", () => {
    expect(extractNextMove("")).toBeNull()
    expect(extractNextMove("   \n  ")).toBeNull()
  })
})

describe("budgetDecision", () => {
  test("(5) unter Budget → resume", () => {
    expect(budgetDecision(0, 3, false)).toBe("resume")
    expect(budgetDecision(2, 3, false)).toBe("resume")
  })

  test("(6) Budget erschöpft, noch nicht informiert → notify-once", () => {
    expect(budgetDecision(3, 3, false)).toBe("notify-once")
    expect(budgetDecision(5, 3, false)).toBe("notify-once")
  })

  test("(7) Budget erschöpft und schon informiert → silent", () => {
    expect(budgetDecision(3, 3, true)).toBe("silent")
  })
})

describe("debounceAction", () => {
  test("(8) step.ended: finish != tool-calls armiert, tool-calls nicht", () => {
    expect(debounceAction("session.next.step.ended", { finish: "stop" })).toBe("arm")
    expect(debounceAction("session.next.step.ended", { finish: "tool-calls" })).toBe("none")
  })

  test("(9) Aktivitäts-Events verwerfen den Timer", () => {
    for (const t of [
      "session.next.step.started",
      "session.next.tool.called",
      "session.next.tool.progress",
      "session.next.compaction.started",
      "session.next.compaction.ended",
      "session.next.retried",
    ]) {
      expect(debounceAction(t)).toBe("cancel")
    }
  })

  test("(10) session.status: idle feuert sofort, busy/retry verwerfen", () => {
    expect(debounceAction("session.status", { statusType: "idle" })).toBe("fire")
    expect(debounceAction("session.status", { statusType: "busy" })).toBe("cancel")
    expect(debounceAction("session.status", { statusType: "retry" })).toBe("cancel")
  })

  test("(11) irrelevante Events → none", () => {
    expect(debounceAction("session.next.text.delta")).toBe("none")
    expect(debounceAction("session.next.text.started")).toBe("none")
  })
})

describe("Event-Sequenz-Fixtures", () => {
  test("(12) arm → cancel → arm → fire Ablauf einer Task-Session", () => {
    const seq = [
      { type: "session.next.step.ended", finish: "stop" },
      { type: "session.next.step.started" },
      { type: "session.next.step.ended", finish: "tool-calls" },
      { type: "session.next.step.ended", finish: "stop" },
      { type: "session.status", statusType: "idle" },
    ]
    const actions = seq.map((e) => debounceAction(e.type, e))
    expect(actions).toEqual(["arm", "cancel", "none", "arm", "fire"])
  })

  test("(13) text.ended-Fixtures: properties- und data-Format liefern denselben Schnitt", () => {
    const payload = { sessionID: "ses_task_1", assistantMessageID: "msg_9", text: `${MAX_STEPS_TEXT}\n\nNEXT MOVE: re-run the scorecard probe` }
    const viaProps = eventData({ type: "session.next.text.ended", properties: payload })
    const viaData = eventData({ type: "session.next.text.ended", data: payload })
    expect(viaProps.text).toBe(viaData.text)
    const r = extractNextMove(String(viaProps.text))
    expect(r!.trigger).toBe("marker")
    expect(r!.nextMove).toBe("re-run the scorecard probe")
  })
})
