/**
 * of-rueckruf — der Reaper meldet sich bei der Sitzung, die den Run gestartet
 * hat (Plan „Autonomie 10/10", W2.4, 23.10.2026).
 *
 * Ohne diese Meldung endete der häufigste Fall still: ein abgeräumter Run
 * (41 von 201) hinterließ der aufrufenden opencode-Sitzung nichts — sie wartet
 * auf eine Fertig-Meldung, die nie kommt. Ebenso ein Run, der läuft und läuft.
 *
 * Weg: POST http://127.0.0.1:<port>/api/session/<sessionID>/synthetic mit
 * `{text, description:"openflow"}`, HTTP Basic `opencode:<passwort>` aus
 * ~/.config/opencode/service.json (Rechte 600). Das Passwort steht in keiner
 * Ausgabe, keiner Ledger-Zeile, keinem Fehlertext.
 *
 * Zuordnung (Red Team (c)): NUR über einen Ledger-Eintrag des Starts — Sitzung
 * und Kennung kommen aus DEMSELBEN Eintrag:
 *   1. host.aufruf_id des Runs → Eintrag (fabrik_log/fabrik_run) mit dieser
 *      aufruf_id; trägt der Run selbst eine Sitzung (host.session) und
 *      widerspricht sie dem Eintrag, wird NICHT gepostet.
 *   2. sonst host.pid → `fabrik_log` mit derselben pid, im Zeitfenster des
 *      Run-Starts (± ZEITFENSTER_MS; eine wiederverwendete PID von vorgestern
 *      ordnet nicht zu).
 *   Ohne Treffer: kein Post, eine Zeile `rueckruf_fehlgeschlagen` mit Grund.
 *
 * Genau einmal: eine Zeile `event:"rueckruf"` (run_id + art) ist der Marker.
 * Ein Fehlschlag wird höchstens MAX_VERSUCHE-mal versucht (der Wächter läuft
 * alle 5 min — ein toter Dienst soll das Ledger nicht fluten); „keine
 * Zuordnung" ist endgültig.
 *
 * Fail-open: jeder Fehler wird zur Ledger-Zeile, nichts wirft.
 *
 * Tests: Im Testlauf (NODE_ENV=test) ohne OPENFLOW_LEDGER ist der Rückruf aus
 * — so kann kein Test ins echte ~/.openflow/gate-ledger.jsonl schreiben
 * (passiert im Vorgänger-PR: zwei Zeilen L980/L981 aus einem Test).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type RueckrufArt = "abgeraeumt" | "stumm"
export interface Meldung {
  run: any
  art: RueckrufArt
  grund: string
  checkpoint: string
}
export interface RueckrufErgebnis {
  status: "gesendet" | "schon_gemeldet" | "keine_zuordnung" | "fehlgeschlagen" | "aufgegeben" | "aus"
  grund?: string
  session_id?: string
}
export interface Zuordnung {
  session_id: string
  aufruf_id: string | null
  quelle: "aufruf_id" | "pid"
}

export const STANDARD_PORT = 49374
export const MAX_VERSUCHE = 3
export const ZEITFENSTER_MS = 6 * 3_600_000
const TIMEOUT_MS = 5_000

type Env = Record<string, string | undefined>

/** Ledger-Pfad; `null` heißt: nicht schreiben, nicht lesen (Testlauf ohne Ziel). */
export function ledgerPfad(env: Env = process.env): string | null {
  if (env.OPENFLOW_LEDGER) return env.OPENFLOW_LEDGER
  if (env.NODE_ENV === "test") return null
  return join(homedir(), ".openflow", "gate-ledger.jsonl")
}

function servicePfad(env: Env): string | null {
  if (env.OPENFLOW_OPENCODE_SERVICE) return env.OPENFLOW_OPENCODE_SERVICE
  if (env.NODE_ENV === "test") return null
  return join(homedir(), ".config", "opencode", "service.json")
}

function leseLedger(pfad: string): any[] {
  if (!existsSync(pfad)) return []
  const out: any[] = []
  for (const l of readFileSync(pfad, "utf8").split("\n")) {
    if (!l) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* halbe Zeile */
    }
  }
  return out
}

function schreibe(pfad: string, zeile: Record<string, unknown>) {
  try {
    mkdirSync(dirname(pfad), { recursive: true })
    appendFileSync(pfad, JSON.stringify({ ts: new Date().toISOString(), ...zeile }) + "\n")
  } catch {
    /* Ledger ist best effort */
  }
}

/** Die Sitzung des Starts — aus genau einem Ledger-Eintrag, sonst `null`. */
export function zuordnung(eintraege: any[], run: any): Zuordnung | null {
  const host = run?.host ?? {}
  const eigeneSitzung = typeof host.session === "string" && host.session ? host.session : null
  if (typeof host.aufruf_id === "string" && host.aufruf_id) {
    const treffer = eintraege.filter(
      (e) => (e?.event === "fabrik_log" || e?.event === "fabrik_run") && e?.aufruf_id === host.aufruf_id && typeof e?.session_id === "string",
    )
    const e = treffer.find((t) => t.event === "fabrik_log") ?? treffer[0]
    if (e) {
      if (eigeneSitzung && eigeneSitzung !== e.session_id) return null
      return { session_id: e.session_id, aufruf_id: host.aufruf_id, quelle: "aufruf_id" }
    }
  }
  if (typeof host.pid === "number") {
    const start = typeof run?.started === "number" ? run.started : null
    const treffer = eintraege.filter((e) => {
      if (e?.event !== "fabrik_log" || e?.pid !== host.pid || typeof e?.session_id !== "string") return false
      if (start === null) return false
      const ts = Date.parse(e.ts)
      return Number.isFinite(ts) && Math.abs(ts - start) <= ZEITFENSTER_MS
    })
    const e = treffer[treffer.length - 1]
    if (e) {
      if (eigeneSitzung && eigeneSitzung !== e.session_id) return null
      return { session_id: e.session_id, aufruf_id: typeof e.aufruf_id === "string" ? e.aufruf_id : null, quelle: "pid" }
    }
  }
  return null
}

/** Pfad der ergebnis.md neben dem Checkpoint (dieselbe Regel wie of-ergebnis). */
const ergebnisNeben = (checkpoint: string) => checkpoint.replace(/\.json$/, ".ergebnis.md")

export function rueckrufText(m: Meldung): string {
  const id = String(m.run?.id ?? "?")
  const pipeline = m.run?.pipeline ? ` (${m.run.pipeline})` : ""
  const erg = ergebnisNeben(m.checkpoint)
  const zeilen =
    m.art === "abgeraeumt"
      ? [`[OpenFlow] Fabrik-Run ${id}${pipeline} wurde abgeräumt — ${m.grund}.`]
      : [`[OpenFlow] Fabrik-Run ${id}${pipeline} läuft ohne Ende — ${m.grund}.`]
  zeilen.push(`checkpoint: ${m.checkpoint}`)
  if (existsSync(erg)) zeilen.push(`ergebnis: ${erg}`)
  zeilen.push(
    m.art === "abgeraeumt"
      ? `Fortsetzen: of-run.sh --resume ${id} (fertige Karten bleiben). Stand: of-run.sh --scorecard`
      : `Stand: of-run.sh --scorecard · abbrechen: kill <pid>, danach meldet der Reaper das Ende`,
  )
  return zeilen.join("\n")
}

/**
 * Meldet `m` der Start-Sitzung — höchstens einmal, nie an eine fremde
 * Sitzung, nie mit Wurf. `opts.env` ersetzt process.env (Tests).
 */
export async function rueckruf(m: Meldung, opts: { env?: Env; fetch?: typeof fetch } = {}): Promise<RueckrufErgebnis> {
  const env = opts.env ?? process.env
  const ledger = ledgerPfad(env)
  if (!ledger) return { status: "aus", grund: "kein Ledger (Testlauf ohne OPENFLOW_LEDGER)" }
  const runId = String(m.run?.id ?? "")
  try {
    const eintraege = leseLedger(ledger)
    const eigen = (e: any) => e?.run_id === runId && e?.art === m.art
    if (eintraege.some((e) => e?.event === "rueckruf" && eigen(e))) return { status: "schon_gemeldet" }
    const fehl = eintraege.filter((e) => e?.event === "rueckruf_fehlgeschlagen" && eigen(e))
    if (fehl.some((e) => e?.endgueltig)) return { status: "schon_gemeldet" }
    if (fehl.length >= MAX_VERSUCHE) return { status: "aufgegeben", grund: `${fehl.length} Fehlschläge` }

    const z = zuordnung(eintraege, m.run)
    if (!z) {
      const grund = "keine Zuordnung (kein Ledger-Eintrag mit aufruf_id/pid dieses Runs)"
      schreibe(ledger, { event: "rueckruf_fehlgeschlagen", run_id: runId, art: m.art, grund, endgueltig: true })
      return { status: "keine_zuordnung", grund }
    }
    const fehlschlag = (grund: string): RueckrufErgebnis => {
      schreibe(ledger, { event: "rueckruf_fehlgeschlagen", run_id: runId, art: m.art, session_id: z.session_id, aufruf_id: z.aufruf_id, grund, versuch: fehl.length + 1 })
      return { status: "fehlgeschlagen", grund, session_id: z.session_id }
    }

    const sp = servicePfad(env)
    if (!sp || !existsSync(sp)) return fehlschlag(`service.json fehlt (${sp ?? "kein Pfad"})`)
    let dienst: any
    try {
      dienst = JSON.parse(readFileSync(sp, "utf8"))
    } catch {
      return fehlschlag("service.json unlesbar")
    }
    const passwort = typeof dienst?.password === "string" ? dienst.password : ""
    if (!passwort) return fehlschlag("service.json ohne Passwort")
    const port = Number(env.OPENFLOW_OPENCODE_PORT || dienst?.port || STANDARD_PORT)

    const url = `http://127.0.0.1:${port}/api/session/${encodeURIComponent(z.session_id)}/synthetic`
    let antwort: Response
    try {
      antwort = await (opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { authorization: `Basic ${btoa(`opencode:${passwort}`)}`, "content-type": "application/json" },
        body: JSON.stringify({ text: rueckrufText(m), description: "openflow" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      // Nur Name + Meldung; die URL trägt kein Geheimnis, der Header schon —
      // er erscheint in keiner Fehlermeldung von fetch.
      const e = error as Error
      return fehlschlag(`Dienst nicht erreichbar (127.0.0.1:${port}): ${e?.name ?? "Error"}: ${String(e?.message ?? e).replaceAll(passwort, "***")}`)
    }
    if (!antwort.ok) return fehlschlag(`HTTP ${antwort.status} von 127.0.0.1:${port}`)
    schreibe(ledger, { event: "rueckruf", run_id: runId, art: m.art, session_id: z.session_id, aufruf_id: z.aufruf_id, zuordnung: z.quelle, http: antwort.status })
    return { status: "gesendet", session_id: z.session_id }
  } catch (error) {
    const grund = `Rückruf-Fehler: ${String((error as Error)?.message ?? error)}`
    schreibe(ledger, { event: "rueckruf_fehlgeschlagen", run_id: runId, art: m.art, grund })
    return { status: "fehlgeschlagen", grund }
  }
}
