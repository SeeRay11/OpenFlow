/**
 * of-regeltreue — Auflösung jeder FABRIK-Empfehlung des fabrik-gate (Defekt 2,
 * 23.10.2026). DIE Regel steht hier; Scorecard, Digest und Loop (I3) rufen sie.
 *
 * Anlass: Das Ledger kannte weder „befolgt" noch „abgewichen" noch eine
 * Begründung. Die Loop-Sonde meldete eine absolute Zahl (`I3-regeltreue:
 * 5/18`), 16 von 37 FABRIK-Empfehlungen der Woche blieben ohne fabrik_run —
 * ob begründet, war nicht festzustellen. Zudem zählten 19 task-Empfehlungen
 * mit, die nie jemand gesehen hat (injiziert:false bei allen task-Zeilen).
 *
 * Empfehlung = Ledger-Zeile user_prompt|task mit entscheidung=FABRIK. Ausgang
 * (Fenster REGELTREUE_FENSTER_MS ab der Empfehlung, Belege werden 1:1
 * verbraucht — ein Start deckt nicht zwei Empfehlungen):
 *   nicht_zugestellt            injiziert ≠ true — der Pflichtweg erreichte nie
 *                               einen Kontext; gezählt, aber NICHT in der Quote
 *   befolgt_fabrik              echter Fabrik-Start (of-fabrik-aufruf.ts) in
 *                               derselben Session, über task_ref=gate_id oder
 *                               aus der Kind-Session eines task-Aufrufs
 *   befolgt_subagent            Stufe 1 der Eskalationsleiter (GATE_BLOCK:
 *                               „STUFE 1 (Standard)"): subagent-Aufruf derselben
 *                               Session bzw. aus der Kind-Session
 *   abgewichen_begruendet       event=abweichung (of-gate.ts abweichung "<grund>")
 *                               derselben Session im Fenster
 *   abgewichen_ohne_begruendung Fenster abgelaufen, nichts davon
 *   offen                       Fenster läuft noch
 *
 * Quote = (befolgt_fabrik + befolgt_subagent + abgewichen_begruendet) /
 *         aufgelöste zugestellte Empfehlungen. Daneben `fabrikQuote` (nur
 * Stufe 2) — Stufe 1 ist laut Pflichtweg der Standard, die enge Zahl bleibt
 * als Vergleich sichtbar.
 */
import { echteStarts } from "./of-fabrik-aufruf.ts"

export const REGELTREUE_FENSTER_MS = 30 * 60_000
const TAG_MS = 24 * 3_600_000
export const FENSTER = [
  { name: "24 h", ms: TAG_MS },
  { name: "7 Tage", ms: 7 * TAG_MS },
  { name: "gesamt", ms: Number.POSITIVE_INFINITY },
] as const

export type Ausgang =
  | "nicht_zugestellt"
  | "befolgt_fabrik"
  | "befolgt_subagent"
  | "abgewichen_begruendet"
  | "abgewichen_ohne_begruendung"
  | "offen"

export interface Aufloesung {
  ts: string
  ms: number
  event: string
  session_id: string | null
  gate_id: string | null
  task: string
  status: Ausgang
  beleg_ts?: string
  grund?: string
}

const tsMs = (e: any): number | null => {
  const t = typeof e?.ts === "number" ? e.ts : Date.parse(String(e?.ts ?? ""))
  return Number.isFinite(t) ? t : null
}

export function istEmpfehlung(e: any): boolean {
  return (e?.event === "user_prompt" || e?.event === "task") && e?.entscheidung === "FABRIK"
}

export function loeseAuf(entries: any[], now: number, fensterMs = REGELTREUE_FENSTER_MS): Aufloesung[] {
  const gueltig = entries.filter((e) => e && tsMs(e) !== null)
  const kind = new Map<string, string>()
  for (const e of gueltig)
    if (e.event === "task_kind" && typeof e.gate_id === "string" && typeof e.kind_session === "string") kind.set(e.gate_id, e.kind_session)

  const nachZeit = (xs: any[]) => [...xs].sort((a, b) => (tsMs(a) as number) - (tsMs(b) as number))
  const starts = nachZeit(echteStarts(gueltig))
  const subagent = nachZeit(gueltig.filter((e) => e.event === "task" && e.quelle === "subagent"))
  const abweichungen = nachZeit(gueltig.filter((e) => e.event === "abweichung"))
  const verbraucht = new Set<any>()

  const ergebnis: Aufloesung[] = []
  for (const r of nachZeit(gueltig.filter(istEmpfehlung))) {
    const t = tsMs(r) as number
    const basis: Aufloesung = {
      ts: String(r.ts), ms: t, event: r.event,
      session_id: typeof r.session_id === "string" ? r.session_id : null,
      gate_id: typeof r.gate_id === "string" ? r.gate_id : null,
      task: String(r.task ?? "").slice(0, 80),
      status: "offen",
    }
    if (r.injiziert !== true) {
      ergebnis.push({ ...basis, status: "nicht_zugestellt" })
      continue
    }
    const sessions = new Set<string>()
    if (basis.session_id) sessions.add(basis.session_id)
    const kindSession = basis.gate_id ? kind.get(basis.gate_id) : undefined
    if (kindSession) sessions.add(kindSession)
    const imFenster = (e: any) => {
      const s = tsMs(e) as number
      return s > t && s - t <= fensterMs // strikt danach (O6-Edge: gleicher ts zählt nicht)
    }
    const finde = (xs: any[], passt: (e: any) => boolean) => xs.find((e) => e !== r && !verbraucht.has(e) && imFenster(e) && passt(e))

    const start = finde(starts, (e) => sessions.has(e.session_id) || (basis.gate_id !== null && e.task_ref === basis.gate_id))
    // Stufe 1: bei einer task-Empfehlung zählt nur ein subagent-Aufruf AUS dem Kind
    // (der Aufruf selbst ist die Empfehlung), bei einer Nutzer-Empfehlung jeder der Session.
    const sub = start ? undefined : finde(subagent, (e) => (r.event === "task" ? e.session_id === kindSession : sessions.has(e.session_id)))
    const abw = start || sub ? undefined : finde(abweichungen, (e) => sessions.has(e.session_id))
    const beleg = start ?? sub ?? abw
    if (beleg) verbraucht.add(beleg)
    if (start) ergebnis.push({ ...basis, status: "befolgt_fabrik", beleg_ts: start.ts })
    else if (sub) ergebnis.push({ ...basis, status: "befolgt_subagent", beleg_ts: sub.ts })
    else if (abw) ergebnis.push({ ...basis, status: "abgewichen_begruendet", beleg_ts: abw.ts, grund: String(abw.grund ?? "") })
    else ergebnis.push({ ...basis, status: now - t < fensterMs ? "offen" : "abgewichen_ohne_begruendung" })
  }
  return ergebnis
}

export interface FensterQuote {
  name: string
  empfehlungen: number
  nicht_zugestellt: number
  offen: number
  aufgeloest: number
  befolgt_fabrik: number
  befolgt_subagent: number
  begruendet: number
  ohne_begruendung: number
  /** (befolgt + begründet) / aufgelöst in %, null ohne aufgelöste Empfehlung */
  quote: number | null
  /** nur Stufe 2 (Fabrik-Start) / aufgelöst in % */
  fabrikQuote: number | null
}

export function quoteFuer(name: string, a: Aufloesung[]): FensterQuote {
  const n = (s: Ausgang) => a.filter((x) => x.status === s).length
  const aufgeloest = a.length - n("nicht_zugestellt") - n("offen")
  const treu = n("befolgt_fabrik") + n("befolgt_subagent") + n("abgewichen_begruendet")
  const pct = (z: number) => (aufgeloest > 0 ? +((z / aufgeloest) * 100).toFixed(1) : null)
  return {
    name,
    empfehlungen: a.length,
    nicht_zugestellt: n("nicht_zugestellt"),
    offen: n("offen"),
    aufgeloest,
    befolgt_fabrik: n("befolgt_fabrik"),
    befolgt_subagent: n("befolgt_subagent"),
    begruendet: n("abgewichen_begruendet"),
    ohne_begruendung: n("abgewichen_ohne_begruendung"),
    quote: pct(treu),
    fabrikQuote: pct(n("befolgt_fabrik")),
  }
}

export function regeltreueJeFenster(a: Aufloesung[], now: number): FensterQuote[] {
  return FENSTER.map((f) => quoteFuer(f.name, a.filter((x) => x.ms <= now && now - x.ms <= f.ms)))
}

/** „1/2 (50 %)" bzw. „keine aufgelöste Empfehlung". */
export function quoteText(q: FensterQuote): string {
  if (q.quote === null) return "keine aufgelöste Empfehlung"
  const treu = q.befolgt_fabrik + q.befolgt_subagent + q.begruendet
  return `${treu}/${q.aufgeloest} (${q.quote} %)`
}
