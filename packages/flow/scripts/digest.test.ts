/**
 * Tests für of-digest.ts (bun test).
 *
 * Rein hermetisch: buildFabrikDigest wird mit Inline-Ledger-Zeilen gefahren
 * (kein FS), runDailyDigest ausschließlich gegen fs.mkdtemp-Verzeichnisse —
 * nie gegen ~/.openflow. Zeitpunkte sind fixe Dates, kein Date.now().
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildFabrikDigest, runDailyDigest } from "./of-digest.ts"

const NOW = new Date("2026-10-10T12:00:00.000Z")
const iso = (offsetTage: number, stunden = 0) =>
  new Date(NOW.getTime() + offsetTage * 24 * 3_600_000 + stunden * 3_600_000).toISOString()

let txDirs: string[] = []

afterEach(() => {
  for (const d of txDirs) rmSync(d, { recursive: true, force: true })
  txDirs = []
})

describe("buildFabrikDigest — reine Berechnung", () => {
  test("(a) FABRIK ohne fabrik_run → Digest-Zeile mit Datum und Signalen", () => {
    const e = buildFabrikDigest(
      [{ ts: iso(-1), event: "task", entscheidung: "FABRIK", signale: ["breite suche", "klarer output"] }],
      NOW,
    )
    expect(e.summe).toBe(1)
    expect(e.fabrikOhneRun).toBe(1)
    expect(e.grauzoneOhneRun).toBe(0)
    expect(e.zeilen).toHaveLength(1)
    expect(e.zeilen[0]).toContain("FABRIK-Empfehlung ohne Run: 2026-10-09")
    expect(e.zeilen[0]).toContain("breite suche, klarer output")
    expect(e.fensterVon).toBe("2026-10-03")
    expect(e.fensterBis).toBe("2026-10-10")
  })

  test("(a2) Kandidat ohne signale-Feld → Zeile mit k.A.", () => {
    const e = buildFabrikDigest([{ ts: iso(-1), event: "task", entscheidung: "FABRIK" }], NOW)
    expect(e.zeilen[0]).toContain("k.A.")
  })

  test("(b) fabrik_run verbraucht Kandidat 1:1 — ein Run deckt nicht zwei", () => {
    const e = buildFabrikDigest(
      [
        { ts: iso(-2), event: "task", entscheidung: "FABRIK" },
        { ts: iso(-1), event: "task", entscheidung: "FABRIK" },
        { ts: iso(-1, 1), event: "fabrik_run" }, // liegt NACH beiden Kandidaten
      ],
      NOW,
    )
    expect(e.fabrikOhneRun).toBe(1) // Run verbraucht nur den ersten Kandidaten
    expect(e.summe).toBe(1)
    expect(e.zeilen).toHaveLength(1)
    expect(e.zeilen[0]).toContain("2026-10-09") // der spätere Kandidat bleibt
  })

  test("(b2) fabrik_run VOR der Empfehlung verbraucht nichts", () => {
    const e = buildFabrikDigest(
      [
        { ts: iso(-3), event: "fabrik_run" },
        { ts: iso(-2), event: "task", entscheidung: "GRAUZONE" },
      ],
      NOW,
    )
    expect(e.grauzoneOhneRun).toBe(1)
    expect(e.zeilen[0]).toContain("GRAUZONE-Empfehlung ohne Run")
  })

  test("(c) Kandidat älter als 7 Tage → außerhalb des Fensters, keine Zeile", () => {
    const e = buildFabrikDigest(
      [
        { ts: iso(-8), event: "task", entscheidung: "FABRIK" }, // 8 Tage alt → raus
        { ts: iso(-7), event: "task", entscheidung: "FABRIK" }, // exakt Fensterrand → noch drin
      ],
      NOW,
    )
    expect(e.fabrikOhneRun).toBe(1)
    expect(e.zeilen).toHaveLength(1)
    expect(e.zeilen[0]).toContain("2026-10-03")
  })
})

describe("runDailyDigest — einmal pro Tag, nur Temp-Verzeichnisse", () => {
  test("(d) schreibt digest-Datei + digest-last.date; zweiter Aufruf am selben Tag schreibt NICHT erneut", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-digest-"))
    const ledgerDir = mkdtempSync(join(tmpdir(), "of-digest-ledger-"))
    txDirs.push(dir, ledgerDir)
    const ledgerPath = join(ledgerDir, "gate-ledger.jsonl")
    writeFileSync(ledgerPath, JSON.stringify({ ts: iso(-1), event: "task", entscheidung: "FABRIK", signale: ["großer fan-out"] }) + "\n")

    const tag = "2026-10-10"
    const r1 = runDailyDigest(dir, ledgerPath, NOW)
    expect(r1).not.toBeNull()
    expect(r1!.tag).toBe(tag)
    expect(existsSync(join(dir, `digest-${tag}.md`))).toBe(true)
    expect(readFileSync(join(dir, "digest-last.date"), "utf8").trim()).toBe(tag)
    const inhalt1 = readFileSync(join(dir, `digest-${tag}.md`), "utf8")
    expect(inhalt1).toContain("FABRIK-Empfehlung ohne Run")
    expect(inhalt1).toContain("Summe: 1 ohne Run")

    // Beweis „schreibt nicht erneut": Datei wird verfälscht, 2. Aufruf muss null
    // liefern und die verfälschte Datei unangetastet lassen.
    const datei = join(dir, `digest-${tag}.md`)
    writeFileSync(datei, "MARKER")
    const r2 = runDailyDigest(dir, ledgerPath, NOW)
    expect(r2).toBeNull()
    expect(readFileSync(datei, "utf8")).toBe("MARKER")
  })

  test("(d2) fehlendes Ledger → Digest mit Summe 0, trotzdem Datei + State", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-digest-empty-"))
    txDirs.push(dir)
    const r = runDailyDigest(dir, join(dir, "gibts-nicht.jsonl"), NOW)
    expect(r).not.toBeNull()
    expect(r!.eintrag.summe).toBe(0)
    expect(r!.eintrag.zeilen).toHaveLength(0)
    const inhalt = readFileSync(join(dir, "digest-2026-10-10.md"), "utf8")
    expect(inhalt).toContain("Keine FABRIK/GRAUZONE-Empfehlung ohne Fabrik-Run im Fenster.")
  })
})
