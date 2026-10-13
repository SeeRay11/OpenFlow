/**
 * of-reap — Zombie-Reaper für OpenFlow-Runs.
 *
 * Ein Run, dessen headless-Prozess starb (kill, Reboot, Crash), bleibt für
 * immer "running" in der Run-Liste: Niemand finalisiert ihn. Gemessen
 * 26.09.2026: 8 solcher Zombies in flow-lab/.openflow/runs.
 *
 * Zombie-Kriterium (beweisbar ohne PID-Datei):
 *   status === "running"
 *   UND (Checkpoint /tmp/openflow-checkpoint-<id>.json fehlt und der Run
 *        started vor mehr als --grace-min Minuten
 *        ODER Checkpoint mtime älter als --min-age-min Minuten)
 *
 * Der Runner schreibt den Checkpoint bei JEDEM onRun-Patch neu — ein lebender
 * Run hat also einen frischen Checkpoint. Stille = tot.
 *
 * Hänger (Abnahme 12.10.2026): Ein Run kann stumm sein, während sein Prozess
 * LEBT — eine Karte hing 43 min in einer Session, die der Server weiter als
 * laufend führte. Der Reap setzte den Run auf "stopped", der Prozess lief
 * weiter, und jeder spätere Reap fand „0 Zombies", weil der Status schon
 * stimmte. headless-run schreibt deshalb `host.pid` in den Run-Log; lebt
 * dieser Prozess noch (und ist er wirklich ein headless-run), wird er beim
 * Reap beendet (SIGTERM) — auch bei einem früher schon gereapten Run — und
 * als Hänger gezählt.
 *
 * Reap = Ehrlichkeit, kein Datenverlust: status "stopped", error-Begründung,
 * finished=letzte Aktivität (die Abräumzeit steht in reaped.at), reaped-Block mit Messwerten. Atomic via temp+rename, damit
 * der Canvas-Store nie eine halbe JSON liest.
 *
 * Usage:
 *   bun of-reap.ts [--runs-dir DIR] [--min-age-min 30] [--grace-min 5] [--dry-run]
 *   of-run.sh --reap [weitere Flags]
 */

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, renameSync } from "node:fs"

/** Der Prozess lebt und ist ein headless-run — eine fremde, wiederverwendete PID wird nie getroffen. */
function lebenderLauf(pid: unknown): number | undefined {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    return cmd.includes("headless-run.ts") ? pid : undefined
  } catch {
    return undefined
  }
}
import { join } from "node:path"
import { homedir } from "node:os"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", join(homedir(), "workspace/flow-lab/.openflow/runs"))
const MIN_AGE_MIN = Number(flag("--min-age-min", "30"))
const GRACE_MIN = Number(flag("--grace-min", "5"))
const DRY = argv.includes("--dry-run")

if (!existsSync(RUNS_DIR)) {
  console.error(`runs-dir fehlt: ${RUNS_DIR}`)
  process.exit(2)
}

const now = Date.now()
let inspected = 0
let reaped = 0
let haenger = 0
const details: string[] = []

/** Beendet den hängenden Prozess eines Runs; true, wenn einer lebte. */
function beende(file: string, log: any, grund: string): boolean {
  const pid = lebenderLauf(log?.host?.pid)
  if (pid === undefined) return false
  haenger++
  if (DRY) {
    details.push(`DRY ${file} — Hänger: Prozess ${pid} lebt (${grund}), würde SIGTERM senden`)
    return true
  }
  try {
    process.kill(pid, "SIGTERM")
    details.push(`HAENGER ${file} — Prozess ${pid} lebte (${grund}), SIGTERM gesendet`)
  } catch (error) {
    details.push(`HAENGER ${file} — Prozess ${pid} lebt (${grund}), SIGTERM scheiterte: ${String(error)}`)
  }
  return true
}

for (const file of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(RUNS_DIR, file)
  inspected++
  let log: any
  try {
    log = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    continue // keine Zombie-Entscheidung auf kaputter Datei
  }
  // Früher schon gereapt, Prozess lebt trotzdem weiter: der Fall, den jeder
  // Folge-Reap als „0 Zombies" übersah.
  if (log?.status !== "running") {
    if (log?.reaped) beende(file, log, "Run bereits gereapt")
    continue
  }

  const id = log.id ?? file.replace(/\.json$/, "")
  const checkpoint = `/tmp/openflow-checkpoint-${id}.json`
  const startedMs = typeof log.started === "number" ? log.started : 0
  // Letzte Aktivität: Checkpoint-mtime oder der späteste Zeitstempel einer
  // Karte — was zuletzt geschah. Sie ist auch das Ende des Laufs (R18 K11:
  // finished = Abräumzeit machte aus ~98 s eine Dauer von 955 s).
  let lastActivityMs = startedMs
  for (const node of Array.isArray(log.nodes) ? log.nodes : []) {
    for (const t of [node?.started, node?.finished]) if (typeof t === "number" && t > lastActivityMs) lastActivityMs = t
  }
  let hasCheckpoint = false
  if (existsSync(checkpoint)) {
    hasCheckpoint = true
    lastActivityMs = Math.max(lastActivityMs, statSync(checkpoint).mtimeMs)
  }

  const silentMin = (now - lastActivityMs) / 60_000
  const noCheckpointOld = !hasCheckpoint && (now - startedMs) / 60_000 > GRACE_MIN
  const checkpointStale = hasCheckpoint && silentMin > MIN_AGE_MIN
  if (!noCheckpointOld && !checkpointStale) continue

  const reason = hasCheckpoint
    ? `zombie — checkpoint seit ${Math.round(silentMin)} min stumm (Schwelle ${MIN_AGE_MIN} min)`
    : `zombie — kein Checkpoint, Run startete vor ${Math.round((now - startedMs) / 60_000)} min (Grace ${GRACE_MIN} min)`

  if (DRY) {
    details.push(`DRY ${file} — würde reaps: ${reason}`)
    beende(file, log, reason)
    reaped++
    continue
  }
  beende(file, log, reason)

  log.status = "stopped"
  log.error = `reaped: ${reason}`
  log.finished = lastActivityMs
  log.reaped = {
    at: new Date(now).toISOString(),
    reason,
    lastActivity: new Date(lastActivityMs).toISOString(),
  }
  const tmp = `${path}.reaping`
  writeFileSync(tmp, JSON.stringify(log, null, 2))
  renameSync(tmp, path)
  details.push(`REAPED ${file} — ${reason}`)
  reaped++
}

for (const line of details) console.error(line)
console.log(
  `of-reap: ${inspected} runs geprüft, ${reaped} ${DRY ? "Zombie(s) gefunden (dry-run)" : "Zombie(s) geborgen"}, ${haenger} Hänger-Prozess(e) ${DRY ? "gefunden" : "beendet"}`,
)
process.exit(0)
