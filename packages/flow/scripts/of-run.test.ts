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
    env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir },
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
