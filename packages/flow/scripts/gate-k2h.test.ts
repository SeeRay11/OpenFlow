/**
 * K2h (13.10.2026, Abnahme R19): Geld zuerst, Nein-Signal `geheimnis`,
 * `last-gegen-ziel` erweitert, Beträge nie als Einheiten. Fälle in
 * gate-k2h-faelle.ts (vor dem Fix committet).
 *
 * Gegenprobe gegen den alten Stand:
 *   GATE_ALT=/pfad/zur/alten/of-gate.ts bun test scripts/gate-k2h.test.ts
 * → GELD_NEIN/GEHEIMNIS_NEIN/LAST_NEIN müssen dort (überwiegend) rot sein.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FANOUT, GEHEIMNIS_NEIN, GELD_NEIN, KONTROLLE, LAST_NEIN } from "./gate-k2h-faelle"

const g: any = await import(process.env.GATE_ALT ?? "./of-gate")

const TMP = mkdtempSync(join(tmpdir(), "of-gate-k2h-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "test-schluessel\n")

const NEU = ["geld-auftrag", "geheimnis", "last-gegen-ziel"]
// Betrag = Zahl + Währung als eigenes Wort („3 BSV-Transaktionen“ ist eine Menge Transaktionen).
const BETRAG = /\d\s*(?:€|\$|eur|euro|usd|dollars?|cents?|ct|sats?|bsv|credits?)(?![\p{L}-])|[$€]\s*\d/iu

function zaehler(inhalt = "JA") {
  const bodies: string[] = []
  const f = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body).messages[0].content)
    return new Response(JSON.stringify({ choices: [{ message: { content: inhalt } }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, bodies }
}

function direkt(t: string, signal: string) {
  const v = g.classify(t)
  expect(v.entscheidung).toBe("DIREKT")
  expect(v.quelle).toBe("nein_signal")
  expect(v.injizieren).toBe(false)
  expect(v.signale).toContain(signal)
}

describe("K2h — Geld als Auftrag ist ein Nein-Fall", () => {
  test.each(GELD_NEIN)("DIREKT (geld-auftrag): %s", (t) => direkt(t, "geld-auftrag"))
})

describe("K2h — Schlüssel rotieren/setzen/widerrufen ist ein Nein-Fall", () => {
  test.each(GEHEIMNIS_NEIN)("DIREKT (geheimnis): %s", (t) => direkt(t, "geheimnis"))
})

describe("K2h — Last gegen ein Ziel (Doppelpunkt, gleichzeitige Anfragen)", () => {
  test.each(LAST_NEIN)("DIREKT (last-gegen-ziel): %s", (t) => direkt(t, "last-gegen-ziel"))
})

describe("K2h — DIREKT ruft nie das LLM, auch nicht über entscheide", () => {
  test.each([...GELD_NEIN, ...GEHEIMNIS_NEIN, ...LAST_NEIN])("kein LLM-Aufruf: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.injizieren).toBe(false)
    expect(bodies).toHaveLength(0)
  })
})

describe("K2h — Fragen/Lesen über Beträge, Schlüssel und Last bleiben offen", () => {
  test.each(KONTROLLE)("kein Nein-Signal, kein Betrag als Einheit: %s", (t) => {
    const v = g.classify(t)
    expect(v.quelle).not.toBe("nein_signal")
    for (const n of NEU) expect(v.signale).not.toContain(n)
    const e = g.erkenneEinheiten(t)
    if (e) expect(e).not.toMatch(BETRAG)
  })
})

describe("K2h — Geldbeträge sind nie Einheiten", () => {
  test.each([...GELD_NEIN, ...KONTROLLE].filter((t) => BETRAG.test(t)))("kein Betrag als Einheit: %s", (t) => {
    const e = g.erkenneEinheiten(t)
    if (e) expect(e).not.toMatch(BETRAG)
  })
})

describe("K2h — echte Fan-out-Aufträge mit Zahlen werden weiter erkannt", () => {
  test.each(FANOUT)("Wortregel oder LLM, kein Nein-Signal: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.quelle).not.toBe("nein_signal")
    expect(v.llm_uebersprungen).toBeUndefined()
    if (v.quelle !== "wortregel") expect(bodies).toHaveLength(1)
    expect(v.injizieren).toBe(true)
  })
})
