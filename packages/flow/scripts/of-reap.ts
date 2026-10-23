/**
 * of-reap — Zombie-Reaper für OpenFlow-Runs.
 *
 * Ein Run, dessen headless-Prozess starb (kill, Reboot, Crash), bleibt für
 * immer "running" in der Run-Liste: Niemand finalisiert ihn. Gemessen
 * 26.09.2026: 8 solcher Zombies in flow-lab/.openflow/runs.
 *
 * Zombie-Kriterium: die Regel steht in of-lebendig.ts (`reapUrteil`, EINE
 * Schwellen-Quelle für of-reap, of-loop und of-run.sh). Kurz: Prozess tot →
 * nach Grace abräumen; Prozess lebt → erst nach Karten-Timeout + Puffer
 * (35 min) Stille; Prozess unbekannt (Run ohne host.pid) → Stille-Schwelle
 * (--min-age-min, Vorgabe dieselben 35 min). Stille allein beweist nichts:
 * Die Engine schreibt den Checkpoint nur bei Änderungen, eine Karte mit einem
 * langen Zug ist still und lebt (W2.1, 23.10.2026 — vorher reapten of-loop
 * nach 10 und of-run.sh nach 15 min und erschossen lebende Läufe).
 *
 * Rückruf (W2.4): Jeder Reap und jeder Run, der nach STUMM_MELDUNG_MIN noch
 * kein Ende hat, wird der aufrufenden opencode-Sitzung gemeldet (of-rueckruf.ts,
 * genau einmal, fail-open). --dry-run meldet nichts.
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
 *   bun of-reap.ts [--runs-dir DIR] [--min-age-min 35] [--grace-min 5] [--dry-run]
 *   (Runs-Verzeichnis auch per OPENFLOW_RUNS_DIR)
 *   of-run.sh --reap [weitere Flags]
 */

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, renameSync } from "node:fs"
import { lebenderLauf, letzteAktivitaet, pidStatus } from "./of-lauf"
import { reapUrteil, REAP_SCHWELLE_MIN, STUMM_MELDUNG_MIN, TOT_SCHWELLE_MIN } from "./of-lebendig"
import { rueckruf } from "./of-rueckruf"

import { join } from "node:path"
import { homedir } from "node:os"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", process.env.OPENFLOW_RUNS_DIR || join(homedir(), "workspace/flow-lab/.openflow/runs"))!
const MIN_AGE_MIN = Number(flag("--min-age-min", String(REAP_SCHWELLE_MIN)))
const GRACE_MIN = Number(flag("--grace-min", String(TOT_SCHWELLE_MIN)))
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
const meldungen: Array<{ run: any; art: "abgeraeumt" | "stumm"; grund: string; checkpoint: string }> = []

/** Beendet den hängenden Prozess eines Runs; seine PID, wenn einer lebte. */
function beende(file: string, log: any, grund: string): number | undefined {
  const pid = lebenderLauf(log?.host?.pid)
  if (pid === undefined) return undefined
  haenger++
  if (DRY) {
    details.push(`DRY ${file} — Hänger: Prozess ${pid} lebt (${grund}), würde SIGTERM senden`)
    return pid
  }
  try {
    process.kill(pid, "SIGTERM")
    details.push(`HAENGER ${file} — Prozess ${pid} lebte (${grund}), SIGTERM gesendet`)
  } catch (error) {
    details.push(`HAENGER ${file} — Prozess ${pid} lebt (${grund}), SIGTERM scheiterte: ${String(error)}`)
  }
  return pid
}

/**
 * W2.2: headless-run schließt sich auf SIGTERM selbst ab (Verdict stopped,
 * ergebnis.md, Store-PUT, höchstens ~4 s). Der Reaper wartet dieses Ende ab
 * und legt seinen reaped-Block auf DIESEN Stand — sonst überschriebe der PUT
 * des Sterbenden den Reap, und die Scorecard verlöre ihn.
 */
const ABSCHLUSS_WARTEN_MS = 6_000
function warteAufAbschluss(pid: number) {
  const bis = Date.now() + ABSCHLUSS_WARTEN_MS
  while (lebenderLauf(pid) !== undefined && Date.now() < bis) Bun.sleepSync(100)
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
  let lastActivityMs = letzteAktivitaet(log)
  let hasCheckpoint = false
  if (existsSync(checkpoint)) {
    hasCheckpoint = true
    lastActivityMs = Math.max(lastActivityMs, statSync(checkpoint).mtimeMs)
  }

  const urteil = reapUrteil({
    jetzt: now,
    started: startedMs,
    letzteAktivitaet: lastActivityMs,
    hatCheckpoint: hasCheckpoint,
    pid: pidStatus(log?.host?.pid),
    minAgeMin: MIN_AGE_MIN,
    graceMin: GRACE_MIN,
  })
  if (!urteil.reapen) {
    // Stumm (W2.4): läuft, ist nicht abzuräumen, hat aber nach
    // STUMM_MELDUNG_MIN noch kein Ende — die aufrufende Sitzung erfährt es.
    if (!DRY && (now - startedMs) / 60_000 > STUMM_MELDUNG_MIN) {
      meldungen.push({ run: log, art: "stumm", grund: `läuft seit ${Math.round((now - startedMs) / 60_000)} min ohne Ende (${urteil.grund})`, checkpoint })
    }
    continue
  }
  const reason = urteil.grund

  if (DRY) {
    details.push(`DRY ${file} — würde reaps: ${reason}`)
    beende(file, log, reason)
    reaped++
    continue
  }
  const getoetet = beende(file, log, reason)
  if (getoetet !== undefined) {
    warteAufAbschluss(getoetet)
    try {
      const frisch = JSON.parse(readFileSync(path, "utf8"))
      if (frisch?.id === log.id) log = frisch
    } catch {
      /* unlesbar: der eigene Stand bleibt */
    }
  }

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
  meldungen.push({ run: log, art: "abgeraeumt", grund: reason, checkpoint })
  reaped++
}

// Rückruf an die aufrufende Sitzung — nach dem Schreiben, damit eine hängende
// Verbindung nie einen Reap aufhält; fail-open (of-rueckruf schreibt einen
// Fehlschlag ins Ledger, wirft nie).
for (const m of meldungen) {
  const r = await rueckruf(m)
  details.push(`RUECKRUF ${m.run.id} (${m.art}): ${r.status}${r.grund ? ` — ${r.grund}` : ""}`)
}

for (const line of details) console.error(line)
console.log(
  `of-reap: ${inspected} runs geprüft, ${reaped} ${DRY ? "Zombie(s) gefunden (dry-run)" : "Zombie(s) geborgen"}, ${haenger} Hänger-Prozess(e) ${DRY ? "gefunden" : "beendet"}`,
)
process.exit(0)
