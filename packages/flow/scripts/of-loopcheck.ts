/**
 * of-loopcheck — die Sonde für die loop?-Frage (I4: Loop-Liveness).
 *
 * Der Wächter im Loop kann seinen eigenen Tod nicht melden — cron stirbt,
 * of-loop schweigt, niemand zählt die Stille. Diese Sonde läuft EXTERN
 * (Agent, Nutzer, cron-Zweittakt, TMUX-Statuszeile) und macht den Zustand
 * mit einem Befehl rot/grün:
 *
 *   GRÜN  — letzter Loop-Tick < 12 min alt (2× Timer-Abstand + Puffer),
 *           keine offenen Alerts, keine Zombies nach Reap, Regeltreue >= 50 %
 *           (ab 3 Kandidaten)
 *   ROT   — eines davon verletzt, mit benannter Ursache
 *
 * Exit-Code 0 = grün, 1 = rot — direkt als Erfolgskriterium eines
 * Loop-Engineering-Verify-Schritts verwendbar (success type: command).
 *
 * Usage: bun of-loopcheck.ts [--max-tick-min 12] [--json]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { letzterTick } from "./of-loop-logik.ts"

const argv = process.argv.slice(2)
const MAX_TICK_MIN = Number(argv.includes("--max-tick-min") ? argv[argv.indexOf("--max-tick-min") + 1] : "12")
const JSON_OUT = argv.includes("--json")

// O4: LAST (/tmp/of-loop-last.json) wird vom Loop weiter je Tick geschrieben,
// ist aber NICHT mehr Liveness-Quelle: Fallback ist die State-Datei (Altdaten)
// wie beauftragt, Primärquelle der Herzschlag.
const STATE = "/tmp/of-loop-state.jsonl"
const ALERTS = "/tmp/of-loop-alerts.jsonl"
// O4 — Herzschlag: seit O4 schreibt der Loop jeden Tick EINE überschriebene
// Zeile hierher; die State-Datei enthält nur noch Ereigniszeilen. Pfad wie
// im Loop fest verdrahtet (--heartbeat überschreibbar, für Tests).
const HEARTBEAT = argv.includes("--heartbeat") ? argv[argv.indexOf("--heartbeat") + 1] : "/tmp/opencode/of-loop-heartbeat"
const RUNS_DIR = join(homedir(), "workspace/flow-lab/.openflow/runs")
const LEDGER = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")

const problems: string[] = []
const facts: Record<string, unknown> = {}

// 1 — Loop-Liveness: letzter Herzschlag frisch? (O4) Herzschlag-Datei
//     bevorzugt; Fallback letzte ts aus der State-Datei für Altdaten (vor
//     O4 enthielt sie jeden Tick). Regel in of-loop-logik.ts (rein, getestet).
{
  const letzter = letzterTick(HEARTBEAT, STATE, existsSync, (p) => readFileSync(p, "utf8"))
  if (!letzter) {
    problems.push(`I4-loop: kein Herzschlag (${HEARTBEAT}) und keine State-Historie (${STATE}) — der Loop lief noch nie oder wurde neu installiert`)
  } else {
    const ageMin = (Date.now() - letzter.ms) / 60_000
    facts.letzterTickMin = Math.round(ageMin * 10) / 10
    facts.letzteTickQuelle = letzter.quelle
    if (ageMin > MAX_TICK_MIN) problems.push(`I4-loop: letzter Herzschlag vor ${Math.round(ageMin)} min (Schwelle ${MAX_TICK_MIN}, Quelle ${letzter.quelle}) — cron of-loop tot?`)
  }
}

// 2 — letzte Ticks (Historie sichtbar machen)
if (existsSync(STATE)) {
  facts.letzteTicks = readFileSync(STATE, "utf8").trim().split("\n").slice(-3)
}

// 3 — offene Alerts (die letzten, nicht alle historischen — Alerts sollen
//     abgearbeitet und dann aus der Datei entfernt werden)
if (existsSync(ALERTS)) {
  const lines = readFileSync(ALERTS, "utf8").trim().split("\n").filter(Boolean)
  if (lines.length > 0) {
    facts.offeneAlerts = lines.length
    problems.push(`I1-3: ${lines.length} offene Alerts (letzte: ${lines[lines.length - 1].slice(0, 160)})`)
  }
}

// 4 — Zombies: running-Runs mit stummem Checkpoint (> 15 min)
let zombies = 0
if (existsSync(RUNS_DIR)) {
  for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))) {
    let log: any
    try { log = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) } catch { continue }
    if (log?.status !== "running") continue
    const ck = `/tmp/openflow-checkpoint-${log.id}.json`
    if (existsSync(ck) && Date.now() - statSync(ck).mtimeMs > 15 * 60_000) zombies++
    else if (!existsSync(ck) && Date.now() - (log.started ?? 0) > 5 * 60_000) zombies++
  }
}
facts.zombies = zombies
if (zombies > 0) problems.push(`I1-zombies: ${zombies} running-Run(s) mit stummem Checkpoint — Reaper versagt?`)

// 5 — Regeltreue (nur ab n>=3 Kandidaten bewerten)
if (existsSync(LEDGER)) {
  const entries = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean) as any[]
  const kandidaten = entries.filter((e) => e?.event === "task" && e?.entscheidung === "FABRIK").length
  const runs = entries.filter((e) => e?.event === "fabrik_run").length
  facts.fabrikKandidaten = kandidaten
  facts.fabrikAufrufe = runs
  if (kandidaten >= 3 && runs / kandidaten < 0.5) problems.push(`I3-regeltreue: ${runs}/${kandidaten} — FABRIK-Empfehlungen ohne Folgen`)
}

const gruen = problems.length === 0
const report = { verdict: gruen ? "GRÜN" : "ROT", problems, facts }

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`OpenFlow-Loop: ${gruen ? "GRÜN" : "ROT"}`)
  for (const t of (facts.letzteTicks as string[]) ?? []) console.log(`  tick ${t}`)
  console.log(`  letzter Tick: ${facts.letzterTickMin ?? "?"} min her · Zombies: ${zombies} · Fabrik-Kandidaten: ${facts.fabrikKandidaten ?? 0} → Aufrufe: ${facts.fabrikAufrufe ?? 0}`)
  for (const p of problems) console.log(`  !! ${p}`)
}
process.exit(gruen ? 0 : 1)
