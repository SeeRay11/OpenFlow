/**
 * of-loop — der Selbstheilungs-Zyklus der Fabrik (Dauerbetrieb).
 *
 * Ein Zyklus (Aufruf durch systemd-Timer alle 5 min oder manuell):
 *   1. REAP: Zombies bergen (Checkpoint stumm > 10 min).
 *   2. MESSen: Scorecard-Logik über alle Runs.
 *   3. HEILEN: error-Runs, die noch nie resumed wurden und frisch genug sind
 *      (finished innerhalb --max-age-h, default 24), bekommen ein
 *      checkpoint-resume via of-run.sh --resume (detached, AUTO_RETRY aktiv).
 *      Der alte Run wird mit loop.resumedAt markiert — jede Heilungskette
 *      läuft höchstens einmal pro Run, nichts reiht sich endlos.
 *   4. DIGEST: einmal täglich (State ~/.openflow/digest-last.date) das
 *      Gate-Ledger der letzten 7 Tage scannen — FABRIK/GRAUZONE-Empfehlungen
 *      ohne Fabrik-Run als digest-YYYY-MM-DD.md + Konsolen-Zeile melden.
 *   5. BERICHTEN: eine Zeile in /tmp/of-loop-state.jsonl; der letzte Zustand
 *      steht in /tmp/of-loop-last.json.
 *
 * Guardrails:
 *   - Bewusst OHNE flock: Zyklen stapeln sich nicht praktisch (Timer 5 min,
 *     ein Zyklus < 10 s). Ein Doppelzyklus wäre harmlos — markResumed ist
 *     atomar pro Run (Temp+Rename), der zweite Zugriff fliegt am
 *     loop.resumedAt-Kriterium vorbei. Der Timer-Abstand macht Überlappung
 *     zur Theorie; sollte sie real werden, ist ein flock nachrüstbar, ohne
 *     dass sich etwas anderes ändert.
 *   - Nur Pipelines aus --pipelines (default auto-orchestrator,feature-build)
 *     werden geheilt — Test-/Probe-Pipelines (refine-probe & Co.) bleiben
 *     ehrlich FAIL.
 *   - Kein Resume für Runs mit eigener scorecard.attempts >= 2 (der Runner
 *     hat bereits selbst einmal wiederholt).
 *
 * Usage:
 *   bun of-loop.ts [--interval MIN]        # einmalig; mit --interval endlos
 *   of-run.sh --loop [flags]               # weitergereicht
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, renameSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { runDailyDigest } from "./of-digest.ts"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", join(homedir(), "workspace/flow-lab/.openflow/runs"))
const MAX_AGE_H = Number(flag("--max-age-h", "24"))
const REAP_MIN = Number(flag("--reap-min-age-min", "10"))
const PIPELINES = (flag("--pipelines", "auto-orchestrator,feature-build") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const INTERVAL = argv.includes("--interval") ? Number(flag("--interval", "300")) : 0
const STATE = "/tmp/of-loop-state.jsonl"
const LAST = "/tmp/of-loop-last.json"
// Hebel 3 — Kandidaten-Digest: einmal täglich FABRIK/GRAUZONE-Empfehlungen
// ohne Fabrik-Run melden (Datei + Konsolen-Zeile); State digest-last.date
// verhindert Wiederholung am selben Tag.
const DIGEST_DIR = flag("--digest-dir", join(homedir(), ".openflow"))
const DIGEST_LEDGER = flag("--ledger", process.env.OPENFLOW_LEDGER ?? join(DIGEST_DIR, "gate-ledger.jsonl"))

const ROOT = join(homedir(), "workspace/OpenFlow")
const OF_RUN = join(ROOT, "packages/flow/scripts/of-run.sh")

function reap(): number {
  const before = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).length
  // process.execPath: der eigene Interpreter — cron-Umgebungen haben kein bun im PATH.
  const out = Bun.spawnSync([process.execPath, join(ROOT, "packages/flow/scripts/of-reap.ts"), "--runs-dir", RUNS_DIR, "--min-age-min", String(REAP_MIN)], {
    stdout: "pipe", stderr: "pipe",
  })
  const text = new TextDecoder().decode(out.stdout)
  const m = text.match(/(\d+) Zombie\(s\) geborgen/)
  if (out.exitCode !== 0) console.error(`of-loop: reap meldete exit ${out.exitCode}`)
  return m ? Number(m[1]) : 0
}

interface HealCandidate { file: string; id: string }

function findHealable(): HealCandidate[] {
  if (!existsSync(RUNS_DIR)) return []
  const now = Date.now()
  const out: HealCandidate[] = []
  for (const file of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(RUNS_DIR, file)
    let log: any
    try { log = JSON.parse(readFileSync(path, "utf8")) } catch { continue }
    if (log?.status !== "error") continue
    if (!PIPELINES.includes(log?.pipeline)) continue
    if (log?.loop?.resumedAt) continue // schon einmal geheilt — Kette endet
    if ((log?.scorecard?.attempts ?? 1) >= 2) continue // Runner-Auto-Retry verbraucht
    const finished = typeof log?.finished === "number" ? log.finished : 0
    if (!finished || (now - finished) / 3_600_000 > MAX_AGE_H) continue
    const checkpoint = `/tmp/openflow-checkpoint-${log.id}.json`
    if (!existsSync(checkpoint)) continue // ohne Checkpoint kein Resume-Material
    // Tiefen-Grenze: Nachkommen einer Heilung nicht erneut heilen — die
    // Kette endet nach original + Auto-Retry + EINER Loop-Heilung (mit deren
    // Auto-Retry), sonst repetiert ein kaputter Task im 5-Minuten-Takt.
    try {
      const ck = JSON.parse(readFileSync(checkpoint, "utf8"))
      if (ck?.resumeOf) continue
    } catch { continue }
    // Finale-Absicherung: nicht anfassen, wenn gerade ein Prozess dazu läuft
    if (now - statSync(checkpoint).mtimeMs < 15 * 60_000) continue
    out.push({ file: path, id: log.id })
  }
  return out
}

function markResumed(path: string): boolean {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"))
    log.loop = { ...(log.loop ?? {}), resumedAt: new Date().toISOString(), by: "of-loop" }
    const tmp = `${path}.looping`
    writeFileSync(tmp, JSON.stringify(log, null, 2))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function startResume(id: string): boolean {
  const proc = spawn("bash", [OF_RUN, "--resume", id], {
    detached: true, stdio: "ignore", cwd: ROOT,
    env: { ...process.env, OPENFLOW_AUTO_RETRY: "1" },
  })
  proc.unref()
  return true
}

// Invarianten des Dauerbetriebs — der Loop prüft selbst, was 10/10 ausmacht,
// und schreibt Verstöße als Alert. Ein Wächter, der nur heilt, aber nie
// misst, merkt nicht, wenn HEILEN selbst versagt.
interface Alert { ts: string; invariante: string; wert: string; schwelle: string }

function checkInvariants(): Alert[] {
  const alerts: Alert[] = []
  const now = Date.now()
  let logs: any[] = []
  try {
    logs = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
      try { return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) } catch { return null }
    }).filter(Boolean)
  } catch { return alerts }

  // I1 — Zombies: Nach dem Reap darf kein running-Run mit stummem Checkpoint
  // bleiben ( Reaper versagt oder Schwelle falsch ).
  for (const log of logs) {
    if (log?.status !== "running") continue
    const ck = `/tmp/openflow-checkpoint-${log.id}.json`
    if (!existsSync(ck)) continue // frischer Run ohne ersten Patch
    if (now - statSync(ck).mtimeMs > REAP_MIN * 60_000) {
      alerts.push({ ts: new Date().toISOString(), invariante: "I1-zombies", wert: `${log.id} stumm seit ${Math.round((now - statSync(ck).mtimeMs) / 60000)} min`, schwelle: `${REAP_MIN} min` })
    }
  }

  // I2 — FAIL-Quote der letzten 24 h: Provider-Zusammenbruch sichtbar machen
  // (der Loop heilt, aber er kann einen toten Provider nicht heilen).
  {
    const recent = logs.filter((l) => l?.status !== "running" && typeof l?.finished === "number" && now - l.finished < 24 * 3_600_000)
    const fails = recent.filter((l) => l?.status === "error").length
    if (recent.length >= 5 && fails / recent.length > 0.6) {
      alerts.push({ ts: new Date().toISOString(), invariante: "I2-failquote24h", wert: `${fails}/${recent.length} FAIL`, schwelle: ">60% bei n>=5" })
    }
  }

  // I3 — Regeltreue: FABRIK-Empfehlungen müssen zu Fabrik-Aufrufen führen.
  // Erst ab n>=3 Kandidaten aussagekräftig (frühe Warnung wäre Rauschen).
  {
    const LEDGER_LOCAL = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")
    if (existsSync(LEDGER_LOCAL)) {
      const entries = readFileSync(LEDGER_LOCAL, "utf8").trim().split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean) as any[]
      const kandidaten = entries.filter((e) => e?.event === "task" && e?.entscheidung === "FABRIK").length
      const runs = entries.filter((e) => e?.event === "fabrik_run").length
      if (kandidaten >= 3 && runs / kandidaten < 0.5) {
        alerts.push({ ts: new Date().toISOString(), invariante: "I3-regeltreue", wert: `${runs} Fabrik-Aufrufe zu ${kandidaten} FABRIK-Kandidaten`, schwelle: ">=50% ab n>=3" })
      }
    }
  }
  return alerts
}

async function cycle(): Promise<{ ts: string; gereapt: number; geheilt: string[]; alerts: Alert[] }> {
  // Überlappungs-Schutz bewusst ohne Lock: Ein Doppelzyklus wäre harmlos —
  // markResumed ist atomar pro Run (Temp+Rename), ein zweiter Resume-Start
  // für denselben Run fliegt am loop.resumedAt-Kriterium vorbei. Der
  // Timer-Abstand (5 min) macht Überlappung praktisch unmöglich.
  const gereapt = reap()
  const geheilt: string[] = []
  for (const c of findHealable()) {
    if (!markResumed(c.file)) continue
    startResume(c.id)
    geheilt.push(c.id)
    console.error(`of-loop: heile ${c.id} via checkpoint-resume (detached)`)
  }
  const alerts = checkInvariants()
  for (const a of alerts) console.error(`of-loop ALERT [${a.invariante}] ${a.wert} (Schwelle: ${a.schwelle})`)
  // Hebel 3 — einmal täglich: Kandidaten-Digest (FABRIK/GRAUZONE ohne Run).
  // Läuft im selben Zyklus, ist aber über digest-last.date selbst gedrosselt;
  // ein Doppelzyklus schreibt nichts doppelt. Best effort wie der Bericht.
  try {
    const digest = runDailyDigest(DIGEST_DIR, DIGEST_LEDGER, new Date())
    if (digest) console.error(digest.zeile)
  } catch (e) {
    console.error(`of-loop: Digest fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`)
  }
  const state = { ts: new Date().toISOString(), gereapt, geheilt, alerts }
  try {
    appendFileSync(STATE, JSON.stringify(state) + "\n")
    writeFileSync(LAST, JSON.stringify(state, null, 2))
    if (alerts.length > 0) appendFileSync("/tmp/of-loop-alerts.jsonl", alerts.map((a) => JSON.stringify(a)).join("\n") + "\n")
  } catch { /* Bericht ist best effort */ }
  return state
}

if (INTERVAL > 0) {
  console.error(`of-loop watch: alle ${INTERVAL}s ein Zyklus (PID ${process.pid})`)
  while (true) {
    const s = await cycle()
    console.error(`of-loop: reaped=${s.gereapt} geheilt=${s.geheilt.length} alerts=${s.alerts.length}`)
    await new Promise((r) => setTimeout(r, INTERVAL * 1000))
  }
} else {
  const s = await cycle()
  console.log(JSON.stringify(s))
}
