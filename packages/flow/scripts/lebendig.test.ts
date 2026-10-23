/**
 * T-01 (Plan „Autonomie 10/10", W2.1): Der Reaper entscheidet nach
 * Lebendigkeit, nicht nach Checkpoint-Stille allein.
 *
 * Anlass: of-loop reapte nach 10 min stummem Checkpoint, of-run.sh nach
 * 15 min, das Karten-Timeout der Engine liegt bei 30 min (engine.ts
 * DEFAULT_NODE_TIMEOUT). Seit dem Hänger-Fix (12.10.2026) schickt der Reaper
 * einem LEBENDEN headless-run SIGTERM — eine Karte, die 25 min an einem
 * langen Werkzeugaufruf arbeitet, wurde also mitten im Lauf erschossen.
 *
 * Die Subprozess-Fälle fahren of-loop.ts und of-run.sh so, wie cron bzw. ein
 * Fabrik-Start sie aufrufen — gegen ein Temp-Runs-Verzeichnis, Temp-State,
 * Temp-Ledger. Nichts davon schreibt nach ~/.openflow oder in echte Runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_NODE_TIMEOUT } from "../src/server/engine"
import { KARTEN_TIMEOUT_MIN, PUFFER_MIN, REAP_SCHWELLE_MIN, TOT_SCHWELLE_MIN, reapUrteil } from "./of-lebendig"

const MIN = 60_000
// Lebendigkeit liest /proc — ohne /proc (Windows) ist jede PID „unbekannt".
const PROC = existsSync("/proc/self")

describe("reapUrteil — eine Regel für of-reap, of-loop und of-run.sh", () => {
  const jetzt = 1_000 * MIN
  const basis = { jetzt, started: jetzt - 40 * MIN, hatCheckpoint: true }

  it("Schwelle kommt aus dem Karten-Timeout der Engine plus Puffer", () => {
    expect(KARTEN_TIMEOUT_MIN * MIN).toBe(DEFAULT_NODE_TIMEOUT)
    expect(REAP_SCHWELLE_MIN).toBe(KARTEN_TIMEOUT_MIN + PUFFER_MIN)
    expect(PUFFER_MIN).toBeGreaterThan(0)
  })

  it("Karte 25 min still, PID lebt → nicht reapen", () => {
    const u = reapUrteil({ ...basis, letzteAktivitaet: jetzt - 25 * MIN, pid: "lebt" })
    expect(u.reapen).toBe(false)
  })

  it("Karte 25 min still, PID tot → reapen", () => {
    const u = reapUrteil({ ...basis, letzteAktivitaet: jetzt - 25 * MIN, pid: "tot" })
    expect(u.reapen).toBe(true)
    expect(u.grund).toContain("tot")
  })

  it("PID lebt, aber länger still als Karten-Timeout + Puffer → Hänger, reapen", () => {
    const u = reapUrteil({ ...basis, letzteAktivitaet: jetzt - (REAP_SCHWELLE_MIN + 1) * MIN, pid: "lebt" })
    expect(u.reapen).toBe(true)
  })

  it("eine kleinere --min-age-min hebt den Schutz eines lebenden Prozesses nicht auf", () => {
    const u = reapUrteil({ ...basis, letzteAktivitaet: jetzt - 25 * MIN, pid: "lebt", minAgeMin: 10 })
    expect(u.reapen).toBe(false)
  })

  it("PID unbekannt (alter Run ohne host.pid): Stille-Schwelle, Vorgabe REAP_SCHWELLE_MIN", () => {
    expect(reapUrteil({ ...basis, letzteAktivitaet: jetzt - 25 * MIN, pid: "unbekannt" }).reapen).toBe(false)
    expect(reapUrteil({ ...basis, letzteAktivitaet: jetzt - (REAP_SCHWELLE_MIN + 1) * MIN, pid: "unbekannt" }).reapen).toBe(true)
    expect(reapUrteil({ ...basis, letzteAktivitaet: jetzt - 25 * MIN, pid: "unbekannt", minAgeMin: 20 }).reapen).toBe(true)
  })

  it("PID tot, aber erst seit kurzem still → Grace abwarten", () => {
    expect(reapUrteil({ ...basis, letzteAktivitaet: jetzt - (TOT_SCHWELLE_MIN - 1) * MIN, pid: "tot" }).reapen).toBe(false)
  })

  it("kein Checkpoint: Grace ab Start, ein lebender Prozess bleibt geschützt", () => {
    const ohne = { jetzt, started: jetzt - 10 * MIN, letzteAktivitaet: jetzt - 10 * MIN, hatCheckpoint: false }
    expect(reapUrteil({ ...ohne, pid: "unbekannt" }).reapen).toBe(true)
    expect(reapUrteil({ ...ohne, pid: "unbekannt" }).grund).toContain("kein Checkpoint")
    expect(reapUrteil({ ...ohne, pid: "lebt" }).reapen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Subprozess: so, wie cron (of-loop) und ein Fabrik-Start (of-run.sh) reapen.

let dir: string
let checkpoints: string[] = []
let prozesse: Array<ReturnType<typeof Bun.spawn>> = []
let seq = 0
const uniqId = () => `lebendtest-${Date.now()}-${process.pid}-${seq++}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "of-lebendig-"))
  checkpoints = []
  prozesse = []
})
afterEach(() => {
  for (const p of prozesse) p.kill()
  for (const c of checkpoints) rmSync(c, { force: true })
  rmSync(dir, { recursive: true, force: true })
})

/** Stellvertreter eines lebenden headless-run (die cmdline trägt den Namen). */
function lebenderLauf() {
  const p = Bun.spawn(["bash", "-c", "sleep 120; true", "headless-run.ts"], { stdout: "ignore", stderr: "ignore" })
  prozesse.push(p)
  return p
}

/** Run mit einer Karte, die seit `stillMin` arbeitet, Checkpoint genauso alt. */
function laufendeKarte(runs: string, stillMin: number, pid: number) {
  const id = uniqId()
  const seit = Date.now() - stillMin * MIN
  writeFileSync(
    join(runs, `${id}.json`),
    JSON.stringify({ id, status: "running", started: seit - MIN, host: { pid }, nodes: [{ id: "boss", status: "running", started: seit }] }),
  )
  const cp = `/tmp/openflow-checkpoint-${id}.json`
  writeFileSync(cp, "{}")
  utimesSync(cp, new Date(seit), new Date(seit))
  checkpoints.push(cp)
  return { id, file: join(runs, `${id}.json`) }
}

function env(runs: string) {
  return {
    ...process.env,
    OPENFLOW_RUNS_DIR: runs,
    OPENFLOW_LEDGER: join(dir, "ledger.jsonl"),
    OPENFLOW_OPENCODE_SERVICE: join(dir, "kein-dienst.json"),
  }
}

function ofLoop(runs: string) {
  const state = join(dir, "state")
  Bun.spawnSync(["mkdir", "-p", state])
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "of-loop.ts"), "--runs-dir", runs, "--state-dir", state, "--heartbeat", join(state, "hb"), "--digest-dir", state, "--ledger", join(dir, "ledger.jsonl"), "--dry-run", "--pipelines", "keine"],
    { env: env(runs), stdout: "pipe", stderr: "pipe" },
  )
}

/** of-run.sh mit einem BUN, der Guard und Reap echt fährt, headless-run nur protokolliert. */
function ofRunStart(runs: string) {
  const fake = join(dir, "bun")
  writeFileSync(
    fake,
    // of-reap bekommt das Temp-Runs-Verzeichnis zusätzlich als Flag: auch ein
    // of-run.sh, das OPENFLOW_RUNS_DIR (noch) nicht kennt, reapt nie echte Runs.
    `#!/usr/bin/env bash\ncase "$1" in\n  *headless-run.ts) echo "$*" >> "${join(dir, "aufrufe.txt")}"; exit 0;;\n  *of-reap.ts) exec "${process.execPath}" "$@" --runs-dir "${runs}";;\nesac\nexec "${process.execPath}" "$@"\n`,
  )
  chmodSync(fake, 0o755)
  return Bun.spawnSync(["bash", join(import.meta.dir, "of-run.sh"), "--wait", "auto-orchestrator", "aufgabe"], {
    env: { ...env(runs), BUN: fake, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir, HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  })
}

const status = (file: string) => JSON.parse(readFileSync(file, "utf8")).status

describe.skipIf(!PROC)("T-01 of-loop (cron-Weg)", () => {
  it("Karte 25 min still, PID lebt → bleibt running, Prozess lebt", () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const p = lebenderLauf()
    const run = laufendeKarte(runs, 25, p.pid)
    ofLoop(runs)
    expect(status(run.file)).toBe("running")
    expect(p.exitCode).toBeNull()
  })

  it("Gegenprobe: Karte 25 min still, PID tot → gereapt", async () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const p = Bun.spawn(["true"])
    await p.exited
    const run = laufendeKarte(runs, 25, p.pid)
    ofLoop(runs)
    expect(status(run.file)).toBe("stopped")
  })
})

describe.skipIf(!PROC)("T-01 of-run.sh (Start-Weg)", () => {
  it("Karte 25 min still, PID lebt → bleibt running", () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const p = lebenderLauf()
    const run = laufendeKarte(runs, 25, p.pid)
    ofRunStart(runs)
    expect(status(run.file)).toBe("running")
    expect(p.exitCode).toBeNull()
  })

  it("Gegenprobe: PID tot → gereapt", async () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const p = Bun.spawn(["true"])
    await p.exited
    const run = laufendeKarte(runs, 25, p.pid)
    ofRunStart(runs)
    expect(status(run.file)).toBe("stopped")
  })
})

describe("EINE Schwellen-Quelle", () => {
  it("of-run.sh und of-loop.ts reichen keine eigene Reap-Schwelle durch", () => {
    const sh = readFileSync(join(import.meta.dir, "of-run.sh"), "utf8")
    const loop = readFileSync(join(import.meta.dir, "of-loop.ts"), "utf8")
    const reapZeile = sh.split("\n").find((z) => z.includes("of-reap.ts") && !z.trimStart().startsWith("#") && !z.includes("--reap"))
    expect(reapZeile).toBeDefined()
    expect(reapZeile).not.toMatch(/--min-age-min\s+\d/)
    expect(loop).not.toMatch(/"--reap-min-age-min",\s*"\d+"/)
    // die Sonde of-loopcheck zählte Zombies mit einer dritten Zahl (15 min)
    const check = readFileSync(join(import.meta.dir, "of-loopcheck.ts"), "utf8")
    expect(check).toContain("reapUrteil(")
    expect(check).not.toMatch(/mtimeMs\s*>\s*\d+\s*\*\s*60_000/)
  })
})

// W2.5 — Pipeline-Auflösung über das aktive Canvas-Projekt.
import { fabrikProjekt, projektPruefung } from "./of-lauf"
import { resolve as res } from "node:path"

describe("W2.5 Fabrik-Projekt gegen aktives Canvas-Projekt", () => {
  // plattformneutral: auf Windows löst resolve("/home/x") zu D:\\home\\x auf
  const lab = res("/home/x/workspace/flow-lab")
  const mcp = res("/home/x/workspace/mcp-workers")
  const da = (p: string) => p === join(lab, ".openflow", "pipelines", "auto-orchestrator.json")

  it("Fall vom 23.10.: Canvas auf mcp-workers, Pipeline fehlt dort → Fehler mit Projekt und Ausweg", () => {
    const r = projektPruefung({ aktiv: mcp, erwartet: lab, pipeline: "auto-orchestrator", pipelineDa: false, existiertImErwarteten: da })
    expect(r.fehler).toContain(mcp)
    expect(r.fehler).toContain(`OPENFLOW_PROJECT=${lab}`)
  })

  it("fremdes Projekt, Pipeline vorhanden → Warnung (Reaper sieht den Lauf nicht), kein Fehler", () => {
    const r = projektPruefung({ aktiv: res("/home/x/workspace/OpenFlow"), erwartet: lab, pipeline: "feature-build", pipelineDa: true, existiertImErwarteten: () => false })
    expect(r.fehler).toBeUndefined()
    expect(r.warnung).toContain("sehen ihn nicht")
  })

  it("Kontrollwert: Canvas auf dem Fabrik-Projekt → weder Fehler noch Warnung", () => {
    expect(projektPruefung({ aktiv: lab + "/", erwartet: lab, pipeline: "auto-orchestrator", pipelineDa: true, existiertImErwarteten: da })).toEqual({})
  })

  it("Fabrik-Projekt: Override, sonst aus OPENFLOW_RUNS_DIR, sonst flow-lab", () => {
    expect(fabrikProjekt({ OPENFLOW_FABRIK_PROJEKT: "/p" })).toBe(res("/p"))
    expect(fabrikProjekt({ OPENFLOW_RUNS_DIR: "/q/.openflow/runs" })).toBe(res("/q"))
    expect(fabrikProjekt({})).toEndWith(join("workspace", "flow-lab"))
  })
})
