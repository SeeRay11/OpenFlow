/**
 * of-run.sh — Schalter-Prüfung (Abnahme R18 K10).
 *
 * `of-run.sh --status` startete einen Lauf mit der Pipeline „--status"
 * (404 im Flow-Store, uncaughtException im Log). Ein unbekannter `--`-Schalter
 * muss mit Usage abgelehnt werden, Exit ≠ 0, und es darf KEIN Lauf entstehen.
 *
 * `BUN` zeigt auf ein Protokoll-Skript statt auf bun: jeder Aufruf, den
 * of-run.sh absetzt (Guard, Reap, headless-run), landet als Zeile in einer
 * Datei — ohne Engine, ohne echten Lauf.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { echteStarts } from "./of-fabrik-aufruf"

const OF_RUN = join(import.meta.dir, "of-run.sh")
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function lauf(...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "of-run-test-"))
  dirs.push(dir)
  const protokoll = join(dir, "aufrufe.txt")
  const fakeBun = join(dir, "bun")
  writeFileSync(fakeBun, `#!/usr/bin/env bash\necho "$*" >> "${protokoll}"\nexit 0\n`)
  chmodSync(fakeBun, 0o755)
  const p = Bun.spawnSync(["bash", OF_RUN, ...args], {
    // OPENFLOW_LEDGER: seit Defekt 5 schreibt of-run.sh einen gescheiterten Start ins Ledger — nie ins echte.
    env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir, OPENFLOW_LEDGER: join(dir, "ledger.jsonl") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const aufrufe = existsSync(protokoll) ? readFileSync(protokoll, "utf8").trim().split("\n").filter(Boolean) : []
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), aufrufe }
}

describe("K10 (R18) — unbekannte Schalter starten keinen Lauf", () => {
  for (const schalter of ["--status", "--help-me", "--wait --bogus", "--spread --x"]) {
    test(`of-run.sh ${schalter} → Usage, Exit 2, kein headless-run`, () => {
      const r = lauf(...schalter.split(" "), "aufgabe")
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("unbekannter Schalter")
      expect(r.stderr).toContain("usage")
      expect(r.aufrufe.some((a) => a.includes("headless-run.ts"))).toBe(false)
      expect(r.stdout).not.toContain("LOG=")
    })
  }

  test("Kontrollwert: ein gültiger Pipeline-Name startet headless-run (detached)", () => {
    const r = lauf("auto-orchestrator", "aufgabe", "--mit-strich-im-text")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("LOG=")
    // detached: der Aufruf kann einen Moment nach dem Exit im Protokoll landen
    const ende = Date.now() + 3000
    let aufrufe = r.aufrufe
    while (!aufrufe.some((a) => a.includes("headless-run.ts")) && Date.now() < ende) {
      Bun.sleepSync(50)
      const p = join(dirs[dirs.length - 1], "aufrufe.txt")
      aufrufe = existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : []
    }
    expect(aufrufe.some((a) => a.includes("headless-run.ts") && a.includes("auto-orchestrator"))).toBe(true)
  })

  test("Kontrollwert: --scorecard bleibt ein bekannter Schalter", () => {
    const r = lauf("--scorecard", "--limit", "3")
    expect(r.exitCode).toBe(0)
    expect(r.aufrufe.some((a) => a.includes("of-scorecard.ts") && a.includes("--limit 3"))).toBe(true)
  })
})

/**
 * Defekt 5 (17.10.2026 13:30): ein Fabrik-Start hinterließ weder Log noch Run.
 * Ursache (opencode-Datenbank): der Agent rief das Shell-Werkzeug mit
 * `timeout: 60` — Millisekunden. Die Shell wurde beendet, bevor of-run.sh das
 * Log anlegte (Reap und Guard laufen davor); Ausgabe „(no output)", Ledger
 * führte den Start als fabrik_run. Jeder Abbruch VOR dem Start blieb still.
 * Jetzt: Exit ≠ 0 UND eine Ledger-Zeile event=fabrik_start_fehlgeschlagen.
 */
const SETSID = Bun.which("setsid") // fehlt auf Windows-Runnern
function laufMit(bunSkript: string, args: string[], signalNachMs?: number, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "of-run-frueh-"))
  dirs.push(dir)
  const fakeBun = join(dir, "bun")
  writeFileSync(fakeBun, `#!/usr/bin/env bash\n${bunSkript}\n`)
  chmodSync(fakeBun, 0o755)
  const ledger = join(dir, "ledger.jsonl")
  // eigene Prozessgruppe (setsid): das Shell-Werkzeug beendet bei Timeout die
  // ganze Gruppe, nicht nur bash — sonst wartet bash den Kindprozess ab.
  const gruppe = signalNachMs !== undefined && SETSID !== null
  const p = Bun.spawn(gruppe ? [SETSID!, "bash", OF_RUN, ...args] : ["bash", OF_RUN, ...args], {
    env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir, OPENFLOW_LEDGER: ledger, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (signalNachMs !== undefined) setTimeout(() => process.kill(-p.pid, "SIGTERM"), signalNachMs)
  return p.exited.then(async (exitCode) => ({
    exitCode,
    stdout: await new Response(p.stdout).text(),
    stderr: await new Response(p.stderr).text(),
    ledger: existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : [],
  }))
}

describe("Defekt 5 — früher Abbruch vor dem Log wird sichtbar", () => {
  // Prozessgruppen-Signal braucht setsid (POSIX); auf Windows gibt es weder das eine noch das andere.
  test.skipIf(SETSID === null)("SIGTERM während des Reaps (wie der 60-ms-Timeout): Exit ≠ 0 + Ledger-Zeile", async () => {
    // Reap hängt (sleep), headless-run wird nie erreicht
    const r = await laufMit(`case "$*" in *of-reap.ts*) sleep 5;; esac; exit 0`, ["auto-orchestrator", "aufgabe"], 300)
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout).not.toContain("LOG=")
    expect(r.ledger).toHaveLength(1)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", quelle: "of-run.sh", pipeline: "auto-orchestrator" })
    expect(String(r.ledger[0].grund)).toContain("TERM")
    expect(r.stderr).toContain("Start abgebrochen")
  })

  test("Guard lehnt ab (Exit 3): Exit 3 + Ledger-Zeile mit Grund", async () => {
    const r = await laufMit(`case "$*" in *of-guard.ts*) echo "verschachtelt" >&2; exit 3;; esac; exit 0`, ["auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(3)
    expect(r.ledger).toHaveLength(1)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", exit: 3 })
  })

  test("Session und aufruf_id aus der Umgebung (setzt das Plugin) → Scorecard zieht den Start ab", async () => {
    const r = await laufMit(`case "$*" in *of-guard.ts*) exit 3;; esac; exit 0`, ["auto-orchestrator", "x"], undefined, {
      OPENFLOW_SESSION: "ses_P", OPENFLOW_AUFRUF_ID: "call_P",
    })
    expect(r.ledger[0]).toMatchObject({ session_id: "ses_P", aufruf_id: "call_P" })
    const start = { ts: "2026-10-23T10:00:00Z", event: "fabrik_run", art: "start", aufruf_id: "call_P" }
    expect(echteStarts([start, ...r.ledger])).toEqual([])
  })

  test("unbekannter Schalter: Exit 2 + Ledger-Zeile", async () => {
    const r = await laufMit(`exit 0`, ["--status"])
    expect(r.exitCode).toBe(2)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", exit: 2 })
  })

  test("Kontrollwert: erfolgreicher Start schreibt KEINE Fehlerzeile", async () => {
    const r = await laufMit(`exit 0`, ["auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("LOG=")
    expect(r.ledger).toHaveLength(0)
  })

  test("Kontrollwert: Monitoring (--scorecard) schreibt nie ins Ledger", async () => {
    const r = await laufMit(`exit 0`, ["--scorecard"])
    expect(r.exitCode).toBe(0)
    expect(r.ledger).toHaveLength(0)
  })
})
