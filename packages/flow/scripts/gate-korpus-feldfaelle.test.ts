/**
 * Feldfälle aus dem Gate-Ledger (18.10.2026): classify gegen die reale
 * Ledger-Entscheidung. Aufgenommen wurde NUR, was die aktuelle Wortregel
 * gleich entscheidet wie das Feld (entscheidung + signale) — Abweichungen
 * stehen im Abnahme-Bericht, nicht im Korpus. Fallsätze: gate-korpus-feldfaelle.ts.
 *
 * In-process gegen das exportierte `classify` — kein LLM, kein Netz
 * (gleicher Vertrag wie der Korpus-Block in gate.test.ts).
 */

import { describe, expect, test } from "bun:test"
import { classify } from "./of-gate"
import { FELD_DIREKT, FELD_FABRIK, FELD_GRAUZONE } from "./gate-korpus-feldfaelle"

describe("Feldfälle aus dem Ledger — Wortregel entscheidet wie im Feld", () => {
  test.each(FELD_FABRIK)("FABRIK: %s", (text, soll) => {
    const r = classify(text)
    expect(soll).toBe(true)
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.quelle).toBe("wortregel")
    expect(r.signale.length).toBeGreaterThan(0)
    expect(r.injizieren).toBe(true)
  })

  test.each(FELD_DIREKT)("DIREKT (Nein-Signal): %s", (text, soll) => {
    const r = classify(text)
    expect(soll).toBe(false)
    expect(r.entscheidung).toBe("DIREKT")
    expect(r.quelle).toBe("nein_signal")
    expect(r.injizieren).toBe(false)
  })

  test.each(FELD_GRAUZONE)("GRAUZONE (Steuer-Prompt): %s", (text, soll) => {
    const r = classify(text)
    expect(soll).toBe(false)
    expect(r.entscheidung).toBe("GRAUZONE")
    expect(r.quelle).toBe("keine")
    expect(r.injizieren).toBe(false)
  })

  test("Injektion ⇔ FABRIK über alle Feldfälle (gleicher Vertrag wie gate.test.ts)", () => {
    for (const [text, soll] of [...FELD_FABRIK, ...FELD_DIREKT, ...FELD_GRAUZONE]) {
      const r = classify(text)
      expect(r.injizieren).toBe(soll)
      expect(r.entscheidung === "FABRIK").toBe(r.injizieren)
    }
  })
})
