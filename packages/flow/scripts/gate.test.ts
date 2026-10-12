/**
 * Testsuite für of-gate.ts (deterministischer Fabrik-Gate, REGEL 4).
 *
 * Die CLI-Fälle laufen als gespawnter Prozess (Vertrag der Ausgabe); der
 * Korpus (gate-korpus.ts) läuft in-process gegen das exportierte `classify`
 * — seit K2b steht die CLI hinter `import.meta.main`, ein Import ist frei
 * von Seiteneffekten.
 * Alle Läufe schreiben NUR in ein Temp-Verzeichnis (OPENFLOW_LEDGER
 * zeigt auf os.tmpdir()); echte Runs, $HOME und Repo-Dateien bleiben unangetastet.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classify as classifyDirekt } from "./of-gate"
import { ALLE, BEKANNTE_LUECKEN } from "./gate-korpus"

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
    auftrag: { verb: string; objekt: string } | null
    injizieren: boolean
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

describe("of-gate classify — Erklärfragen ohne Ergebnisobjekt (K2)", () => {
  // Erklär-/Verständnisfragen bekommen KEINEN Pflichtweg, auch ohne „?" und
  // auch wenn Fabrik-Signalwörter nur Gegenstand der Frage sind. Bis K2b
  // waren sie DIREKT über die Satzanfangs-Liste `erklaerfrage`; die ist
  // entfallen (kein Ledger-Etikett mehr), die Fälle sind jetzt GRAUZONE
  // (nur Messung) — entscheidend ist `injizieren: false`.
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
    test(`(7) Erklärfrage → kein Pflichtweg: ${task}`, async () => {
      const r = await classify(task)
      expect(r.entscheidung).toBe("GRAUZONE")
      expect(r.injizieren).toBe(false)
      expect(r.signale).not.toContain("erklaerfrage")
    })
  }

  // Wer eine Erklärung als ERGEBNIS bestellt (Schreib-/Erstell-Verb,
  // „in einem Bericht/Artikel", Umfang in Wörtern), hat einen Ja-Fall.
  const auftraege = [
    "Schreibe einen Artikel, der erklärt, wie der Router den Failover macht, mit Recherche zu 5 Anbietern",
    "Erkläre in einem 3000-Wörter-Bericht mit Recherche zu 5 Anbietern, wie Failover funktioniert",
    "Erkläre in einem Bericht mit Recherche, wie die 5 Anbieter Failover machen",
    "Explain in a report with research and a benchmark of 5 providers how failover works",
  ]
  for (const task of auftraege) {
    test(`(8) Erklär-Auftrag mit Ergebnisobjekt bleibt FABRIK: ${task}`, async () => {
      const r = await classify(task)
      expect(r.entscheidung).toBe("FABRIK")
      expect(r.injizieren).toBe(true)
      expect(r.auftrag).not.toBeNull()
    })
  }

  test("(9) Auftrag OHNE Ergebnisobjekt: Signale reichen nicht mehr (Default umgedreht)", async () => {
    // Bis K2b FABRIK (2 Signale). Kein Bericht, keine Datei, keine Menge —
    // das Ergebnis ist eine Chat-Antwort; Asymmetrie: nur messen.
    const r = await classify("Recherchiere parallel und erkläre die Unterschiede")
    expect(r.entscheidung).toBe("GRAUZONE")
    expect(r.injizieren).toBe(false)
    expect(r.grund).toMatch(/kein Auftrag mit Ergebnisobjekt/)
  })
})

describe("of-gate classify — Auftrag mit Ergebnisobjekt (K2b, Korpus)", () => {
  // In-process: dieselbe Funktion, die die CLI ausgibt (import.meta.main-Riegel).
  const luecken = new Set(BEKANNTE_LUECKEN)
  for (const { name, faelle } of ALLE) {
    test(`${name}: ${faelle.length} Fälle — Pflichtweg genau bei Aufträgen`, () => {
      const falsch: string[] = []
      for (const [text, soll] of faelle) {
        if (luecken.has(text)) continue
        const r = classifyDirekt(text)
        if (r.injizieren !== soll) falsch.push(`${soll ? "VERPASST" : "INJIZIERT"} ${r.entscheidung} [${r.signale}] ${text}`)
        // Eine Stelle: FABRIK ⇔ injizieren.
        expect(r.injizieren).toBe(r.entscheidung === "FABRIK")
      }
      expect(falsch).toEqual([])
    })
  }

  test("bekannte Lücken sind noch Lücken (sonst aus BEKANNTE_LUECKEN streichen)", () => {
    for (const text of BEKANNTE_LUECKEN) expect(classifyDirekt(text).injizieren).toBe(false)
  })

  test("Zitat zählt nicht als Auftrag, ausgepackter Ganz-Zitat-Prompt schon", () => {
    expect(classifyDirekt("Der Nutzer schrieb „Recherchiere parallel A, B und C und vergleiche sie in einem Bericht“ — sinnvoll?").injizieren).toBe(false)
    expect(classifyDirekt('"Recherchiere parallel A, B und C und vergleiche sie in einem Bericht."').injizieren).toBe(true)
  })

  test("ausdrückliches Nicht-Ausführen schlägt den Auftrag", () => {
    expect(classifyDirekt("Recherchiere parallel A, B und C und vergleiche sie in einem Bericht — nur erklären, nicht starten.").injizieren).toBe(false)
  })

  test("Nein-Fall-Signal schlägt Auftrag mit Ergebnisobjekt", () => {
    const r = classifyDirekt("Recherchiere parallel A, B und C, vergleiche sie in einem Bericht und deploye danach")
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.injizieren).toBe(false)
  })

  test("Prefix fabrik: injiziert auch eine Frage, direkt: nie", () => {
    expect(classifyDirekt("fabrik: wie spät ist es?").injizieren).toBe(true)
    expect(classifyDirekt("direkt: Recherchiere parallel A, B, C und vergleiche sie in einem Artikel").injizieren).toBe(false)
  })

  test("erklärverb mit Artefakt als GEGENSTAND ist kein Auftrag", () => {
    expect(classifyDirekt("Can you explain the difference between an audit and a review here?").injizieren).toBe(false)
    expect(classifyDirekt("Erkläre, wie die Fabrik parallel recherchiert und einen Vergleichsartikel schreibt").injizieren).toBe(false)
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
