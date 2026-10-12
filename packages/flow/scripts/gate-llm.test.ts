/**
 * K2e (13.10.2026, Abnahme R16): LLM-Urteiler in der Grauzone + Nein-Signal-Vorrang.
 * fetch ist gemockt — kein Netz, kein echter Schlüssel (temporäre Schlüsseldatei).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classify, entscheide, LLM_PROMPT, parseLlmAntwort, urteileMitLlm, urteileMitLlmDetail } from "./of-gate"

const TMP = mkdtempSync(join(tmpdir(), "of-gate-llm-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "test-schluessel\n")
const FUSS = "\n\n⎯⎯ gemini-3-flash · fast · antigravity ⎯⎯\n"

function antwort(content: unknown, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "content-type": "application/json" } })
}
function mock(fn: (url: string, init: any) => Promise<Response> | Response) {
  const calls: { url: string; init: any }[] = []
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return fn(String(url), init)
  }) as unknown as typeof fetch
  return { f, calls }
}

// Grauzone nach der Wortregel (kein belegter Auftrag, kein Nein-Signal).
const GRAU = "Bau eine Testsuite für befehl.ts und eine zweite für rm-gefahr.ts, unabhängig voneinander."

describe("urteileMitLlm", () => {
  test("JA → true; Anfrage: fast, temperature 0, max_tokens ≥ 64, neutraler Prompt, UA, Schlüssel nur im Header", async () => {
    const { f, calls } = mock(() => antwort("JA"))
    expect(await urteileMitLlm("Auftrag X", { fetch: f, keyFile: KEY })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://dharma.mcp-hub.stream/v1/chat/completions")
    const body = JSON.parse(calls[0].init.body)
    expect(body.model).toBe("fast")
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBeGreaterThanOrEqual(64)
    expect(body.messages[0].content).toBe(LLM_PROMPT + "Auftrag X")
    expect(body.messages[0].content).not.toContain("Im Zweifel")
    expect(calls[0].init.headers.Authorization).toBe("Bearer test-schluessel")
    expect(calls[0].init.headers["User-Agent"]).toMatch(/of-gate/)
    expect(calls[0].init.body).not.toContain("test-schluessel")
  })

  test("NEIN → false", async () => {
    const { f } = mock(() => antwort("NEIN"))
    expect(await urteileMitLlm("x", { fetch: f, keyFile: KEY })).toBe(false)
  })

  test("dharma-Fußzeile wird abgeschnitten (JA/NEIN mit ⎯⎯ … ⎯⎯)", async () => {
    expect(await urteileMitLlm("x", { fetch: mock(() => antwort("JA" + FUSS)).f, keyFile: KEY })).toBe(true)
    expect(await urteileMitLlm("x", { fetch: mock(() => antwort("\n\nNEIN" + FUSS)).f, keyFile: KEY })).toBe(false)
    // nur Fußzeile = kein Urteil
    expect(await urteileMitLlm("x", { fetch: mock(() => antwort(FUSS)).f, keyFile: KEY })).toBeNull()
  })

  test("Zeitüberschreitung → null (fehler timeout), bricht an der Frist ab", async () => {
    const { f } = mock(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(init.signal.reason))
        }),
    )
    const d = await urteileMitLlmDetail("x", { fetch: f, keyFile: KEY, timeoutMs: 50 })
    expect(d.urteil).toBeNull()
    expect(d.fehler).toBe("timeout")
    expect(d.ms).toBeLessThan(1000)
  })

  test("5xx → null (fehler http_502)", async () => {
    const d = await urteileMitLlmDetail("x", { fetch: mock(() => antwort("JA", 502)).f, keyFile: KEY })
    expect(d).toMatchObject({ urteil: null, fehler: "http_502" })
  })

  test("leere Antwort / null-Inhalt → null", async () => {
    expect(await urteileMitLlmDetail("x", { fetch: mock(() => antwort("")).f, keyFile: KEY })).toMatchObject({ urteil: null, fehler: "leer" })
    expect(await urteileMitLlmDetail("x", { fetch: mock(() => antwort(null)).f, keyFile: KEY })).toMatchObject({ urteil: null, fehler: "leer" })
  })

  test("unklare Antwort, Netzfehler, fehlender Schlüssel → null", async () => {
    expect(await urteileMitLlmDetail("x", { fetch: mock(() => antwort("Vielleicht")).f, keyFile: KEY })).toMatchObject({ urteil: null, fehler: "unklar" })
    expect(
      await urteileMitLlmDetail("x", {
        fetch: mock(() => {
          throw new TypeError("fetch failed")
        }).f,
        keyFile: KEY,
      }),
    ).toMatchObject({ urteil: null, fehler: "netz" })
    const { f, calls } = mock(() => antwort("JA"))
    expect(await urteileMitLlmDetail("x", { fetch: f, keyFile: join(TMP, "gibt-es-nicht") })).toMatchObject({ urteil: null, fehler: "schluessel_fehlt" })
    expect(calls).toHaveLength(0)
  })

  test("parseLlmAntwort: Markdown, Satzzeichen, think-Block; JANEIN/JAHR sind kein Urteil", () => {
    expect(parseLlmAntwort("**JA**")).toBe(true)
    expect(parseLlmAntwort("nein.")).toBe(false)
    expect(parseLlmAntwort("<think>JA oder NEIN?</think>\nNEIN")).toBe(false)
    expect(parseLlmAntwort("JAHR")).toBeNull()
    expect(parseLlmAntwort(undefined)).toBeNull()
  })
})

describe("entscheide — kombinierte Regel an EINER Stelle", () => {
  test("Grauzone + LLM JA → FABRIK, injizieren, llm true, llm_ms gesetzt", async () => {
    expect(classify(GRAU).entscheidung).toBe("GRAUZONE")
    const { f, calls } = mock(() => antwort("JA" + FUSS))
    const v = await entscheide(GRAU, { fetch: f, keyFile: KEY })
    expect(calls).toHaveLength(1)
    expect(v).toMatchObject({ entscheidung: "FABRIK", injizieren: true, llm: true, llm_fehler: null })
    expect(typeof v.llm_ms).toBe("number")
  })

  test("Grauzone + LLM NEIN → keine Injektion, llm false", async () => {
    const v = await entscheide(GRAU, { fetch: mock(() => antwort("NEIN")).f, keyFile: KEY })
    expect(v).toMatchObject({ entscheidung: "GRAUZONE", injizieren: false, llm: false })
  })

  test("Grauzone + LLM-Fehler → keine Injektion, llm null, Fehlergrund im Ergebnis", async () => {
    const v = await entscheide(GRAU, { fetch: mock(() => antwort("", 503)).f, keyFile: KEY })
    expect(v).toMatchObject({ entscheidung: "GRAUZONE", injizieren: false, llm: null, llm_fehler: "http_503" })
  })

  test("Wortregel-FABRIK → injizieren OHNE LLM-Aufruf", async () => {
    const t = "Recherchiere getrennt, wie Navidrome, Jellyfin und Plex die Bibliothek indexieren, und fass jeden in einem eigenen Abschnitt zusammen."
    const { f, calls } = mock(() => antwort("NEIN"))
    const v = await entscheide(t, { fetch: f, keyFile: KEY })
    expect(calls).toHaveLength(0)
    expect(v).toMatchObject({ entscheidung: "FABRIK", injizieren: true, llm: null, llm_ms: null })
  })

  // Nein-Signal-Vorrang: DIREKT ruft nie das LLM, auch wenn es JA sagen würde.
  const NEIN_FAELLE: [string, string][] = [
    ["Lösche die Branches k2a, k2b und k2c lokal und auf origin und erstelle eine Liste der gelöschten SHAs.", "loeschen"],
    ["Deploye dharma, thoth und merkspur nacheinander auf Produktion und schreib mir je Worker die Versionsnummer.", "deploy"],
    ["Rotiere die Secrets von dharma, rille und thoth und schreib je Worker einen Bericht.", "secrets"],
    ["Prüfe die Abrechnung bei Stripe für alle 5 Anbieter und erstelle je Anbieter eine Tabelle.", "geldpfad"],
    ["delete the stale branches feat-a, feat-b and feat-c and write a report for each", "loeschen"],
  ]
  for (const [t, signal] of NEIN_FAELLE) {
    test(`Nein-Signal ${signal} hat Vorrang: ${t.slice(0, 50)}…`, async () => {
      const { f, calls } = mock(() => antwort("JA"))
      const v = await entscheide(t, { fetch: f, keyFile: KEY })
      expect(calls).toHaveLength(0)
      expect(v.entscheidung).toBe("DIREKT")
      expect(v.injizieren).toBe(false)
      expect(v.signale).toContain(signal)
      expect(v.llm).toBeNull()
    })
  }

  test("Löschen-Signal greift nicht bei Kompositum/Partizip (Löschberichte, gelöscht)", () => {
    expect(classify("Analysiere die Löschberichte von merkspur").signale).not.toContain("loeschen")
    expect(classify("Warum wurde der Branch gelöscht?").signale).not.toContain("loeschen")
  })

  test("direkt:-Prefix → kein LLM", async () => {
    const { f, calls } = mock(() => antwort("JA"))
    const v = await entscheide("direkt: " + GRAU, { fetch: f, keyFile: KEY })
    expect(calls).toHaveLength(0)
    expect(v.injizieren).toBe(false)
  })

  test("LLM sieht nur den Nutzertext, nicht angehängte Guard-Blöcke", async () => {
    const { f, calls } = mock(() => antwort("NEIN"))
    await entscheide(GRAU + "\n[Guard: TASK-VERTRAG] RÜCKFRAGEN: keine", { fetch: f, keyFile: KEY })
    expect(JSON.parse(calls[0].init.body).messages[0].content).toBe(LLM_PROMPT + GRAU)
  })
})
