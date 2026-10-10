import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"

/**
 * auto-resume — Task-Sessions (OpenFlow-Worker-Karten) automatisch fortsetzen,
 * wenn sie gegen das Step-Limit laufen und offene Next Moves hinterlassen.
 * Design: packages/flow/docs/AUTO_RESUME_DESIGN.md §2.2–2.5.
 *
 * Datenfluss: tool.execute.after (tool "task") registriert Background-/
 * Pipeline-Sessions (metadata.sessionId + parentSessionId). Event-Hook cached
 * je sessionID den letzten text.ended-Volltext (Dedup über assistantMessageID),
 * armiert nach step.ended (finish != "tool-calls") einen IDLE-Debounce und
 * verwirft ihn bei jeder Aktivität; session.status idle löst sofort aus.
 * Beim Feuern wird der Next-Move geschnitten — Auto-Resume NUR bei
 * "maximum steps"-Muster ODER NEXT-MOVE-Marker — und per
 * client.session.prompt("RESUME: …") in die Task-Session injiziert.
 * Budget max 3/Session (danach EIN Hinweis an die Parent-Session), 60 s
 * Mindestabstand, Ledger ~/.openflow/auto-resume.jsonl. Fail-open wie
 * fabrik-gate.ts: jeder Fehler wird geloggt und geschluckt.
 */

const envInt = (v: string | undefined, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const MAX = envInt(process.env.OPENFLOW_AUTO_RESUME_MAX, 3)
const IDLE_MS = envInt(process.env.OPENFLOW_AUTO_RESUME_IDLE_MS, 30_000)
const MIN_GAP_MS = 60_000
const LEDGER_PATH = process.env.OPENFLOW_AUTO_RESUME_LEDGER ?? `${homedir()}/.openflow/auto-resume.jsonl`
const PIPELINE_RE = /(refine-probe|auto-resume|orchestrator)/i
const NEXT_MOVE_MARKER = /NEXT MOVE\s*:/i
const MAX_STEPS_RE = /maximum steps/i

// --- reine Funktionen (für Tests exportiert) --------------------------------

/** Next-Move aus dem letzten Text-Part schneiden. Null = kein Eingriff. */
export function extractNextMove(text: string): { nextMove: string; trigger: "marker" | "max-steps" } | null {
  const trimmed = (text ?? "").trim()
  if (!trimmed) return null
  const m = trimmed.match(NEXT_MOVE_MARKER)
  if (m && m.index !== undefined) {
    const nextMove = trimmed.slice(m.index + m[0].length).trim()
    if (nextMove) return { nextMove, trigger: "marker" }
  }
  if (!MAX_STEPS_RE.test(trimmed)) return null
  const paras = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const last = paras[paras.length - 1] ?? ""
  return last ? { nextMove: last, trigger: "max-steps" } : null
}

/** Budget-Entscheidung: resume / einmaliger Parent-Hinweis / still. */
export function budgetDecision(resumes: number, max: number, notified: boolean): "resume" | "notify-once" | "silent" {
  if (resumes < max) return "resume"
  return notified ? "silent" : "notify-once"
}

/** Debounce-Entscheidung für ein Bus-Event. arm = Timer starten, cancel = verwerfen. */
export type DebounceAction = "arm" | "cancel" | "fire" | "none"
export function debounceAction(type: string, opts: { finish?: string; statusType?: string } = {}): DebounceAction {
  if (type === "session.next.step.ended") return opts.finish !== "tool-calls" ? "arm" : "none"
  if (
    type === "session.next.step.started" ||
    type === "session.next.tool.called" ||
    type === "session.next.tool.progress" ||
    type.startsWith("session.next.compaction.") ||
    type === "session.next.retried"
  ) {
    return "cancel"
  }
  if (type === "session.status") return opts.statusType === "idle" ? "fire" : "cancel"
  return "none"
}

/** Defensiver Event-Datenzugriff: Bus liefert properties ODER data je Format. */
export function eventData(ev: unknown): Record<string, any> {
  const e = ev as Record<string, any> | undefined
  return e?.properties ?? e?.data ?? {}
}

// --- Plugin-State (Modul-Globals = eine Instanz pro opencode-Prozess) -------

type TaskSession = {
  parentSessionID: string
  resumes: number
  lastText: string
  lastAssistantMessageID: string | null
  lastResumeAt: number
  budgetNotified: boolean
  timer: ReturnType<typeof setTimeout> | null
}
const taskSessions = new Map<string, TaskSession>()

function log(msg: string) {
  try {
    console.error(`[auto-resume] ${msg}`)
  } catch {}
}

function ledger(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true })
    appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
  } catch (e: any) {
    log(`ledger write failed: ${e?.message}`)
  }
}

export const AutoResumePlugin: Plugin = (ctx: any) => {
  const client = ctx?.client

  const fire = async (sid: string) => {
    const t = taskSessions.get(sid)
    if (!t) return
    t.timer = null
    try {
      const decision = budgetDecision(t.resumes, MAX, t.budgetNotified)
      if (decision === "silent") return
      if (decision === "notify-once") {
        t.budgetNotified = true
        const last = extractNextMove(t.lastText)?.nextMove ?? t.lastText.slice(-300)
        await client?.session?.prompt?.({
          sessionID: t.parentSessionID,
          parts: [{ type: "text", text: `[auto-resume] Budget (${MAX}) erschöpft für Task-Session ${sid} — kein weiterer automatischer Resume. Letzter Next Move:\n${last.slice(0, 400)}` }],
        })
        ledger({ event: "budget_exhausted", sessionID: sid, resumes: t.resumes, parent: t.parentSessionID })
        log(`budget erschöpft, parent informiert: ${sid}`)
        return
      }
      const extracted = extractNextMove(t.lastText)
      if (!extracted) return // normal beendete Karte — kein Eingriff
      if (Date.now() - t.lastResumeAt < MIN_GAP_MS) {
        log(`min-gap übersprungen: ${sid}`)
        return
      }
      t.resumes += 1
      t.lastResumeAt = Date.now()
      await client?.session?.prompt?.({ sessionID: sid, parts: [{ type: "text", text: `RESUME: ${extracted.nextMove}` }] })
      ledger({
        event: "resume",
        sessionID: sid,
        versuch: t.resumes,
        trigger: extracted.trigger,
        next_move: extracted.nextMove.slice(0, 120),
        parent: t.parentSessionID,
      })
      log(`resume #${t.resumes} für ${sid} (trigger=${extracted.trigger})`)
    } catch (e) {
      console.error("[auto-resume]", e)
    }
  }

  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (input?.tool !== "task") return
        const meta = output?.metadata ?? {}
        const sid = meta.sessionId
        if (typeof sid !== "string" || !sid) return
        const isBackground = meta.background === true || input?.args?.background === true
        const prompt = typeof input?.args?.prompt === "string" ? input.args.prompt : ""
        if (!isBackground && !PIPELINE_RE.test(prompt)) return
        if (!taskSessions.has(sid)) {
          const parent = typeof meta.parentSessionId === "string" ? meta.parentSessionId : input?.sessionID ?? ""
          taskSessions.set(sid, {
            parentSessionID: parent,
            resumes: 0,
            lastText: "",
            lastAssistantMessageID: null,
            lastResumeAt: 0,
            budgetNotified: false,
            timer: null,
          })
          log(`task-session registriert: ${sid} (parent=${parent || "?"})`)
        }
      } catch (e) {
        console.error("[auto-resume]", e)
      }
    },

    event: async (input: any) => {
      try {
        const ev = input?.event
        const type = ev?.type
        if (typeof type !== "string") return
        const data = eventData(ev)
        const sid = data?.sessionID ?? ev?.sessionID
        if (typeof sid !== "string" || !taskSessions.has(sid)) return
        const t = taskSessions.get(sid)!
        if (type === "session.next.text.ended") {
          const mid = data?.assistantMessageID
          if (typeof mid === "string" && mid !== t.lastAssistantMessageID) {
            t.lastAssistantMessageID = mid
            t.lastText = String(data?.text ?? "")
          }
          return
        }
        const action = debounceAction(type, { finish: data?.finish, statusType: data?.status?.type })
        if (action === "cancel") {
          if (t.timer) clearTimeout(t.timer)
          t.timer = null
        } else if (action === "arm") {
          if (!t.timer) t.timer = setTimeout(() => void fire(sid), IDLE_MS)
        } else if (action === "fire") {
          if (t.timer) clearTimeout(t.timer)
          t.timer = null
          void fire(sid)
        }
      } catch (e) {
        console.error("[auto-resume]", e)
      }
    },
  }
}

export default AutoResumePlugin
