/**
 * of-scorecard — Verdict-Statistik über OpenFlow-Runs.
 *
 * Die 10/10-Zielvorgabe (Nutzerorder 18.09.2026) war für Fabrik-Output nie
 * operationalisiert: Es gab keinen messbaren Verdict pro Run. Diese Scorecard
 * rechnet Run-JSONs zu Zahlen aus — pro Run und als Aggregat:
 *
 *   verdict      PASS | PASS_RETRIED | FAIL | STOPPED
 *   nodes        total/done/error/stopped/skipped (+reused)
 *   durationSec  finished - started (falls vorhanden)
 *   outputWords  Wörter über alle done-Karten (Lieferumfang, nicht Wohlgefallen)
 *   attempts     Auto-Retry-Versuche des Runners (>= 2 = PASS_RETRIED)
 *   reaped       Zombie war, vom Reaper geborgen
 *
 * Dazu eine Ledger-Sektion (Regeltreue), sobald of-gate/fabrik-gate Daten
 * geschrieben haben: FABRIK-Kandidaten vs. echte of-run-Aufrufe.
 *
 * Usage:
 *   bun of-scorecard.ts [--runs-dir DIR] [--ledger FILE] [--limit 20] [--json]
 *   of-run.sh --scorecard [--limit 20] [--json]
 */

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = resolve(flag("--runs-dir", process.env.OF_RUNS_DIR ?? join(homedir(), "workspace/flow-lab/.openflow/runs")))
const LEDGER = flag("--ledger", process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl"))
const LIMIT = Number(flag("--limit", "20"))
const JSON_OUT = argv.includes("--json")

interface Row {
  id: string
  started: string
  pipeline: string
  status: string
  verdict: string
  nodes: string
  durationSec: number | null
  outputWords: number
  attempts: number
  reaped: boolean
  reapedReason: string | null
}

function scoreRun(log: any): Row {
  const nodes: any[] = Array.isArray(log?.nodes) ? log.nodes : []
  const count = (s: string) => nodes.filter((n) => n?.status === s).length
  const words = nodes
    .filter((n) => n?.status === "done" && typeof n.output === "string")
    .map((n) => n.output.split(/\s+/).filter(Boolean).length)
    .reduce((a: number, b: number) => a + b, 0)
  const attempts = log?.scorecard?.attempts ?? 1
  const status = log?.status ?? "?"
  const verdict =
    status === "done"
      ? attempts > 1
        ? "PASS_RETRIED"
        : "PASS"
      : status === "error"
        ? "FAIL"
        : status === "stopped"
          ? "STOPPED"
          : status.toUpperCase()
  // Ein gereapter Lauf endete bei seiner letzten Aktivität, nicht beim
  // Abräumen; Logs von vor R18 K11 tragen die Abräumzeit in `finished`.
  const zuletzt = typeof log?.reaped?.lastActivity === "string" ? Date.parse(log.reaped.lastActivity) : NaN
  const ende = Number.isFinite(zuletzt) && typeof log?.finished === "number" ? Math.min(log.finished, zuletzt) : log?.finished
  const durationSec =
    typeof ende === "number" && typeof log?.started === "number" ? Math.round((ende - log.started) / 1000) : null
  return {
    id: (log?.id ?? "?").slice(0, 24),
    started: new Date(log?.started ?? 0).toISOString().slice(0, 16),
    pipeline: log?.pipeline ?? "?",
    status,
    verdict,
    nodes: `${nodes.length}(${count("done")}/${count("error")}/${count("stopped")}/${count("skipped")})`,
    durationSec,
    outputWords: words,
    attempts,
    reaped: !!log?.reaped,
    reapedReason:
      typeof log?.reaped === "object" && log?.reaped !== null && typeof log?.reaped?.reason === "string"
        ? log?.reaped?.reason
        : null,
  }
}

if (!existsSync(RUNS_DIR)) {
  console.error(`runs-dir fehlt: ${RUNS_DIR}`)
  process.exit(2)
}

const files = readdirSync(RUNS_DIR)
  // .index.json ist der Run-Index, kein Run selbst (Nebenfund 17.10.: Phantom-Row id:"?")
  .filter((f) => f.endsWith(".json") && !f.startsWith("."))
  .sort()
const rows = files.map((f) => {
  try {
    return scoreRun(JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")))
  } catch {
    return null
  }
}).filter(Boolean) as Row[]

const agg = {
  runsTotal: rows.length,
  pass: rows.filter((r) => r.verdict.startsWith("PASS")).length,
  passRetried: rows.filter((r) => r.verdict === "PASS_RETRIED").length,
  fail: rows.filter((r) => r.verdict === "FAIL").length,
  stopped: rows.filter((r) => r.verdict === "STOPPED").length,
  stoppedMitGrund: rows.filter((r) => r.verdict === "STOPPED" && r.reapedReason !== null).length,
  stoppedOhneGrund: rows.filter((r) => r.verdict === "STOPPED" && r.reapedReason === null).length,
  runningNow: rows.filter((r) => r.status === "running").length,
  reaped: rows.filter((r) => r.reaped).length,
  passQuote: rows.length ? +(rows.filter((r) => r.verdict.startsWith("PASS")).length / rows.length * 100).toFixed(1) : 0,
  avgDurationSecPass: (() => {
    const d = rows.filter((r) => r.verdict.startsWith("PASS") && r.durationSec !== null).map((r) => r.durationSec as number)
    return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null
  })(),
  outputWordsTotal: rows.reduce((a, r) => a + r.outputWords, 0),
}

// Ledger-Sektion (Regeltreue): erst Rohzahlen, sobald Daten existieren.
let ledger: any = null
if (existsSync(LEDGER)) {
  const entries = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }).filter(Boolean) as any[]
  const tasks = entries.filter((e) => e.event === "task")
  const fabrikRuns = entries.filter((e) => e.event === "fabrik_run")
  const fabrikKandidaten = tasks.filter((e) => e.entscheidung === "FABRIK")
  // Regeltreue (13.10.2026): Fan-out gilt als ABGEDECKT, wenn die Session
  // STUFE 1 (`subagent`-Tool, REGEL 1) ODER STUFE 2 (of-run.sh, REGEL 4)
  // genutzt hat. Kandidaten = als FABRIK bewertete Fan-out-Prompts (task +
  // user_prompt). fanoutAbdeckungSession ist die gematchte Quote (30-min-
  // Fenster je session_id); fanoutAbdeckung bleibt ungepaarte Globalzahlen-
  // Näherung, nur noch Kontext (kappt bei mehr Nutzung als Kandidaten auf
  // 100 % — aussagekräftig nur als Obergrenze).
  const userPrompts = entries.filter((e) => e.event === "user_prompt")
  const fanoutKandidaten = fabrikKandidaten.length + userPrompts.filter((e) => e.entscheidung === "FABRIK").length
  const subagentNutzung = tasks.filter((e) => e.quelle === "subagent").length
  const abgedeckt = fabrikRuns.length + subagentNutzung
  // Session-Matching (13.10.2026, OFFEN→FERTIG): Kandidaten mit session_id
  // gelten als abgedeckt, wenn binnen 30 min im SELBEN Session-Kontext ein
  // subagent-Aufruf (task) oder Fabrik-Start (fabrik_run) FOLGT. Alte Zeilen
  // ohne session_id fallen weiter in die Globalzahlen-Näherung.
  const FENSTER_MS = 30 * 60_000
  const ts0 = (e: any) => Date.parse(e.ts)
  const kandidatenSess = userPrompts.filter(
    (e) => e.entscheidung === "FABRIK" && typeof e.session_id === "string",
  )
  const nutzungSess = [...tasks, ...fabrikRuns].filter((e) => typeof e.session_id === "string")
  const abgedecktSess = kandidatenSess.filter((k) =>
    nutzungSess.some(
      (e) => e.session_id === k.session_id && ts0(e) >= ts0(k) && ts0(e) - ts0(k) <= FENSTER_MS,
    ),
  ).length
  // Injektions-Wirksamkeit (18.10.2026): Der Gate injiziert bei FABRIK-Urteil
  // einen Pflicht-/Hinweistext in den User-Prompt (injiziert=true). Gemessen
  // wird, ob binnen desselben Fensters im SELBEN Session-Kontext Stufe 1
  // (subagent) oder Stufe 2 (fabrik_run) folgt. Feldmessung bis 18.10.2026:
  // 0 von 30 Injektionen führten zur Nutzung — deshalb die eigene Kennzahl
  // (die fanoutAbdeckungSession misst alle FABRIK-Kandidaten, auch ohne
  // Injektion, und verwässert damit die Gate-Wirksamkeit).
  const injizierteSess = kandidatenSess.filter((e) => e.injiziert === true)
  const injizierteAbgedeckt = injizierteSess.filter((k) =>
    nutzungSess.some(
      (e) => e.session_id === k.session_id && ts0(e) >= ts0(k) && ts0(e) - ts0(k) <= FENSTER_MS,
    ),
  ).length
  // Pro-Session-Split (18.10.2026): Befolgung pro Instanz (z. B. mcp-workers
  // vs. workspace) sichtbar machen — dieselbe Abdeckungs-Definition wie oben:
  // task|fabrik_run, gleiche session_id, ts zwischen Kandidat und +FENSTER_MS.
  // 1:1-Matching: jede Nutzung deckt höchstens EINEN Kandidat ab (frühester
  // offener zuerst) — sonst deckte eine einzige Nutzung alle Folge-Injektionen
  // „gratis" ab und blähte die Quote auf. Sortiert nach hinweise absteigend.
  // Modell-Split erst, wenn das Gate Modell ins Ledger schreibt
  // (user_prompt-Events haben kein Modellfeld).
  const injektionProSession = [...new Set(injizierteSess.map((k) => k.session_id))]
    .map((session) => {
      const hier = injizierteSess.filter((k) => k.session_id === session)
      const offen = nutzungSess
        .filter((e) => e.session_id === session)
        .map(ts0)
        .sort((a, b) => a - b)
      let abgedeckt = 0
      for (const k of [...hier].sort((a, b) => ts0(a) - ts0(b))) {
        const idx = offen.findIndex((t) => t >= ts0(k) && t - ts0(k) <= FENSTER_MS)
        if (idx >= 0) {
          abgedeckt++
          offen.splice(idx, 1)
        }
      }
      return {
        session,
        hinweise: hier.length,
        abgedeckt,
        quote: +((abgedeckt / hier.length) * 100).toFixed(1),
      }
    })
    .sort((a, b) => b.hinweise - a.hinweise)
  ledger = {
    eintraege: entries.length,
    taskBewertungen: tasks.length,
    subagentNutzung,
    fanoutKandidaten,
    fabrikKandidaten: fabrikKandidaten.length,
    direktEmpfohlen: tasks.filter((e) => e.entscheidung === "DIREKT").length,
    grauzone: tasks.filter((e) => e.entscheidung === "GRAUZONE").length,
    fabrikAufrufe: fabrikRuns.length,
    fanoutKandidatenSession: kandidatenSess.length,
    fanoutAbdeckungSession:
      kandidatenSess.length > 0
        ? +((abgedecktSess / kandidatenSess.length) * 100).toFixed(1)
        : null,
    fanoutAbdeckung:
      fanoutKandidaten > 0
        ? +Math.min(100, (abgedeckt / fanoutKandidaten) * 100).toFixed(1)
        : null,
    // alte, enge Definition (nur Stufe 2/Fabrik) bleibt als Vergleichswert:
    regeltreueFabrik:
      fabrikKandidaten.length > 0
        ? +Math.min(100, (fabrikRuns.length / fabrikKandidaten.length) * 100).toFixed(1)
        : null,
    injizierteFanoutHinweise: injizierteSess.length,
    injektionsWirksamkeit:
      injizierteSess.length > 0
        ? +((injizierteAbgedeckt / injizierteSess.length) * 100).toFixed(1)
        : null,
    injektionProSession,
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ aggregate: agg, ledger, runs: rows.slice(-LIMIT) }, null, 2))
} else {
  const recent = rows.slice(-LIMIT)
  console.log(`## OpenFlow Scorecard — ${rows.length} Runs`)
  console.log(`Quelle: ${RUNS_DIR}`)
  console.log("")
  console.log(`| Kennzahl | Wert |`)
  console.log(`|---|---|`)
  console.log(`| PASS (done) | ${agg.pass} (${agg.passQuote} %) |`)
  console.log(`| davon PASS_RETRIED (Auto-Retry) | ${agg.passRetried} |`)
  console.log(`| FAIL (error) | ${agg.fail} |`)
  console.log(`| STOPPED | ${agg.stopped} (davon ${agg.stoppedMitGrund} mit Grund (z. B. zombie), ${agg.stoppedOhneGrund} ohne Grund) |`)
  console.log(`| jetzt noch running (nach Reaper: 0 erwartet) | ${agg.runningNow} |`)
  console.log(`| davon gereapte Zombies | ${agg.reaped} |`)
  console.log(`| Ø Dauer PASS | ${agg.avgDurationSecPass !== null ? agg.avgDurationSecPass + " s" : "k.A."} |`)
  console.log(`| Output gesamt | ${agg.outputWordsTotal.toLocaleString("de-DE")} Wörter |`)
  console.log("")
  console.log(`| ${"Run".padEnd(24)} | Verdict | Nodes t(d/e/st/sk) | Sek | Wörter | Att |`)
  console.log(`|---|---|---|---|---|---|`)
  for (const r of recent) {
    console.log(
      `| ${r.id.padEnd(24)} | ${r.verdict}${r.reaped ? " (gereapte Leiche)" : ""} | ${r.nodes} | ${r.durationSec ?? "–"} | ${r.outputWords} | ${r.attempts} |`,
    )
  }
  if (ledger) {
    console.log("")
    console.log(`## Regeltreue (Ledger ${LEDGER})`)
    console.log(`| Kennzahl | Wert |`)
    console.log(`|---|---|`)
    console.log(`| Task-Bewertungen | ${ledger.taskBewertungen} |`)
    console.log(`| Subagent-Nutzung (Stufe 1, quelle=subagent) | ${ledger.subagentNutzung} |`)
    console.log(`| Fan-out-Kandidaten (FABRIK bewertet) | ${ledger.fanoutKandidaten} |`)
    console.log(`| echte Fabrik-Aufrufe (Stufe 2) | ${ledger.fabrikAufrufe} |`)
    console.log(`| Fan-out-Kandidaten mit session_id | ${ledger.fanoutKandidatenSession} |`)
    console.log(`| Fan-out-Abdeckung (session-gematcht, 30 min) | ${ledger.fanoutAbdeckungSession !== null ? ledger.fanoutAbdeckungSession + " %" : "noch keine Kandidaten mit session_id"} |`)
    console.log(`| Injektions-Wirksamkeit (injiziert=true → Stufe 1/2, 30 min, session) | ${ledger.injektionsWirksamkeit !== null ? ledger.injektionsWirksamkeit + " %" : "keine injizierten Fälle"} — ${ledger.injizierteFanoutHinweise} Hinweise |`)
    if (ledger.injektionProSession.length > 0) {
      for (const s of ledger.injektionProSession.slice(0, 5)) {
        // Kurzform: erste 8 Zeichen nach ses_ (ohne ses_-Präfix: erste 8 Zeichen)
        const kurz = s.session.startsWith("ses_") ? s.session.slice(4, 12) : s.session.slice(0, 8)
        console.log(`| Injektion pro Session: ${kurz} | ${s.abgedeckt}/${s.hinweise} (${s.quote} %) |`)
      }
    } else {
      console.log("| Injektion pro Session: keine injizierten Fälle mit session_id |")
    }
    console.log(`| Fan-out-Abdeckung (Globalzahlen-Näherung, ungepaart) | ${ledger.fanoutAbdeckung !== null ? ledger.fanoutAbdeckung + " %" : "noch keine Kandidaten"} |`)
    console.log(`| davon Fabrik-only (Globalzahlen, nur Stufe 2) | ${ledger.regeltreueFabrik !== null ? ledger.regeltreueFabrik + " %" : "noch keine Kandidaten"} |`)
  } else {
    console.log("")
    console.log(`Regeltreue: noch keine Ledger-Daten (fabrik-gate-Plugin/of-gate log schreiben sie)`)
  }
}
process.exit(0)
