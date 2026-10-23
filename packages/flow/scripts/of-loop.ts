/**
 * of-loop — der Selbstheilungs-Zyklus der Fabrik (Dauerbetrieb).
 *
 * Ein Zyklus (Aufruf durch systemd-Timer alle 5 min oder manuell):
 *   1. REAP: Zombies bergen — Regel und Schwellen in of-lebendig.ts (eine
 *      Quelle für of-loop und of-run.sh; Prozess tot → nach Grace, Prozess
 *      lebt → erst nach Karten-Timeout + Puffer). Dabei meldet of-reap jeden
 *      Reap und jeden Run ohne Ende nach 45 min der Start-Sitzung (W2.4).
 *   2. MESSen: Scorecard-Logik über alle Runs.
 *   3. HEILEN: Regel in of-heilung.ts — nur der URSPRUNG einer Familie
 *      (Ursprung + Resumes + Auto-Retries), höchstens HEIL_MAX (2) Heilungen
 *      je Ursprung, nie ein Heilungslauf; bei SERIE_GLEICH (3) gleichen
 *      Fehlschlägen Stopp + Alarm I5-fehlerserie (Konsole, Alerts, Ledger
 *      event heilung_gestoppt, loop.alarm am Ursprung). Resume-Quelle ist der
 *      jüngste gescheiterte Lauf der Familie, er wird mit loop.resumedAt
 *      markiert (= gezählte Heilung).
 *   4. DIGEST: einmal täglich (State ~/.openflow/digest-last.date) das
 *      Gate-Ledger der letzten 7 Tage scannen — FABRIK/GRAUZONE-Empfehlungen
 *      ohne Fabrik-Run als digest-YYYY-MM-DD.md + Konsolen-Zeile melden.
 *   5. BERICHTEN: Herzschlag (EINE Zeile, je Tick überschrieben) in
 *      /tmp/opencode/of-loop-heartbeat; in of-loop-state.jsonl nur noch
 *      Ereigniszeilen (gereapt>0, Heilung, neuer/bestätigter Alert,
 *      Gap-Marker) — ereignisleere Ticks erzeugen keine Zeile mehr
 *      (vor O4: 99,4 % leere Ticks, 390 KB/21 Tage). Der letzte Zustand
 *      steht in /tmp/of-loop-last.json.
 *
 * Loop-Start: liegt seit der letzten Aktivität (Herzschlag, sonst State)
 * mehr als 15 min Stillstand, schreibt der Start EINE Gap-Zeile
 * {"event":"loop_gap","luecke_min":N} — Stille wird sichtbar statt
 * stillschweigend (Beweis: 15.10.2026, ~20 h ohne Tick, ohne Vermerk).
 *
 * Guardrails:
 *   - Bewusst OHNE flock: Zyklen stapeln sich nicht praktisch (Timer 5 min,
 *     ein Zyklus < 10 s). Ein Doppelzyklus wäre harmlos — markLoop ist
 *     atomar pro Run (Temp+Rename), der zweite Zugriff fliegt am
 *     loop.resumedAt-Kriterium vorbei. Der Timer-Abstand macht Überlappung
 *     zur Theorie; sollte sie real werden, ist ein flock nachrüstbar, ohne
 *     dass sich etwas anderes ändert.
 *   - Nur Pipelines aus --pipelines (default auto-orchestrator,feature-build)
 *     werden geheilt — Test-/Probe-Pipelines (refine-probe & Co.) bleiben
 *     ehrlich FAIL.
 *
 * Usage:
 *   bun of-loop.ts [--interval MIN]        # einmalig; mit --interval endlos
 *     [--dry-run] [--state-dir DIR] [--runs-dir DIR] [--ledger FILE]
 *   of-run.sh --loop [flags]               # weitergereicht
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, renameSync, appendFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { runDailyDigest } from "./of-digest.ts"
import { planeHeilung, HEIL_MAX, SERIE_GLEICH, type RunLog } from "./of-heilung.ts"
import { computeI3, dedupAlerts, gapLueckeMin, letzterTick, type AlertLike, type AlertDedupEintrag } from "./of-loop-logik.ts"
import { reapUrteil } from "./of-lebendig.ts"
import { letzteAktivitaet, pidStatus } from "./of-lauf.ts"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", process.env.OPENFLOW_RUNS_DIR || join(homedir(), "workspace/flow-lab/.openflow/runs"))!
const MAX_AGE_H = Number(flag("--max-age-h", "24"))
// Keine eigene Reap-Schwelle mehr (W2.1): hier stand 10 min, in of-run.sh 15,
// das Karten-Timeout ist 30 — der Reaper erschoss lebende Karten. Die Schwelle
// steht in of-lebendig.ts; --reap-min-age-min bleibt nur als Hand-Override.
const REAP_OVERRIDE = flag("--reap-min-age-min")
const PIPELINES = (flag("--pipelines", "auto-orchestrator,feature-build") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const INTERVAL = argv.includes("--interval") ? Number(flag("--interval", "300")) : 0
const STATE_DIR = flag("--state-dir", "/tmp")
const STATE = join(STATE_DIR, "of-loop-state.jsonl")
const LAST = join(STATE_DIR, "of-loop-last.json")
const ALERTS = join(STATE_DIR, "of-loop-alerts.jsonl")
// O4 — Herzschlag: EINE Zeile, je Tick überschrieben; Ticks verlassen die
// State-Datei (99,4 % ereignisleere Zeilen dort vor O4). Pfad wie gefordert
// fest verdrahtet, per --heartbeat für Tests überschreibbar.
const HEARTBEAT = flag("--heartbeat", "/tmp/opencode/of-loop-heartbeat")
// O1 — Dedup-Zustand: kleine Hilfsdatei statt state.jsonl-Tail. Wahl begründet:
// Der Zustand ist eine flache Map (invariante → erstes_ts/letzte Bestätigung),
// O(1) lesbar; ein Tail über state.jsonl müsste rückwärts durch eine
// wachsende Datei parsen (390 KB/21 Tage vor O4). Fehlt die Datei, gilt
// jeder Alert als neu — kein Altdaten-Schaden.
const ALERTS_AKTIV = join(STATE_DIR, "of-loop-alerts-aktiv.json")
// --dry-run: planen, markieren und berichten, aber keinen Resume starten.
const DRY_RUN = argv.includes("--dry-run")
// Hebel 3 — Kandidaten-Digest: einmal täglich FABRIK/GRAUZONE-Empfehlungen
// ohne Fabrik-Run melden (Datei + Konsolen-Zeile); State digest-last.date
// verhindert Wiederholung am selben Tag.
const DIGEST_DIR = flag("--digest-dir", join(homedir(), ".openflow"))
const DIGEST_LEDGER = flag("--ledger", process.env.OPENFLOW_LEDGER ?? join(DIGEST_DIR, "gate-ledger.jsonl"))

// Aus der eigenen Lage, nicht fest ~/workspace/OpenFlow: sonst fährt ein
// Worktree (oder ein Test) den Reaper des Haupt-Checkouts.
const ROOT = resolve(import.meta.dir, "../../..")
const OF_RUN = join(ROOT, "packages/flow/scripts/of-run.sh")

function reap(): number {
  const before = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).length
  // process.execPath: der eigene Interpreter — cron-Umgebungen haben kein bun im PATH.
  const args = [process.execPath, join(ROOT, "packages/flow/scripts/of-reap.ts"), "--runs-dir", RUNS_DIR]
  if (REAP_OVERRIDE) args.push("--min-age-min", REAP_OVERRIDE)
  const out = Bun.spawnSync(args, {
    stdout: "pipe", stderr: "pipe",
  })
  const text = new TextDecoder().decode(out.stdout)
  const m = text.match(/(\d+) Zombie\(s\) geborgen/)
  if (out.exitCode !== 0) console.error(`of-loop: reap meldete exit ${out.exitCode}`)
  return m ? Number(m[1]) : 0
}

// Die Heil-Regel steht in of-heilung.ts (eine Stelle, rein, getestet): nur
// der Ursprung einer Familie, höchstens HEIL_MAX-mal, nie ein Heilungslauf,
// Stopp + Alarm bei SERIE_GLEICH gleichen Fehlschlägen.
function ladeLogs(): Array<RunLog & { file: string }> {
  if (!existsSync(RUNS_DIR)) return []
  const out: Array<RunLog & { file: string }> = []
  for (const file of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const log = JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8"))
      if (typeof log?.id === "string") out.push({ ...log, file: join(RUNS_DIR, file) })
    } catch { /* halb geschrieben: nächster Zyklus */ }
  }
  return out
}

function checkpointMtime(id: string): number | null {
  const path = `/tmp/openflow-checkpoint-${id}.json`
  try { return statSync(path).mtimeMs } catch { return null }
}

function markLoop(path: string, felder: Record<string, unknown>): boolean {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"))
    log.loop = { ...(log.loop ?? {}), ...felder }
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

  // I1 — Zombies: Nach dem Reap darf kein running-Run bleiben, den die
  // Reap-Regel abräumen würde (Reaper versagt). Dieselbe Regel wie of-reap
  // (of-lebendig.ts) — eine lebende, nur stille Karte ist KEIN Alarm.
  for (const log of logs) {
    if (log?.status !== "running") continue
    const ck = `/tmp/openflow-checkpoint-${log.id}.json`
    if (!existsSync(ck)) continue // frischer Run ohne ersten Patch
    const mtime = statSync(ck).mtimeMs
    const urteil = reapUrteil({
      jetzt: now,
      started: typeof log.started === "number" ? log.started : 0,
      letzteAktivitaet: Math.max(mtime, letzteAktivitaet(log)),
      hatCheckpoint: true,
      pid: pidStatus(log?.host?.pid),
      minAgeMin: REAP_OVERRIDE ? Number(REAP_OVERRIDE) : undefined,
    })
    if (urteil.reapen) {
      alerts.push({ ts: new Date().toISOString(), invariante: "I1-zombies", wert: `${log.id} ${urteil.grund}`, schwelle: "of-lebendig.ts reapUrteil" })
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

  // I3 — Regeltreue (O6, korrigiert 17.10.2026): die Mess-Regel steht in
  // of-loop-logik.ts (rein, getestet) — user_prompt|FABRIK-Kandidaten im
  // 7-Tage-Fenster gegen non-monitoring fabrik_run DANACH gematcht;
  // Definition + Forensik (alt 11/24 = 46 % falsch gemessen, 13x Alert in
  // 1 h; task|FABRIK sind REGEL-4-Stufe-1-Fan-outs) dort im Kommentarblock.
  {
    const LEDGER_LOCAL = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")
    if (existsSync(LEDGER_LOCAL)) {
      const entries = readFileSync(LEDGER_LOCAL, "utf8").trim().split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean) as any[]
      const i3 = computeI3(entries, Date.now())
      if (i3.alert) {
        const zusatz = i3.fanouts > 0 ? ` (${i3.fanouts} task|FABRIK im Fenster)` : ""
        alerts.push({
          ts: new Date().toISOString(),
          invariante: "I3-regeltreue",
          wert: `${i3.matches}/${i3.kandidaten} (${i3.quote} %) aufgelöste FABRIK-Empfehlungen befolgt oder begründet (7 Tage)${zusatz}`,
          schwelle: ">=50% ab n>=3",
        })
      }
    }
  }
  return alerts
}

// O1 — Dedup-Zustand lesen/schreiben (Hilfsdatei, Begründung oben bei ALERTS_AKTIV)
function ladeAlertsZustand(): Record<string, AlertDedupEintrag> {
  try { return JSON.parse(readFileSync(ALERTS_AKTIV, "utf8")) } catch { return {} }
}

function speichereAlertsZustand(z: Record<string, AlertDedupEintrag>): void {
  try { writeFileSync(ALERTS_AKTIV, JSON.stringify(z, null, 2)) } catch { /* best effort */ }
}

// O5 — Gap-Marker, EINMAL beim Loop-Start: letzte Aktivität (Herzschlag,
// Fallback State-Datei) gegen die Schwelle (15 min) prüfen; darüber EINE
// Ereigniszeile {"event":"loop_gap","luecke_min":N} in state.jsonl. Ohne
// jede Vorgeschichte (frische Installation) gibt es nichts zu markieren.
function schreibeGapMarker(): void {
  const letzter = letzterTick(HEARTBEAT, STATE, existsSync, readFileSync)
  if (!letzter) return
  const luecke = gapLueckeMin(letzter.ms, Date.now())
  if (luecke === null) return
  try {
    appendFileSync(STATE, JSON.stringify({ event: "loop_gap", luecke_min: luecke, ts: new Date().toISOString() }) + "\n")
  } catch { /* best effort */ }
  console.error(`of-loop: Gap-Marker — ${luecke} min Stillstand seit letzter Aktivität (Quelle: ${letzter.quelle}, Schwelle 15 min)`)
}

async function cycle(): Promise<{ ts: string; gereapt: number; geheilt: string[]; alerts: AlertLike[]; alerts_aktiv: number }> {
  // Überlappungs-Schutz bewusst ohne Lock: Ein Doppelzyklus wäre harmlos —
  // markLoop ist atomar pro Run (Temp+Rename), ein zweiter Resume-Start
  // für denselben Run fliegt am loop.resumedAt-Kriterium vorbei. Der
  // Timer-Abstand (5 min) macht Überlappung praktisch unmöglich.
  const gereapt = reap()
  const geheilt: string[] = []
  const logs = ladeLogs()
  const datei = new Map(logs.map((l) => [l.id, l.file]))
  const plan = planeHeilung(logs, { now: Date.now(), pipelines: PIPELINES, maxAgeH: MAX_AGE_H, checkpoint: checkpointMtime })
  for (const h of plan.heilen) {
    const file = datei.get(h.quelle)
    if (!file || !markLoop(file, { resumedAt: new Date().toISOString(), by: "of-loop", ursprung: h.ursprung, heilung: h.heilung })) continue
    if (!DRY_RUN) startResume(h.quelle)
    geheilt.push(h.quelle)
    console.error(`of-loop: heile ${h.quelle} (Ursprung ${h.ursprung}, Heilung ${h.heilung}/${HEIL_MAX}) via checkpoint-resume (detached)`)
  }
  const alertsAktiv: AlertLike[] = checkInvariants()
  // I5 — Fehlerserie: die Heilung dieses Ursprungs ist beendet, EIN Alarm
  // (Marker loop.alarm am Ursprung verhindert Wiederholung), sichtbar in
  // Konsole, Alerts (of-loopcheck wird rot) und Gate-Ledger.
  for (const a of plan.alarme) {
    const at = new Date().toISOString()
    const file = datei.get(a.ursprung)
    if (!file || !markLoop(file, { alarm: { at, fehler: a.fehler, anzahl: a.anzahl } })) continue
    alertsAktiv.push({ ts: at, invariante: "I5-fehlerserie", wert: `${a.ursprung}: ${a.anzahl}x "${a.fehler.slice(0, 120)}" — Heilung gestoppt`, schwelle: `${SERIE_GLEICH} gleiche Fehlschläge in Folge` })
    try {
      appendFileSync(DIGEST_LEDGER, JSON.stringify({ ts: at, event: "heilung_gestoppt", ursprung: a.ursprung, fehler: a.fehler, anzahl: a.anzahl }) + "\n")
    } catch { /* Ledger ist best effort, die Alarmzeile steht trotzdem */ }
  }
  // O1 — Alert-Dedup: nur neue bzw. nach 24 h bestätigte Alerts werden
  // gemeldet; unveränderte bleiben stumm (vorher: 13x identischer I3-Alert
  // in 1 h, of-loop-state.jsonl:5452-5464). gemeldete Kopien tragen
  // erstes_ts + art ("neu" | "bestaetigt").
  const { melden, zustand } = dedupAlerts(alertsAktiv, ladeAlertsZustand(), Date.now())
  speichereAlertsZustand(zustand)
  for (const a of melden) console.error(`of-loop ALERT [${a.invariante}] ${a.wert} (Schwelle: ${a.schwelle})`)
  // Hebel 3 — einmal täglich: Kandidaten-Digest (FABRIK/GRAUZONE ohne Run).
  // Läuft im selben Zyklus, ist aber über digest-last.date selbst gedrosselt;
  // ein Doppelzyklus schreibt nichts doppelt. Best effort wie der Bericht.
  try {
    const digest = runDailyDigest(DIGEST_DIR, DIGEST_LEDGER, new Date())
    if (digest) console.error(digest.zeile)
  } catch (e) {
    console.error(`of-loop: Digest fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`)
  }
  const ts = new Date().toISOString()
  // O4 — Herzschlag: EINE Zeile, je Tick überschrieben (Frische-Messung für
  // of-loopcheck ohne 99,4 % Leerzeilen in der State-Datei).
  try {
    // Atomar wie markLoop (Temp+Rename): eine halbe Herzschlag-Datei wäre
    // für die Sonde (letzterTick) ein Catch-Fallback auf Altdaten.
    const tmp = `${HEARTBEAT}.tmp`
    writeFileSync(tmp, JSON.stringify({ ts, gereapt, geheilt_n: geheilt.length, alerts_n: alertsAktiv.length }) + "\n")
    renameSync(tmp, HEARTBEAT)
  } catch { /* Herzschlag ist best effort */ }
  // O4/O1 — State-Datei nur noch Ereigniszeilen: gereapt>0, Heilung, neuer
  // bzw. nach 24 h bestätigter Alert (mit erstes_ts/art). Unveränderte
  // Alerts bleiben stumm; LAST (of-loop-last.json) wird JEDEM Tick frisch
  // gehalten, damit Altdaten-Liveness (mtime) weiter funktioniert.
  const gemeldet = melden.length > 0
  if (gereapt > 0 || geheilt.length > 0 || gemeldet) {
    const state = { ts, gereapt, geheilt, alerts: melden }
    try {
      appendFileSync(STATE, JSON.stringify(state) + "\n")
      // ALERTS = offene-Alerts-Warteschlange (of-loopcheck zählt sie):
      // nur echte neue Alerts hinein, Bestätigungen nicht (sonst zählte
      // die Sonde Bestätigungen als offene Alerts).
      const neue = melden.filter((a) => a.art === "neu")
      if (neue.length > 0) appendFileSync(ALERTS, neue.map((a) => JSON.stringify(a)).join("\n") + "\n")
    } catch { /* Bericht ist best effort */ }
  }
  try {
    writeFileSync(LAST, JSON.stringify({ ts, gereapt, geheilt, alerts: alertsAktiv, alerts_aktiv: alertsAktiv.length }, null, 2))
  } catch { /* best effort */ }
  return { ts, gereapt, geheilt, alerts: melden, alerts_aktiv: alertsAktiv.length }
}

schreibeGapMarker()
if (INTERVAL > 0) {
  console.error(`of-loop watch: alle ${INTERVAL}s ein Zyklus (PID ${process.pid})`)
  while (true) {
    const s = await cycle()
    console.error(`of-loop: reaped=${s.gereapt} geheilt=${s.geheilt.length} alerts_aktiv=${s.alerts_aktiv} gemeldet=${s.alerts.length}`)
    await new Promise((r) => setTimeout(r, INTERVAL * 1000))
  }
} else {
  const s = await cycle()
  console.log(JSON.stringify(s))
}
