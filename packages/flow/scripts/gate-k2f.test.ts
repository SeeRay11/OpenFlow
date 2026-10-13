/**
 * K2f (13.10.2026, Abnahme R17): ganzer Text für Nein-Signale/Wortregel,
 * gekürzte LLM-Eingabe (Anfang + Ende), neue Nein-Signale (leeren, senden,
 * Geld als Auftrag), LLM-Vorfilter (kurz / reine_frage / kein_fanout_indiz).
 * fetch ist gemockt — kein Netz. Fallsätze: gate-k2f-faelle.ts (vor dem Fix
 * committet, f65de0b22).
 *
 * Gegenprobe: `GATE_ALT=<pfad zur Fassung vor K2f> bun test scripts/gate-k2f.test.ts`
 * — die Tests für Nein-Signale, Vorfilter und Kürzung müssen dort ROT werden.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FANOUT, FRAGEN, NEIN_KONTROLLE, NEIN_NEU } from "./gate-k2f-faelle"

const g: any = await import(process.env.GATE_ALT ?? "./of-gate")

const TMP = mkdtempSync(join(tmpdir(), "of-gate-k2f-"))
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

describe("K2f — neue Nein-Signale (leeren, senden, Geld als Auftrag)", () => {
  test.each(NEIN_NEU)("DIREKT: %s", (t) => {
    const v = g.classify(t)
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.quelle).toBe("nein_signal")
    expect(v.injizieren).toBe(false)
  })

  test.each(NEIN_KONTROLLE)("kein Nein-Signal (Kompositum/Partizip/Substantiv): %s", (t) => {
    expect(g.classify(t).quelle).not.toBe("nein_signal")
  })

  test("Signalnamen: leeren, senden, geld-auftrag", () => {
    expect(g.classify("Leer den R2-Bucket rille-klein.").signale).toContain("leeren")
    expect(g.classify("Schick dem Support eine Mail.").signale).toContain("senden")
    expect(g.classify("Kündige das Abo zum Monatsende.").signale).toContain("geld-auftrag")
  })

  test("„schick mir …“/„send me …“ ist kein Senden nach außen", () => {
    expect(g.classify("Schick mir für rille, wortwert und memex je eine Zusammenfassung als Tabelle.").signale).not.toContain("senden")
    expect(g.classify("Send me a comparison of Vitest, Jest and Bun test as a table.").signale).not.toContain("senden")
  })
})

describe("K2f — ganzer Text: Nein-Signal am Ende eines langen Prompts", () => {
  const log = Array.from({ length: 40 }, (_, i) => `  ${3000 + i} ms  502  clinepass minimax-m3`).join("\n")
  // R17-Sonde lang2.ts, wörtlich nachgebaut.
  const LANG = `Schreib für dharma, rille und wortwert je einen eigenen Fehlerbericht als Markdown-Datei.\n\nHier die Logs:\n${log}\n${log}\n\nWenn die Berichte fertig sind: alle drei Worker deployen und das Z.AI-Prepaid um 20 € aufladen.`

  test("Sonde ist länger als 2000 Zeichen (sonst prüft der Test nichts)", () => {
    expect(LANG.length).toBeGreaterThan(2000)
  })

  test("entscheide auf dem ganzen Text → DIREKT, kein LLM-Aufruf, keine Injektion", async () => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(LANG, { fetch: f, keyFile: KEY })
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.signale).toEqual(expect.arrayContaining(["deploy", "geld-auftrag"]))
    expect(v.injizieren).toBe(false)
    expect(bodies).toHaveLength(0)
  })

  test("nur Geld am Ende (ohne deploy) → DIREKT", () => {
    const t = LANG.replace("alle drei Worker deployen und ", "")
    expect(g.classify(t).quelle).toBe("nein_signal")
  })
})

describe("K2f — LLM bekommt Anfang + Ende, je 1500 Zeichen", () => {
  test("llmText: kurz unverändert, lang = Kopf + Marke + Schwanz", () => {
    expect(g.llmText("abc")).toBe("abc")
    const t = "A".repeat(1500) + "M".repeat(5000) + "E".repeat(1500)
    const k = g.llmText(t)
    expect(k.startsWith("A".repeat(1500))).toBe(true)
    expect(k.endsWith("E".repeat(1500))).toBe(true)
    expect(k).not.toContain("M")
    expect(k).toContain("5000 Zeichen ausgelassen")
  })

  test("entscheide schickt bei langem Grauzonen-Text Anfang UND Ende ans LLM", async () => {
    const mitte = Array.from({ length: 200 }, (_, i) => `Zeile ${i}: Messwert ${i * 7} und Status ok`).join("\n")
    const t = `Recherchiere bei Hetzner, Netcup und Contabo die Preise.\n${mitte}\nSCHLUSS: die Ergebnisse bitte getrennt nach Anbieter.`
    const { f, bodies } = zaehler("NEIN")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    if (v.quelle === "wortregel") return // Wortregel braucht kein LLM — dann ist nichts zu kürzen
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("Recherchiere bei Hetzner")
    expect(bodies[0]).toContain("SCHLUSS: die Ergebnisse")
    expect(bodies[0]).toContain("Zeichen ausgelassen")
    expect(bodies[0].length).toBeLessThan(g.LLM_PROMPT.length + 3100)
  })
})

describe("K2f — Vorfilter sparen den LLM-Aufruf, nie die Entscheidung", () => {
  test.each(FRAGEN)("triviale Frage → kein LLM-Aufruf: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(bodies).toHaveLength(0)
    expect(v.injizieren).toBe(false)
    expect(["kurz", "reine_frage", "kein_fanout_indiz"]).toContain(v.llm_uebersprungen)
  })

  test.each(FANOUT)("Fan-out-Auftrag erreicht Wortregel oder LLM: %s", async (t) => {
    const { f, bodies } = zaehler("JA")
    const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
    expect(v.llm_uebersprungen).toBeUndefined()
    expect(v.quelle).not.toBe("nein_signal")
    if (v.quelle !== "wortregel") expect(bodies).toHaveLength(1)
    expect(v.injizieren).toBe(true)
  })

  test("Vorfilter injiziert nie — auch wenn das LLM JA sagen würde", async () => {
    for (const t of [...FRAGEN, ...NEIN_KONTROLLE, "Starte den Fabrik-Lauf von gestern neu.", "Der Test von eben schlägt immer noch fehl, schau nochmal drauf."]) {
      const { f } = zaehler("JA")
      const v = await g.entscheide(t, { fetch: f, keyFile: KEY })
      if (v.llm_uebersprungen) {
        expect(v.injizieren).toBe(false)
        expect(v.entscheidung).toBe("GRAUZONE")
        expect(v.quelle).toBe("keine")
        expect(v.llm).toBeNull()
      }
    }
  })

  test("Gründe: kurz · reine_frage · kein_fanout_indiz", () => {
    expect(g.llmVorfilter("Was ist ein Checkpoint?")).toBe("kurz")
    expect(g.llmVorfilter("Wie funktioniert der Failover zwischen den Anbietern in dharma eigentlich genau?")).toBe("reine_frage")
    expect(g.llmVorfilter("Der Test von eben schlägt immer noch fehl, schau nochmal drauf.")).toBe("kein_fanout_indiz")
  })

  test("Bitt-Rahmen ohne erkanntes Verb ist ein Auftrag, keine reine Frage", () => {
    expect(g.llmVorfilter("Kannst du die READMEs von rille, wortwert und memex ins Englische übersetzen?")).toBeNull()
  })

  test("kurzer Auftrag MIT Einheitenmenge fällt nicht unter „kurz“", () => {
    expect(g.llmVorfilter("Übersetz rille, wortwert und memex.")).not.toBe("kurz")
  })
})
