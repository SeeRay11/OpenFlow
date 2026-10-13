/**
 * Tests für of-reap.ts (bun test).
 *
 * Läuft of-reap.ts als Subprozess gegen ein Temp-Runs-Dir (--runs-dir).
 * Checkpoints leben fest in /tmp/openflow-checkpoint-<id>.json (Skript-Quelltext,
 * Pfad nicht konfigurierbar) — daher eindeutige Test-IDs, damit keine echten
 * Run-Checkpoints getroffen werden; Cleanup in afterEach. Es wird nirgendwo
 * in echte Runs, $HOME oder ~/.openflow geschrieben.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const REAP = join(import.meta.dir, "of-reap.ts")

let runsDir: string
let checkpointFiles: string[] = []
let seq = 0

const uniqId = () => `reaptest-${Date.now()}-${process.pid}-${seq++}`

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "of-reap-test-runs-"))
  checkpointFiles = []
})

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true })
  for (const p of checkpointFiles) rmSync(p, { force: true })
})

function writeRun(file: string, log: unknown) {
  writeFileSync(file, JSON.stringify(log, null, 2))
}

function setCheckpoint(id: string, ageMin: number): string {
  const p = `/tmp/openflow-checkpoint-${id}.json`
  writeFileSync(p, "{}")
  const t = new Date(Date.now() - ageMin * 60_000)
  utimesSync(p, t, t)
  checkpointFiles.push(p)
  return p
}

function reap(args: string[]) {
  const proc = Bun.spawnSync(["bun", REAP, "--runs-dir", runsDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

describe("of-reap", () => {
  it("R18 K11: Dauer eines gereapten Laufs endet bei der letzten Aktivität, nicht beim Abräumen", () => {
    // Anlass: run-2026-10-13T00-14-05-710Z-8uustv — gestartet 00:14:05.710,
    // letzter Checkpoint 00:15:43.299, gereapt 00:30:01.107 → Dauer 955 s
    // statt ~98 s.
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    const started = Date.now() - 120 * 60_000
    writeRun(file, { id, status: "running", started, nodes: [{ id: "boss", status: "running", started: started + 1_000 }] })
    const cp = setCheckpoint(id, 60) // letzte Aktivität vor 60 min
    const letzte = Math.round(statSync(cp).mtimeMs)
    const r = reap(["--min-age-min", "30", "--grace-min", "5"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(Math.abs(log.finished - letzte)).toBeLessThan(1_000)
    expect(Math.round((log.finished - log.started) / 60_000)).toBe(60)
    expect(Date.parse(log.reaped.at)).toBeGreaterThan(Date.now() - 60_000) // Abräumzeit bleibt erhalten
  })

  it("R18 K11: ohne Checkpoint zählt der späteste Karten-Zeitstempel als letzte Aktivität", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    const started = Date.now() - 60 * 60_000
    writeRun(file, {
      id,
      status: "running",
      started,
      nodes: [
        { id: "boss", status: "running", started: started + 1_000 },
        { id: "w", status: "done", started: started + 2_000, finished: started + 90_000 },
      ],
    })
    const r = reap(["--min-age-min", "30", "--grace-min", "5"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(log.finished).toBe(started + 90_000)
    expect(log.reaped.lastActivity).toBe(new Date(started + 90_000).toISOString())
  })

  it("lässt frischen Checkpoint stehen (kein Reap)", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() })
    setCheckpoint(id, 0) // mtime: jetzt
    const r = reap(["--min-age-min", "1", "--grace-min", "5"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("0 Zombie(s) geborgen")
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
  })

  it("reappt alten Checkpoint jenseits der Schwelle", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000 })
    setCheckpoint(id, 60) // 60 min stumm, Schwelle 30
    const r = reap(["--min-age-min", "30", "--grace-min", "5"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(log.error).toMatch(/^reaped: zombie — checkpoint seit \d+ min stumm/)
    expect(log.reaped.reason).toContain("stumm")
    expect(log.finished).toBeNumber()
  })

  it("respektiert Grace: fehlender Checkpoint, started innerhalb --grace-min → kein Reap", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 2 * 60_000 })
    const r = reap(["--grace-min", "5", "--min-age-min", "30"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
  })

  it("reappt fehlenden Checkpoint nach Ablauf der Grace", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 10 * 60_000 })
    const r = reap(["--grace-min", "5", "--min-age-min", "30"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(log.error).toContain("kein Checkpoint")
    expect(log.reaped.reason).toContain("Grace 5 min")
  })

  it("überspringt kaputte JSON-Datei ohne Exception und ohne Änderung", () => {
    const file = join(runsDir, `broken-${uniqId()}.json`)
    writeFileSync(file, "{nicht gültiges json")
    const empty = join(runsDir, `empty-${uniqId()}.json`)
    writeFileSync(empty, "")
    const r = reap([])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("2 runs geprüft, 0 Zombie(s) geborgen")
    expect(readFileSync(file, "utf8")).toBe("{nicht gültiges json")
    expect(readFileSync(empty, "utf8")).toBe("")
  })

  it("dry-run meldet Kandidaten, ändert aber nichts", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000 })
    setCheckpoint(id, 60)
    const r = reap(["--min-age-min", "30", "--grace-min", "5", "--dry-run"])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`DRY ${id}.json`)
    expect(r.stdout).toContain("1 Zombie(s) gefunden (dry-run)")
    // Datei unangetastet, kein Reaping-Rest
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
    expect(log.reaped).toBeUndefined()
    expect(existsSync(`${file}.reaping`)).toBe(false)
  })

  it("lässt Runs ohne status=running unberührt", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "done", started: Date.now() - 999 * 60_000 })
    const r = reap(["--grace-min", "0", "--min-age-min", "1"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("done")
    expect(log.reaped).toBeUndefined()
  })

  // Abnahme 12.10.2026: der Run war gereapt, sein Prozess hing 43 min weiter,
  // und jeder Folge-Reap meldete „0 Zombies". Ein Stellvertreter-Prozess mit
  // `headless-run.ts` in der Kommandozeile steht für den hängenden Lauf.
  function haengerProzess() {
    return Bun.spawn(["bash", "-c", "sleep 60; true", "headless-run.ts"], { stdout: "ignore", stderr: "ignore" })
  }

  it("beendet den lebenden Prozess eines stummen Runs und zählt ihn als Hänger", async () => {
    const proc = haengerProzess()
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000, host: { pid: proc.pid } })
    setCheckpoint(id, 60)
    const r = reap(["--min-age-min", "30"])
    expect(r.stdout).toContain("1 Zombie(s) geborgen, 1 Hänger-Prozess(e) beendet")
    expect(r.stderr).toContain(`Prozess ${proc.pid} lebte`)
    expect(await proc.exited).not.toBe(0)
  })

  it("erkennt den Hänger auch, wenn der Run schon früher gereapt wurde", async () => {
    const proc = haengerProzess()
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, {
      id,
      status: "stopped",
      started: Date.now() - 60 * 60_000,
      reaped: { at: new Date().toISOString(), reason: "zombie" },
      host: { pid: proc.pid },
    })
    const r = reap(["--min-age-min", "30"])
    expect(r.stdout).toContain("0 Zombie(s) geborgen, 1 Hänger-Prozess(e) beendet")
    expect(await proc.exited).not.toBe(0)
  })

  it("trifft keine fremde PID: ein Prozess, der kein headless-run ist, bleibt am Leben", () => {
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" })
    try {
      const id = uniqId()
      const file = join(runsDir, `${id}.json`)
      writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000, host: { pid: proc.pid } })
      setCheckpoint(id, 60)
      const r = reap(["--min-age-min", "30"])
      expect(r.stdout).toContain("1 Zombie(s) geborgen, 0 Hänger-Prozess(e) beendet")
      expect(proc.killed || proc.exitCode !== null).toBe(false)
    } finally {
      proc.kill()
    }
  })
})
