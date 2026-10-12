/**
 * Testsuite für of-gate.ts (deterministischer Fabrik-Gate, REGEL 4).
 *
 * Das Skript exportiert nichts und ruft bei direktem Import (bun test)
 * `process.exit(2)` auf — deshalb wird es als CLI-Prozess gespawned.
 * Alle Läufe schreiben NUR in ein Temp-Verzeichnis (OPENFLOW_LEDGER
 * zeigt auf os.tmpdir()); echte Runs, $HOME und Repo-Dateien bleiben unangetastet.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "of-gate.ts")
const TMP = mkdtempSync(join(tmpdir(), "of-gate-test-"))

async function runGate(args: string[]) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: TMP,
    env: { ...process.env, OPENFLOW_LEDGER: join(TMP, "gate-ledger.jsonl") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

/** classify --text <task> → geparstes JSON-Ergebnis; Exit-Code muss 0 sein. */
async function classify(task: string) {
  const { exitCode, stdout, stderr } = await runGate(["classify", "--text", task])
  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  return JSON.parse(stdout.trim()) as {
    entscheidung: string
    signale: string[]
    prefix: string | null
    grund: string
  }
}

describe("of-gate classify — Basisklassifikation", () => {
  test("(1) klare FABRIK-Aufgabe: Research-Fächer mit Fan-out → FABRIK", async () => {
    const r = await classify(
      "Recherchiere für jeden Artikel parallel und erstelle am Ende einen Bericht",
    )
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.prefix).toBeNull()
    expect(r.signale).toContain("recherche")
    expect(r.signale).toContain("parallel")
    expect(r.grund).toMatch(/^mindestens 2 Ja-Fall-Signale:/)
  })

  test("(2) klare DIREKT-Aufgabe: trivialer Einzelschritt → DIREKT", async () => {
    const r = await classify("Trivialer Quick Fix in einer Zeile der Config")
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.prefix).toBeNull()
    expect(r.signale).toEqual(["einzelschritt"])
    expect(r.grund).toBe("Nein-Fall-Signal(e): einzelschritt")
  })

  test("(3a) GRAUZONE: genau ein Ja-Fall-Signal → Eskalationsleiter", async () => {
    const r = await classify("Erstelle einen Vergleich der beiden Bibliotheken")
    expect(r.entscheidung).toBe("GRAUZONE")
    expect(r.prefix).toBeNull()
    expect(r.signale).toEqual(["vergleich"])
    expect(r.grund).toBe(
      "nur ein Ja-Fall-Signal (vergleich) — Eskalationsleiter entscheidet, Begründung Pflicht",
    )
  })

  test("(3b) GRAUZONE: gar keine Signale", async () => {
    const r = await classify("Räume das Regal im Büro auf")
    expect(r.entscheidung).toBe("GRAUZONE")
    expect(r.signale).toEqual([])
    expect(r.grund).toBe("keine Signale — Eskalationsleiter entscheidet, Begründung Pflicht")
  })
})

describe("of-gate classify — Nutzer-Prefixe", () => {
  test("(4) Prefix fabrik: erzwingt FABRIK trotz DIREKT-Tendenz (einzelschritt)", async () => {
    const r = await classify("fabrik: quick fix in der Doku")
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.prefix).toBe("fabrik")
    expect(r.grund).toBe("Nutzer-Prefix fabrik:")
  })

  test("(5) Prefix direkt: verbietet Fabrik trotz FABRIK-Signalen", async () => {
    const r = await classify("direkt: Recherche-Fächer parallel mit Multi-Review")
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.prefix).toBe("direkt")
    expect(r.grund).toBe("Nutzer-Prefix direkt:")
  })
})

describe("of-gate classify — Sicherheit schlägt Effizienz", () => {
  test("(6a) deploy-Signal schlägt gleichzeitige FABRIK-Signale", async () => {
    const r = await classify("Deploye den neuen Artikel-Report parallel zum Release")
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.signale).toEqual(["deploy"])
    expect(r.grund).toBe("Nein-Fall-Signal(e): deploy")
  })

  test("(6b) Geldpfad (stripe/payment) schlägt Recherche-Vergleich", async () => {
    const r = await classify("Recherchiere und vergleiche Stripe-Payment-Anbieter für die Abrechnung")
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.signale).toEqual(["geldpfad"])
  })
})

describe("of-gate classify — Erklärfragen ohne Deliverable (K2)", () => {
  // Erklär-/Verständnisfragen sind Einzelschritte (Nein-Fall), auch ohne „?"
  // und auch wenn Fabrik-Signalwörter nur Gegenstand der Frage sind.
  // Vor dem Fix (gemessen 12.10.2026): die ersten vier GRAUZONE, die mit
  // zwei Signalwörtern FABRIK.
  const erklaerfragen = [
    "Erkläre, wie der Router den Failover macht",
    "Ich frage mich, wie X funktioniert",
    "Beschreib kurz, was Y tut",
    "wie funktioniert der Cache",
    "Erklär mal, wie der Review-Prozess abläuft",
    "Kannst du mir erklären, wie die Recherche-Pipeline parallel arbeitet",
    "Explain how the benchmark and audit scripts work",
    "Erkläre, was der Analyse-Schritt im Bericht macht",
    "Was macht der Vergleich in der Testsuite",
    "Beschreib kurz, wie das Audit für jede Datei läuft",
    "How does the review step compare variants",
    "Erklär mir, wie die parallele Recherche zusammenfasst",
  ]
  for (const task of erklaerfragen) {
    test(`(7) Erklärfrage → DIREKT: ${task}`, async () => {
      const r = await classify(task)
      expect(r.entscheidung).toBe("DIREKT")
      expect(r.signale).toEqual(["erklaerfrage"])
    })
  }

  // Abwägung: Wer eine Erklärung als DELIVERABLE bestellt (Schreib-/
  // Erstell-Verb, „in einem Bericht/Artikel", Umfang in Wörtern), hat einen
  // Ja-Fall — das bleibt FABRIK.
  const auftraege = [
    "Schreibe einen Artikel, der erklärt, wie der Router den Failover macht, mit Recherche zu 5 Anbietern",
    "Erkläre in einem 3000-Wörter-Bericht mit Recherche zu 5 Anbietern, wie Failover funktioniert",
    "Erkläre in einem Bericht mit Recherche, wie die 5 Anbieter Failover machen",
    "Explain in a report with research and a benchmark of 5 providers how failover works",
  ]
  for (const task of auftraege) {
    test(`(8) Erklär-Auftrag mit Deliverable bleibt FABRIK: ${task}`, async () => {
      const r = await classify(task)
      expect(r.entscheidung).toBe("FABRIK")
      expect(r.signale).not.toContain("erklaerfrage")
    })
  }

  test("(9) Erklär-Wort mitten im Auftrag ist keine Erklärfrage", async () => {
    const r = await classify("Recherchiere parallel und erkläre die Unterschiede")
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.signale).not.toContain("erklaerfrage")
  })
})

describe("of-gate CLI-Verhalten", () => {
  test("classify gibt genau eine JSON-Zeile aus", async () => {
    const { stdout } = await runGate(["classify", "--text", "parallel Research-Fächer"])
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(() => JSON.parse(stdout.trim())).not.toThrow()
  })

  test("unbekanntes Kommando → Usage auf stderr, Exit-Code 2", async () => {
    const { exitCode, stdout, stderr } = await runGate(["nonsense"])
    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toMatch(/^usage: bun of-gate\.ts classify/)
  })

  test("classify schreibt KEIN Ledger (nur log tut das)", () => {
    expect(existsSync(join(TMP, "gate-ledger.jsonl"))).toBe(false)
  })
})
