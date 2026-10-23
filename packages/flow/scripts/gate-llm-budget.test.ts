/**
 * Defekt 4 (Woche 16.–23.10.2026): 12 Timeouts (`llm_fehler: "timeout"`) bei
 * 88 LLM-Urteilen = 13,6 %. Gemessen aus dem Ledger:
 *   - erfolgreiche Urteile: 76, p50 2387 ms, p90 3371 ms, Maximum 4489 ms —
 *     KEIN Erfolg über 6000 ms; die Timeouts enden bei 6003–6013 ms.
 *     Eine längere Frist hätte also nichts gerettet: die Anfrage hängt.
 *   - die Timeouts liegen vereinzelt (9 von 12 ohne Nachbar-Timeout), meist
 *     nach einer Pause ≥ 10 min — ein zweiter, unabhängiger Versuch trifft
 *     dann mit hoher Wahrscheinlichkeit einen antwortenden Weg.
 *
 * Budget (VOR dem Bau festgelegt):
 *   Gesamtfrist bleibt 6000 ms (Plugin wartet 6500 ms). Ist nach
 *   LLM_HEDGE_MS = 3000 ms keine Antwort da, startet EIN paralleler zweiter
 *   Versuch; das erste gültige Urteil gewinnt. Zielwerte, aus den 88 Messungen
 *   unter Unabhängigkeit gerechnet (Test „Budget-Rechnung"):
 *     Timeout-Anteil ≤ 5 %    (Modell 4,5 %; Basis 13,6 %)
 *     Zusatzaufrufe   ≤ 35 %   (Modell 33 % der LLM-Urteile)
 *     Wartezeit Hook  ≤ 6,0 s  (vorher bis ~9 s: Plugin-Retry nach Timeout)
 *   Hedge bei 2500 ms brächte 2,9 % für 53 % Zusatzaufrufe, bei 3500 ms 7,3 %
 *   — 3000 ms ist der Punkt, an dem beide Ziele halten.
 * Rückfall: kein Urteil → deterministisches Verdikt (Wortregel-Grauzone,
 * injizieren:false) mit `rueckfall: "deterministisch"` und Grund im Ledger.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { entscheide, LLM_HEDGE_MS, LLM_TIMEOUT_MS, urteileMitLlmDetail } from "./of-gate"

const TMP = mkdtempSync(join(tmpdir(), "gate-llm-budget-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "k\n")
const GRAU = "Bau eine Testsuite für befehl.ts und eine zweite für rm-gefahr.ts, unabhängig voneinander."

const antwort = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } })
/** fetch, das je Aufruf ein Verhalten nimmt: "haengt" bis Abbruch, sonst [ms, Inhalt]. */
function skript(verhalten: ("haengt" | [number, string])[]) {
  let n = 0
  const f = ((_url: any, init: any) => {
    const v = verhalten[n++] ?? "haengt"
    return new Promise<Response>((resolve, reject) => {
      const abbruch = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (init?.signal?.aborted) return abbruch()
      init?.signal?.addEventListener("abort", abbruch)
      if (v !== "haengt") setTimeout(() => resolve(antwort(v[1])), v[0])
    })
  }) as unknown as typeof fetch
  return { f, aufrufe: () => n }
}

// 76 erfolgreiche Urteile (ms) und 12 Timeouts, ~/.openflow/gate-ledger.jsonl 16.–23.10.2026
const ERFOLG_MS = [2711, 1692, 1820, 3078, 2089, 1831, 2897, 2237, 2086, 2740, 2074, 4371, 2251, 1468, 2726, 1660, 3675, 1964, 1890, 1727, 1981, 1930, 1847, 2635, 2118, 1764, 1925, 2387, 2911, 2801, 2248, 2166, 2231, 2023, 2684, 1802, 2229, 3293, 3083, 2595, 3813, 2524, 2346, 2522, 2852, 2728, 3269, 3772, 3281, 3371, 3735, 3121, 3597, 2471, 2730, 3212, 2807, 2735, 3136, 3233, 2163, 2506, 2309, 2222, 2135, 1877, 1955, 2218, 1908, 2162, 2088, 4489, 2479, 2770, 2173, 2084]
const TIMEOUTS = 12

describe("Budget-Rechnung (vorher festgelegte Zielwerte)", () => {
  const p = TIMEOUTS / (TIMEOUTS + ERFOLG_MS.length)
  const ueber = (ms: number) => ERFOLG_MS.filter((x) => x > ms).length / ERFOLG_MS.length
  test("Basis: Timeout-Anteil 13,6 %", () => expect(+(p * 100).toFixed(1)).toBe(13.6))
  test("Frist und Hedge stehen auf 6000/3000 ms", () => {
    expect(LLM_TIMEOUT_MS).toBe(6000)
    expect(LLM_HEDGE_MS).toBe(3000)
  })
  test("mit Hedge: Timeout-Anteil ≤ 5 %, Zusatzaufrufe ≤ 35 %", () => {
    // Fehlschlag = erster hängt UND zweiter (Restzeit Frist − Hedge) antwortet nicht rechtzeitig
    const fehl = p * (p + (1 - p) * ueber(LLM_TIMEOUT_MS - LLM_HEDGE_MS))
    const zusatz = p + (1 - p) * ueber(LLM_HEDGE_MS)
    expect(fehl).toBeLessThanOrEqual(0.05)
    expect(zusatz).toBeLessThanOrEqual(0.35)
    // Kontrollwert: ohne Hedge bleibt es bei der Basis
    expect(p).toBeGreaterThan(0.12)
  })
})

describe("Hedge: zweiter Versuch nach LLM_HEDGE_MS, erstes Urteil gewinnt", () => {
  test("erster hängt, zweiter antwortet → Urteil statt Timeout, 2 Versuche", async () => {
    const s = skript(["haengt", [20, "JA"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(true)
    expect(d.fehler).toBeNull()
    expect(d.versuche).toBe(2)
    expect(d.ms).toBeLessThan(400)
  })
  test("schnelle Antwort → KEIN zweiter Aufruf", async () => {
    const s = skript([[10, "NEIN"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(false)
    expect(d.versuche).toBe(1)
    await Bun.sleep(150)
    expect(s.aufrufe()).toBe(1)
  })
  test("beide hängen → timeout innerhalb der Gesamtfrist", async () => {
    const s = skript(["haengt", "haengt"])
    const t0 = Date.now()
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 300, hedgeMs: 100 })
    expect(d.urteil).toBeNull()
    expect(d.fehler).toBe("timeout")
    expect(Date.now() - t0).toBeLessThan(450)
    expect(s.aufrufe()).toBe(2)
  })
  test("erster liefert Unklares, zweiter (gehedgt) JA → JA", async () => {
    const s = skript([[150, "vielleicht"], [10, "JA"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(true)
  })
})

describe("deterministischer Rückfall mit Grund", () => {
  test("Timeout → Wortregel-Verdikt, rueckfall + rueckfall_grund gesetzt, keine Injektion", async () => {
    const s = skript(["haengt", "haengt"])
    const v: any = await entscheide(GRAU, { fetch: s.f, keyFile: KEY, timeoutMs: 200, hedgeMs: 50 })
    expect(v.entscheidung).toBe("GRAUZONE")
    expect(v.injizieren).toBe(false)
    expect(v.llm_fehler).toBe("timeout")
    expect(v.rueckfall).toBe("deterministisch")
    expect(v.rueckfall_grund).toBe("llm_timeout")
    expect(v.llm_versuche).toBe(2)
  })
  test("fehlender Schlüssel → rueckfall_grund llm_schluessel_fehlt", async () => {
    const v: any = await entscheide(GRAU, { keyFile: join(TMP, "gibt-es-nicht") })
    expect(v.rueckfall).toBe("deterministisch")
    expect(v.rueckfall_grund).toBe("llm_schluessel_fehlt")
  })
  test("Kontrollwert: LLM-Urteil → kein rueckfall-Feld", async () => {
    const v: any = await entscheide(GRAU, { fetch: skript([[5, "NEIN"]]).f, keyFile: KEY, timeoutMs: 300, hedgeMs: 100 })
    expect(v.llm).toBe(false)
    expect(v.rueckfall).toBeUndefined()
  })
})

describe("Scorecard zeigt den Timeout-Anteil je Fenster", () => {
  test("2 Timeouts von 4 Urteilen → 50 %, Rückfälle und Zweitversuche gezählt", () => {
    const { mkdirSync } = require("node:fs")
    const jetzt = new Date().toISOString()
    const z = (x: Record<string, unknown>) => JSON.stringify({ ts: jetzt, event: "user_prompt", entscheidung: "GRAUZONE", ...x })
    const ledger = join(TMP, "l.jsonl")
    writeFileSync(ledger, [
      z({ llm: true, llm_ms: 2000 }),
      z({ llm: false, llm_ms: 3500, llm_versuche: 2 }),
      z({ llm: null, llm_fehler: "timeout", llm_versuche: 2, rueckfall: "deterministisch" }),
      z({ llm: null, llm_fehler: "timeout" }),
      z({ llm: null, llm_uebersprungen: "kurz" }),
    ].join("\n") + "\n")
    mkdirSync(join(TMP, "runs"), { recursive: true })
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-scorecard.ts"), "--runs-dir", join(TMP, "runs"), "--ledger", ledger, "--json"], { stdout: "pipe" })
    const g = JSON.parse(p.stdout.toString()).ledger.gateLlm.find((x: any) => x.name === "gesamt")
    expect(g).toMatchObject({ urteile: 4, timeouts: 2, timeoutQuote: 50, rueckfaelle: 1, zweitversuche: 2 })
  })
})
