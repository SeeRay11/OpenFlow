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
  .filter((f) => f.endsWith(".json"))
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
  // Regeltreue neu (13.10.2026): Fan-out gilt als ABGEDECKT, wenn die Session
  // STUFE 1 (`subagent`-Tool, REGEL 1) ODER STUFE 2 (of-run.sh, REGEL 4)
  // genutzt hat. Kandidaten = als FABRIK bewertete Fan-out-Prompts (task +
  // user_prompt). Noch ohne Session-Matching (session_id erst seit heute im
  // Ledger) — Näherung über Gesamtzahlen; Matching folgt, sobald Daten anliegen.
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
    console.log(`| Fan-out-Abdeckung (Stufe 1+2 vs Kandidaten) | ${ledger.fanoutAbdeckung !== null ? ledger.fanoutAbdeckung + " %" : "noch keine Kandidaten"} |`)
    console.log(`| davon Fabrik-only (alte Definition) | ${ledger.regeltreueFabrik !== null ? ledger.regeltreueFabrik + " %" : "noch keine Kandidaten"} |`)
  } else {
    console.log("")
    console.log(`Regeltreue: noch keine Ledger-Daten (fabrik-gate-Plugin/of-gate log schreiben sie)`)
  }
}
process.exit(0)
