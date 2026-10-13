/**
 * K2g (13.10.2026, Abnahme R18): Nein-Signale `produktion` und
 * `last-gegen-ziel`. Fälle in gate-k2g-faelle.ts (vor dem Fix committet).
 *
 * Gegenprobe gegen den alten Stand:
 *   GATE_ALT=/pfad/zur/alten/of-gate.ts bun test scripts/gate-k2g.test.ts
 * → PROD_NEIN/LAST_NEIN müssen dort rot sein.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FANOUT, KONTROLLE, LAST_NEIN, PROD_NEIN } from "./gate-k2g-faelle"

const g: any = await import(process.env.GATE_ALT ?? "./of-gate")

const TMP = mkdtempSync(join(tmpdir(), "of-gate-k2g-"))
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

describe("K2g — Wirkung auf die Produktion ist ein Nein-Fall", () => {
  test.each(PROD_NEIN)("DIREKT (produktion): %s", (t) => {
    const v = g.classify(t)
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.quelle).toBe("nein_signal")
    expect(v.injizieren).toBe(false)
    expect(v.signale).toContain("produktion")
  })
})

describe("K2g — Last gegen ein Ziel ist ein Nein-Fall", () => {
  test.each(LAST_NEIN)("DIREKT (last-gegen-ziel): %s", (t) => {
    const v = g.classify(t)
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.quelle).toBe("nein_signal")
    expect(v.injizieren).toBe(false)
    expect(v.signale).toContain("last-gegen-ziel")
  })
})

describe("K2g — Lesen/Analysieren über Produktion und Last bleibt ohne Nein-Signal", () => {
  test.each(KONTROLLE)("kein Nein-Signal: %s", (t) => {
    const v = g.classify(t)
    expect(v.quelle).not.toBe("nein_signal")
    expect(v.signale).not.toContain("produktion")
    expect(v.signale).not.toContain("last-gegen-ziel")
  })
})

describe("K2g — echte Fan-out-Aufträge werden weiter erkannt", () => {
  test.each(FANOUT)("Wortregel oder LLM, kein Nein-Signal: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.quelle).not.toBe("nein_signal")
    expect(v.llm_uebersprungen).toBeUndefined()
    if (v.quelle !== "wortregel") expect(bodies).toHaveLength(1)
    expect(v.injizieren).toBe(true)
  })
})
