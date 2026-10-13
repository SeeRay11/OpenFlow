/**
 * K2/R22 (13.10.2026, Abnahme R21): Nein-Signale feuern nicht mehr auf
 * Dateinamen/Pfade/Inline-Code-Dateinamen; das ältere Signal `secrets` zählt
 * nur bei einer HANDLUNG am Geheimnis (setzen, ändern, rotieren, löschen,
 * ausgeben, im Klartext zeigen, kopieren …), nicht beim Auflisten/Prüfen.
 * Fälle in gate-k2r22-faelle.ts (vor dem Fix committet).
 *
 * Gegenprobe gegen den alten Stand:
 *   GATE_ALT=/pfad/zur/alten/of-gate.ts bun test scripts/gate-k2r22.test.ts
 */
import { describe, expect, test } from "bun:test"
import { DATEINAME, NEIN_BLEIBT, SECRETS_LESEN } from "./gate-k2r22-faelle"

const g: any = await import(process.env.GATE_ALT ?? "./of-gate")

describe("K2/R22 — Nein-Wörter in Dateinamen sind kein Nein-Signal", () => {
  test.each(DATEINAME)("%s", (t, verboten) => {
    const v = g.classify(t)
    for (const s of verboten) expect(v.signale).not.toContain(s)
    expect(v.entscheidung).not.toBe("DIREKT")
  })
})

describe("K2/R22 — Übersicht/Auflisten/Prüfen über Secrets ist kein Nein-Fall", () => {
  test.each(SECRETS_LESEN)("%s", (t) => {
    const v = g.classify(t)
    expect(v.signale).not.toContain("secrets")
    expect(v.signale).not.toContain("geheimnis")
    expect(v.entscheidung).not.toBe("DIREKT")
  })
})

describe("K2/R22 — Handlung am Geheimnis / Nein-Wort außerhalb eines Dateinamens bleibt DIREKT", () => {
  test.each(NEIN_BLEIBT)("%s → %s", (t, signal) => {
    const v = g.classify(t)
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.quelle).toBe("nein_signal")
    expect(v.signale).toContain(signal)
  })
})
