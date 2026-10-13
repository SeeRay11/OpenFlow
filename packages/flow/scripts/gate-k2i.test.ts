/**
 * K2i (13.10.2026, Abnahme R20): `geheimnis` für Schlüssel-Komposita und
 * Erzeugen/Ausstellen, `last-gegen-ziel` für Umgangssprache und freie
 * Wortstellung, keine Wortregel-PFLICHT für n→1-Zusammenfassungen. Fälle in
 * gate-k2i-faelle.ts (vor dem Fix committet).
 *
 * Gegenprobe gegen den alten Stand:
 *   GATE_ALT=/pfad/zur/alten/of-gate.ts bun test scripts/gate-k2i.test.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FANOUT, GEHEIMNIS_NEIN, KONTROLLE, LAST_NEIN } from "./gate-k2i-faelle"

const g: any = await import(process.env.GATE_ALT ?? "./of-gate")

const TMP = mkdtempSync(join(tmpdir(), "of-gate-k2i-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "test-schluessel\n")

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

describe("K2i — Schlüssel erzeugen/ausstellen (Komposita aller Art) ist ein Nein-Fall", () => {
  test.each(GEHEIMNIS_NEIN)("DIREKT (geheimnis): %s", (t) => direkt(t, "geheimnis"))
})

describe("K2i — Last gegen ein Ziel, umgangssprachlich und in freier Wortstellung", () => {
  test.each(LAST_NEIN)("DIREKT (last-gegen-ziel): %s", (t) => direkt(t, "last-gegen-ziel"))
})

describe("K2i — DIREKT ruft nie das LLM", () => {
  test.each([...GEHEIMNIS_NEIN, ...LAST_NEIN])("kein LLM-Aufruf: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.injizieren).toBe(false)
    expect(bodies).toHaveLength(0)
  })
})

describe("K2i — Preisfragen/-zusammenfassungen, Lesen über Schlüssel und Last: kein Nein, keine PFLICHT", () => {
  test.each(KONTROLLE)("%s", (t) => {
    const v = g.classify(t)
    expect(v.quelle).not.toBe("nein_signal")
    expect(v.quelle).not.toBe("wortregel")
    expect(v.injizieren).toBe(false)
  })
})

describe("K2i — echte Fan-out-Aufträge werden weiter erkannt", () => {
  test.each(FANOUT)("Wortregel oder LLM, kein Nein-Signal: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.quelle).not.toBe("nein_signal")
    expect(v.llm_uebersprungen).toBeUndefined()
    if (v.quelle !== "wortregel") expect(bodies).toHaveLength(1)
    expect(v.injizieren).toBe(true)
  })
})
