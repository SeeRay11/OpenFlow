/**
 * of-loop-logik — die reinen Regeln des Loops (eine Stelle, getestet),
 * getrennt vom Laufzeit-Skript of-loop.ts (das beim Import bereits einen
 * Zyklus startet und daher für Unit-Tests unbrauchbar ist).
 *
 * Enthalten:
 *   - computeI3     — Regeltreue-Messung, korrigiert (O6)
 *   - dedupAlerts   — Alert-Dedup: neu / stumm / Bestätigung nach 24 h (O1)
 *   - gapLueckeMin  — Stillstand-Schwelle für den Gap-Marker (O5)
 *   - letzterTick   — letzte Loop-Aktivität: Herzschlag vor State-Datei (O4/O5)
 */

export const I3_FENSTER_MS = 7 * 24 * 3_600_000
export const BESTAETIGUNG_MS = 24 * 3_600_000
export const GAP_SCHWELLE_MIN = 15

/**
 * computeI3 — Regeltreue-Messung (O6, korrigiert am 17.10.2026).
 *
 * Definition:
 *   Kandidaten     = Ledger-Einträge event=user_prompt UND entscheidung=FABRIK
 *                    im 7-Tage-Fenster (ts >= now - 7d). Das sind echte
 *                    Nutzer-Aufträge, denen ein Fabrik-Run empfohlen wurde.
 *   Fabrik-Aufrufe = fabrik_run OHNE monitoring:true im Fenster, die strikt
 *                    NACH einem Kandidaten liegen. Matching gierig: der
 *                    früheste noch freie Run nach dem Kandidaten; ein Run
 *                    matcht höchstens einen Kandidaten.
 *   Quote          = matches / kandidaten; Alert ab kandidaten >= 3 und
 *                    Quote < 50 %.
 *
 * Forensik 16.10.2026 (gate-ledger.jsonl + of-loop-state.jsonl:5452-5464):
 *   Alt falsch gemessen: 11 fabrik_run (davon 3 monitoring:true —
 *   --loop-check/ls/--scorecard, keine echten Runs) zu 24 Kandidaten
 *   event=task — 11/24 = 46 % < 50 % → 13x identischer Alert in 1 h
 *   (21:20-22:20Z). Beide Seiten des Bruchs waren verkehrt: event=task|FABRIK
 *   sind REGEL-4-Stufe-1-Fan-outs aus der Sitzung (87,5 % bewusst ohne
 *   Fabrik-Run), keine Empfehlungen an den Nutzer; die echten
 *   user_prompt|FABRIK-Aufträge (34 im Ledger, mehrere mündeten real in
 *   Runs) wurden nicht gezählt. Das GESAMTE Ledger ohne Fenster bestrafte
 *   zudem für lange zurückliegende, bereits erklärte Abweichungen.
 *
 * task|FABRIK-Einträge werden als fanouts mitgezählt und im Alert-Text als
 * Kontext gemeldet („+ N Stufe-1-Fan-out-Signale nicht gezählt"), fließen
 * aber NICHT in die Quote.
 */
export interface I3Ergebnis {
  kandidaten: number
  fabrikAufrufe: number
  matches: number
  fanouts: number
  bewertet: boolean
  alert: boolean
}

function tsMs(e: any): number | null {
  const t = typeof e?.ts === "number" ? e.ts : Date.parse(String(e?.ts ?? ""))
  return Number.isFinite(t) ? t : null
}

export function computeI3(entries: any[], now: number): I3Ergebnis {
  const fensterStart = now - I3_FENSTER_MS
  const imFenster = (t: number) => t >= fensterStart && t <= now

  // (a) Kandidaten: echte Nutzer-Aufträge mit FABRIK-Empfehlung im Fenster
  const kandidaten = entries
    .filter((e) => e?.event === "user_prompt" && e?.entscheidung === "FABRIK")
    .map((e) => tsMs(e))
    .filter((t): t is number => t !== null && imFenster(t))
    .sort((a, b) => a - b)

  // (b) Fabrik-Aufrufe: non-monitoring-Runs im Fenster (monitoring:true sind
  //     --loop-check/ls/--scorecard-Selbstbeobachtung, keine echten Runs)
  const runs = entries
    .filter((e) => e?.event === "fabrik_run" && e?.monitoring !== true)
    .map((e) => tsMs(e))
    .filter((t): t is number => t !== null && imFenster(t))
    .sort((a, b) => a - b)

  // Greedy-Matching: erster freier Run strikt NACH dem Kandidaten; ein Run
  // matcht max. einen Kandidaten (j++ verbraucht ihn)
  let matches = 0
  let j = 0
  for (const k of kandidaten) {
    while (j < runs.length && runs[j] <= k) j++
    if (j < runs.length) {
      matches++
      j++
    }
  }

  // Fan-out-Signale (REGEL-4-Stufe 1): Kontext, nicht Quote-Grundlage
  const fanouts = entries.filter((e) => {
    if (e?.event !== "task" || e?.entscheidung !== "FABRIK") return false
    const t = tsMs(e)
    return t !== null && imFenster(t)
  }).length

  const bewertet = kandidaten.length >= 3
  const alert = bewertet && matches / kandidaten.length < 0.5
  return { kandidaten: kandidaten.length, fabrikAufrufe: runs.length, matches, fanouts, bewertet, alert }
}

/**
 * dedupAlerts — aktive Alerts nur melden, wenn es Neues gibt (O1; Schlüssel
 * nur invariante, Zustandswechsel-Logik seit 17.10.2026).
 *
 *   - invariante nicht im Zustand (Zustandswechsel grün→rot: der Alert war
 *     weg und kommt zurück) → art "neu", erstes_ts startet neu, gemeldet.
 *   - im Zustand (bleibt ROT): Wert-Änderungen lösen KEINE Meldung aus —
 *     der I3-wert enthält Zähler (gemessen: 24→25-Wechsel innerhalb 90 min),
 *     sonst umging jede Zähleränderung die 24-h-Drossel. Der Wert wird im
 *     Zustand geführt, erstes_ts und letzte_bestaetigung bleiben.
 *   - innerhalb 24 h seit letzter Meldung → stumm (kein Tick-/State-Eintrag,
 *     keine Wiederholung wie bei den 13x in 1 h).
 *   - >= 24 h seit letzter Meldung → art "bestaetigt" („besteht seit"),
 *     wird einmal gemeldet, dann wieder stumm.
 *   - unparsebare oder zukünftige letzte_bestaetigung (NaN, Uhr-Rücklauf)
 *     gilt als „nie bestätigt" → art "neu", nicht Dauerstille.
 *   - Alert nicht mehr aktiv (rot→grün) → Eintrag fällt aus dem Zustand
 *     (kommt er später zurück, gilt er wieder als neu).
 *
 * Rein: gibt gemeldete KOPIEN zurück, mutiert die Eingaben nicht. Der
 * zurückgegebene Zustand ersetzt den bisherigen als Ganzes.
 */
export interface AlertLike {
  ts: string
  invariante: string
  wert: string
  schwelle: string
  erstes_ts?: string
  art?: "neu" | "bestaetigt"
}

export interface AlertDedupEintrag {
  wert: string
  erstes_ts: string
  letzte_bestaetigung: string
}

export function dedupAlerts(
  aktive: AlertLike[],
  zustandAlt: Record<string, AlertDedupEintrag>,
  now: number,
  bestaetigungAbstandMs: number = BESTAETIGUNG_MS,
): { melden: AlertLike[]; zustand: Record<string, AlertDedupEintrag> } {
  const melden: AlertLike[] = []
  const zustand: Record<string, AlertDedupEintrag> = {}
  for (const a of aktive) {
    const alt = zustandAlt[a.invariante]
    if (!alt) {
      // Zustandswechsel grün→rot: neu
      melden.push({ ...a, erstes_ts: a.ts, art: "neu" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: a.ts, letzte_bestaetigung: a.ts }
      continue
    }
    const letzte = Date.parse(alt.letzte_bestaetigung)
    // Unparsebar (NaN) oder in der Zukunft (Uhr-Rücklauf) = nie bestätigt:
    // art neu, nicht Dauerstille.
    if (!Number.isFinite(letzte) || letzte > now) {
      melden.push({ ...a, erstes_ts: alt.erstes_ts, art: "neu" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: new Date(now).toISOString() }
      continue
    }
    if (now - letzte >= bestaetigungAbstandMs) {
      melden.push({ ...a, erstes_ts: alt.erstes_ts, art: "bestaetigt" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: new Date(now).toISOString() }
    } else {
      // Stumm: Wert (Zähler) wird geführt, Beginn und Drossel bleiben.
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: alt.letzte_bestaetigung }
    }
  }
  return { melden, zustand }
}

/**
 * gapLueckeMin — Stillstand seit letzter Loop-Aktivität in ganzen Minuten,
 * oder null, solange die Lücke unter der Schwelle liegt (O5).
 */
export function gapLueckeMin(letzteTickMs: number, now: number): number | null {
  const min = Math.round((now - letzteTickMs) / 60_000)
  return min > GAP_SCHWELLE_MIN ? min : null
}

/**
 * letzterTick — letzte Loop-Aktivität lesen (O4/O5): Herzschlag-Datei
 * bevorzugt (seit O4 der einzige je-Tick-Niederschlag); Fallback letzte
 * ts aus der State-Datei für Altdaten (vor O4 enthielt sie jeden Tick).
 * Beide Pfade fehlen → null (Loop lief noch nie bzw. frische Installation).
 */
export function letzterTick(
  heartbeatPfad: string,
  statePfad: string,
  exists: (p: string) => boolean = () => true,
  read: (p: string) => string,
): { ms: number; quelle: "heartbeat" | "state" } | null {
  if (exists(heartbeatPfad)) {
    try {
      const hb = JSON.parse(String(read(heartbeatPfad))) // String(): Buffer-tolerant
      const t = Date.parse(String(hb?.ts ?? ""))
      if (Number.isFinite(t)) return { ms: t, quelle: "heartbeat" }
    } catch { /* kaputte Herzschlag-Datei: Fallback */ }
  }
  if (exists(statePfad)) {
    try {
      const zeilen = String(read(statePfad)).trim().split("\n").filter(Boolean)
      for (let i = zeilen.length - 1; i >= 0; i--) {
        try {
          const t = Date.parse(String(JSON.parse(zeilen[i])?.ts ?? ""))
          if (Number.isFinite(t)) return { ms: t, quelle: "state" }
        } catch { /* halbe Zeile: weiter rückwärts */ }
      }
    } catch { /* keine lesbare State-Datei */ }
  }
  return null
}
