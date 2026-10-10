/**
 * of-nutzung — die komplette OpenFlow-Nutzungsanalyse in einem Befehl.
 *
 * Bisher verteilten fünf Sonden die Frage "wie läuft OpenFlow?": Ledger
 * per jq, opencode.log per grep, Scorecard, Loop-Sonde, Abweichungsliste.
 * Diese Sonde bringt alle Abschnitte hinter EINEN Aufruf (Fenster = letzte
 * N Tage ab heute rückwärts, Default 6):
 *
 *   1. GATE-LEDGER   Tages-Tabelle der Verdict-Verteilung; GRAUZONE ohne
 *                    grund zählt (Begründung ist Pflicht); FABRIK-
 *                    Empfehlungen ohne folgenden fabrik_run = ABWEICHUNG
 *                    (task_ref-Match; Monitoring-Sonden zählen getrennt,
 *                    Hebel 2/14 vom 10.10.2026).
 *   2. OPENCODE-LOG  Treffer je Tag auf of-run|fabrik|FABRIK|OpenFlow, davon
 *                    of-run.sh-Aufrufe; rotierte opencode.log.1 nur als
 *                    Gesamtzahl; „Invalid dharma stream event"-Signaturen
 *                    gesamt. Das Log ist LIVE: nur Zeilen mit timestamp <
 *                    Skript-Start zählen — sonst zählt die Sonde sich selbst.
 *   3. SCORECARD     Kopf-Statistik des bestehenden of-scorecard.ts (Runs,
 *                    Verdicts, Zombies, Ø-Dauer, Wörter, Regeltreue).
 *   4. LOOP          GRÜN/ROT-Zeile des bestehenden of-loopcheck.ts wörtlich.
 *
 * Fehlende Dateien melden „0" statt zu sterben; ein ROT-Loop beendet die
 * Sonde mit Exit 0 (die Analyse soll liefern, nicht scheitern).
 *
 * Usage:
 *   bun of-nutzung.ts [TAGE] [--ledger FILE] [--log FILE] [--runs-dir DIR] [--json]
 *   of-run.sh --nutzung [TAGE]
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Selbst-Beobachtungsfilter: das live-Log wird während des Laufs weiter
// geschrieben — alles ab jetzt gehört der laufenden Sitzung, nicht der
// Vergangenheit, und zählt nicht.
const START_MS = Date.now()
const START_ISO = new Date(START_MS).toISOString()

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const JSON_OUT = argv.includes("--json")
const BUN = process.execPath || "bun"
const SCRIPTS = import.meta.dir

const DAYS = (() => {
  const n = Number(argv.find((a) => /^\d+$/.test(a)) ?? "6")
  return Math.max(1, Math.min(365, n))
})()
const LEDGER = flag("--ledger", process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl"))
const LOG_DIR = join(homedir(), ".local/share/opencode/log")
const LOG = flag("--log", join(LOG_DIR, "opencode.log"))
const LOG_ROTATED = flag("--log-rotated", join(LOG_DIR, "opencode.log.1"))
const RUNS_DIR = flag("--runs-dir", join(homedir(), "workspace/flow-lab/.openflow/runs"))

// Tagesfenster (UTC, wie die ts-Stempel in Ledger und Log): ältester Tag
// zuerst — die Tabelle liest sich wie ein Kalender.
const days: string[] = []
for (let i = DAYS - 1; i >= 0; i--) days.push(new Date(START_MS - i * 86_400_000).toISOString().slice(0, 10))

// ---------------------------------------------------------------- 1. Ledger

type Any = Record<string, any>
const ledgerEntries: Any[] = []
if (existsSync(LEDGER)) {
  for (const l of readFileSync(LEDGER, "utf8").split("\n")) {
    const t = l.trim()
    if (!t) continue
    try {
      ledgerEntries.push(JSON.parse(t))
    } catch {
      // kaputtes Fragment: übergehen, wie of-scorecard/of-loopcheck
    }
  }
}
const dayOf = (e: Any) => (typeof e?.ts === "string" ? e.ts.slice(0, 10) : "")
const inWindow = (e: Any) => days.includes(dayOf(e))
const tasks = ledgerEntries.filter((e) => e?.event === "task" && inWindow(e))
// Hebel 14 (10.10.2026): Monitoring-Sonden (Signatur monitoring:true) zählen
// getrennt von echten Fabrik-Runs. Legacy-Einträge ohne das Feld sind real.
const fabrikRuns = ledgerEntries.filter((e) => e?.event === "fabrik_run" && inWindow(e) && e?.monitoring !== true)
const fabrikRunsMonitoring = ledgerEntries.filter((e) => e?.event === "fabrik_run" && inWindow(e) && e?.monitoring === true)

const ledgerRows = days.map((d) => {
  const t = tasks.filter((e) => dayOf(e) === d)
  return {
    tag: d,
    direkt: t.filter((e) => e?.entscheidung === "DIREKT").length,
    grauzone: t.filter((e) => e?.entscheidung === "GRAUZONE").length,
    fabrik: t.filter((e) => e?.entscheidung === "FABRIK").length,
    fabrikRun: fabrikRuns.filter((e) => dayOf(e) === d).length,
    fabrikRunMonitoring: fabrikRunsMonitoring.filter((e) => dayOf(e) === d).length,
  }
})

// GRAUZONE ohne grund: die Begründung ist Pflicht — jede fehlende ist ein
// Regelverstoß, nicht nur eine Zahl.
const grauzoneOhneGrund = tasks
  .filter((e) => e?.entscheidung === "GRAUZONE" && !e?.grund)
  .map((e) => ({ ts: e.ts, task: String(e?.task ?? "").slice(0, 60) }))

// ABWEICHUNG: FABRIK-Empfehlung ohne folgenden fabrik_run. Seit Hebel 2
// (10.10.2026) wird der Bezug über task_ref/gate_id gematcht — ein fabrik_run
// mit task_ref=<gate_id> der Task-Bewertung gilt als Folge (egal welcher Tag).
// Monitoring-Sonden (monitoring:true) sind keine Folge. Legacy-Einträge ohne
// gate_id fallen auf den Tages-Match zurück (alte Ledger bleiben vergleichbar).
const abweichungen = tasks
  .filter((e) => {
    if (e?.entscheidung !== "FABRIK") return false
    if (typeof e?.gate_id === "string" && e.gate_id) {
      return !fabrikRuns.some((r) => r?.task_ref === e.gate_id)
    }
    return !fabrikRuns.some((r) => dayOf(r) === dayOf(e))
  })
  .map((e) => ({ ts: e.ts, task: String(e?.task ?? "").slice(0, 60) }))

// ------------------------------------------------------------- 2. Opencode-Log

const PATTERN = /of-run|fabrik|FABRIK|[Oo]pen[Ff]low/
const OF_RUN_SH = /of-run\.sh/
const logHits: { day: string; ofRun: boolean }[] = []
let invalidDharma = 0
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    const m = line.match(/^timestamp=(\S+)/)
    if (!m) continue
    const ms = Date.parse(m[1])
    if (Number.isNaN(ms) || ms >= START_MS) continue
    // Signatur im echten Log: „Invalid dharma/openai-compatible-chat stream
    // event" — matcht beide Lesarten (mit und ohne Provider-Mittelteil).
    if (line.includes("Invalid dharma") && line.includes("stream event")) invalidDharma++
    if (PATTERN.test(line)) logHits.push({ day: m[1].slice(0, 10), ofRun: OF_RUN_SH.test(line) })
  }
}
const logRows = days.map((d) => {
  const h = logHits.filter((x) => x.day === d)
  return { tag: d, treffer: h.length, ofRunSh: h.filter((x) => x.ofRun).length }
})
// rotierte Logdatei: historisch, kein Fenster, keine Selbst-Beobachtung —
// nur die Gesamtzahl.
const rotatedTotal = existsSync(LOG_ROTATED)
  ? readFileSync(LOG_ROTATED, "utf8").split("\n").filter((l) => PATTERN.test(l)).length
  : 0

// ------------------------------------------ 3./4. Scorecard + Loop (Sub-Sonden)

function probe(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0 || !p.stdout) return ""
  return p.stdout.toString()
}

const scorecardRaw = probe([BUN, join(SCRIPTS, "of-scorecard.ts"), "--runs-dir", RUNS_DIR, "--ledger", LEDGER])
const scLines = scorecardRaw.split("\n")
// Kopf-Statistik: alles bis zur Run-Tabelle (Zeile „| Run …"), plus die
// Regeltreue-Sektion am Ende.
const cut = scLines.findIndex((l) => l.startsWith("| Run"))
const scorecardHead = (cut >= 0 ? scLines.slice(0, cut) : scLines).map((l) => l.trimEnd()).filter((l) => l !== "")
const ri = scLines.findIndex((l) => l.startsWith("## Regeltreue"))
const regeltreue = ri >= 0 ? scLines.slice(ri).map((l) => l.trimEnd()).filter((l) => l !== "") : []

const loopRaw = probe([BUN, join(SCRIPTS, "of-loopcheck.ts")])
const loopLines = loopRaw.split("\n")
const loopZeile = loopLines.find((l) => l.startsWith("OpenFlow-Loop:")) ?? "OpenFlow-Loop: ? (of-loopcheck lieferte nichts)"
const loopProbleme = loopLines.filter((l) => l.trim().startsWith("!!"))

// -------------------------------------------------------------------- Ausgabe

const report = {
  fenster: { tage: DAYS, von: days[0], bis: days[days.length - 1], startTs: START_ISO },
  ledger: {
    quelle: LEDGER,
    tabelle: ledgerRows,
    grauzoneOhneGrund,
    abweichungen,
  },
  log: {
    quelle: LOG,
    tabelle: logRows,
    invalidDharma,
    rotatedTotal,
  },
  scorecard: { ok: scorecardHead.length > 0, kopf: scorecardHead, regeltreue },
  loop: { zeile: loopZeile, probleme: loopProbleme },
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  console.log(`# OpenFlow-Nutzung — Fenster ${days[0]} … ${days[days.length - 1]} (${DAYS} Tage, Start ${START_ISO})`)
  console.log("")

  console.log(`## 1 — Gate-Ledger (${LEDGER})`)
  if (!existsSync(LEDGER)) {
    console.log("0 Einträge (Ledger fehlt)")
  } else {
    console.log(`| Tag | DIREKT | GRAUZONE | FABRIK | fabrik_run (real) | fabrik_run (monitoring) |`)
    console.log(`|---|---|---|---|---|---|`)
    for (const r of ledgerRows)
      console.log(`| ${r.tag} | ${r.direkt} | ${r.grauzone} | ${r.fabrik} | ${r.fabrikRun} | ${r.fabrikRunMonitoring} |`)
    console.log(
      `| Σ | ${sum(ledgerRows.map((r) => r.direkt))} | ${sum(ledgerRows.map((r) => r.grauzone))} | ${sum(ledgerRows.map((r) => r.fabrik))} | ${sum(ledgerRows.map((r) => r.fabrikRun))} | ${sum(ledgerRows.map((r) => r.fabrikRunMonitoring))} |`,
    )
    console.log(``)
    console.log(`GRAUZONE ohne Begründung (Pflicht verletzt): ${grauzoneOhneGrund.length}`)
    for (const g of grauzoneOhneGrund) console.log(`  !! ${g.ts} «${g.task}»`)
    console.log(`ABWEICHUNGEN — FABRIK-Empfehlung ohne folgenden fabrik_run (task_ref-Match, Legacy: Tages-Match): ${abweichungen.length}`)
    for (const a of abweichungen) console.log(`  - ${a.ts} «${a.task}»`)
  }
  console.log("")

  console.log(`## 2 — OpenCode-Log (${LOG}; nur Zeilen mit timestamp < ${START_ISO})`)
  if (!existsSync(LOG)) {
    console.log("0 Treffer (Log fehlt)")
  } else {
    console.log(`| Tag | Treffer (of-run|fabrik|FABRIK|OpenFlow) | davon of-run.sh |`)
    console.log(`|---|---|---|`)
    for (const r of logRows) console.log(`| ${r.tag} | ${r.treffer} | ${r.ofRunSh} |`)
    console.log(`| Σ | ${sum(logRows.map((r) => r.treffer))} | ${sum(logRows.map((r) => r.ofRunSh))} |`)
    console.log(``)
    console.log(`rotierte ${LOG_ROTATED}: ${rotatedTotal} Treffer gesamt`)
    console.log(`„Invalid dharma stream event"-Signaturen: ${invalidDharma} (live)`)
  }
  console.log("")

  console.log(`## 3 — Scorecard`)
  if (scorecardHead.length === 0) {
    console.log(`0 (of-scorecard lieferte nichts — runs-dir fehlt oder leer: ${RUNS_DIR})`)
  } else {
    for (const l of scorecardHead) console.log(l)
    for (const l of regeltreue) console.log(l)
  }
  console.log("")

  console.log(`## 4 — Loop`)
  console.log(loopZeile)
  for (const p of loopProbleme) console.log(p)
}
process.exit(0)
