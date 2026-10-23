/**
 * woche.ts, bench.ts, wecken.ts, live.ts — die Auswertungen gegen eine
 * gebaute opencode.db im Speicher (gleiches Schema wie session_v2 /
 * session_message, nur die gelesenen Spalten). Kein Netz, kein Dienst.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUFGABEN, bewerteLauf } from "./bench"
import { abnahmeTitel, kontrollwerteImSchluss } from "./live"
import { CODE_A, CODE_B, bewerteWecken } from "./wecken"
import { auswertungAutoResume, auswertungAutonomie, auswertungOpencode, dharmaAusAe, dharmaAusD1, fensterAus } from "./woche"

const F = fensterAus("2026-10-16", "2026-10-17")
const T = F.von + 3_600_000

function baueDb() {
  const db = new Database(":memory:")
  db.run("create table session_v2 (id text primary key, parent_id text, directory text, title text, agent text, time_created integer)")
  db.run("create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text)")
  let seq = 0
  const s = (id: string, o: { parent?: string; dir?: string; title?: string; agent?: string; t?: number }) =>
    db.run("insert into session_v2 values (?,?,?,?,?,?)", [id, o.parent ?? null, o.dir ?? "/home/t/workspace/x", o.title ?? "", o.agent ?? "build", o.t ?? T])
  const m = (sid: string, type: string, data: object, t = T) =>
    db.run("insert into session_message values (?,?,?,?,?,?)", [`m${++seq}`, sid, type, seq, t, JSON.stringify(data)])
  const tool = (name: string, input: object, status = "completed") => ({ type: "tool", name, state: { status, input } })
  const assistant = (provider: string, content: object[], extra: object = {}) => ({
    model: { providerID: provider, id: "power" },
    time: { created: T, completed: T + 4000 },
    content,
    ...extra,
  })

  // Feld-Hauptfaden mit einem Hintergrund-Fan-out und einer Warte-Abfrage
  s("ses_feld", {})
  m("ses_feld", "user", { text: "los" })
  m("ses_feld", "assistant", assistant("dharma", [tool("subagent", { background: true }), tool("subagent", { background: true })]))
  m("ses_feld", "assistant", assistant("dharma", [tool("shell", { command: "sleep 30" })]))
  m("ses_feld", "user", { text: "weiter" })
  m("ses_feld", "assistant", assistant("zai", [tool("shell", { command: "npm test" }), tool("shell", { command: "npm run build" }, "error")], { error: { type: "aborted", message: "Step interrupted" } }))
  // Kind des Feld-Hauptfadens
  s("ses_kind", { parent: "ses_feld", agent: "general" })
  m("ses_kind", "assistant", assistant("dharma", [tool("read", {})]))
  // Abnahme-live mit Kind — ausgeschlossen, aber in GESAMT
  s("ses_abn", { title: "abnahme-live W1" })
  m("ses_abn", "assistant", assistant("dharma", [tool("subagent", {}), tool("subagent", {})]))
  s("ses_abnkind", { parent: "ses_abn", agent: "general" })
  m("ses_abnkind", "assistant", assistant("dharma", []))
  // Benchmark-Lauf
  s("ses_bench", { dir: "/home/t/OpenFlow/packages/flow/bench/laeufe/B1-dharma_power-1" })
  m("ses_bench", "assistant", assistant("dharma", []))
  // ausserhalb des Fensters
  s("ses_alt", { t: F.von - 1 })
  m("ses_alt", "assistant", assistant("dharma", []), F.von - 1)
  return db
}

describe("fensterAus", () => {
  it("bis ist der letzte Tag einschließlich", () => {
    const f = fensterAus("2026-10-16", "2026-10-23")
    expect(new Date(f.bis).toISOString()).toBe("2026-10-24T00:00:00.000Z")
    expect(f.bisTag).toBe("2026-10-24")
    expect(() => fensterAus("2026-10-23", "2026-10-16")).toThrow()
  })
})

describe("auswertungOpencode", () => {
  const r = auswertungOpencode(baueDb(), F)
  it("GESAMT zählt alles im Fenster (vergleichbar mit der Auswertung vom 23.10.)", () => {
    expect(r.gesamt.sitzungen).toBe(5)
    expect(r.gesamt.hauptfaden).toBe(3)
    expect(r.gesamt.sub).toBe(2)
    expect(r.gesamt.assistant_nachrichten).toBe(7)
    expect(r.gesamt.modellfehler).toBe(1)
    expect(r.gesamt.tool_aufrufe).toBe(8)
    expect(r.gesamt.tool_fehler).toBe(1)
    expect(r.gesamt.dharma_pct).toBe(85.7)
    expect(r.gesamt.nutzer_nachrichten).toBe(2)
  })
  it("FELD lässt Abnahme (samt Kind) und Benchmark weg und zählt sie getrennt", () => {
    expect(r.feld.sitzungen).toBe(2)
    expect(r.feld.assistant_nachrichten).toBe(4)
    expect(r.ausgeschlossen).toEqual({ "abnahme-live": { sitzungen: 2, assistant: 2 }, benchmark: { sitzungen: 1, assistant: 1 } })
  })
  it("Latenz je Modell aus time.completed − time.created", () => {
    expect(r.gesamt.modelle.find((x) => x.modell === "dharma/power")?.p50_s).toBe(4)
  })
})

describe("auswertungAutonomie", () => {
  const a = auswertungAutonomie(baueDb(), F)
  it("nur Feld-Hauptfäden; Abnahme und Benchmark getrennt gezählt", () => {
    expect(a.sitzungen).toBe(1)
    expect(a.ausgeschlossen).toEqual({ "abnahme-live": 1, benchmark: 1 })
  })
  it("Fan-outs, Hintergrund-Anteil, Warte-Abfragen, Nutzer-Nachrichten", () => {
    expect(a.je_sitzung[0]).toMatchObject({ id: "ses_feld", nutzer: 2, fanouts: 2, fanouts_bg: 1, warte_abfragen: 1, arbeitsaufrufe: 4 })
    expect(a.fanouts_bg_pct).toBe(50)
  })
})

describe("auswertungAutoResume", () => {
  it("ses_test*-Zeilen fallen heraus und werden gezählt", () => {
    const z = [
      JSON.stringify({ ts: "2026-10-16T05:00:00Z", event: "resume", sessionID: "ses_echt1", parent: "ses_p" }),
      JSON.stringify({ ts: "2026-10-16T05:00:01Z", event: "resume_ende", ergebnis: "ok", sessionID: "ses_echt1" }),
      JSON.stringify({ ts: "2026-10-16T06:00:00Z", event: "resume_ende", ergebnis: "ok", sessionID: "ses_testende1", parent: "ses_parent1" }),
      JSON.stringify({ ts: "2026-10-18T06:00:00Z", event: "resume", sessionID: "ses_spaeter" }),
      "kaputt",
    ]
    expect(auswertungAutoResume(z, F)).toEqual({ ereignisse: { resume: 1, "resume_ende:ok": 1 }, test_zeilen_ausgeschlossen: 1 })
  })
})

describe("dharma-Auswertung (reine Rechnung)", () => {
  it("AE: Fehlversuche = alles außer ok", () => {
    const r = dharmaAusAe([
      { anbieter: "zai", ausgang: "ok", n: "90" },
      { anbieter: "zai", ausgang: "fail", n: "6" },
      { anbieter: "go", ausgang: "auth_fail", n: 4 },
    ])
    expect(r).toMatchObject({ anfragen: 100, fehlversuche: 10, fehlversuche_pct: 10 })
  })
  it("D1: Failover = versuch > 1", () => {
    const r = dharmaAusD1([
      { provider: "zai", versuch: 1, ttfb_ms: 100, total_ms: 200 },
      { provider: "zai", versuch: 2, ttfb_ms: 300, total_ms: 400 },
      { provider: "yolo", versuch: null, ttfb_ms: null, total_ms: 50 },
    ])
    expect(r).toMatchObject({ anfragen: 3, failover: 1, ttfb_gemessen: 2 })
    expect(r.je_anbieter[0]).toMatchObject({ anbieter: "zai", n: 2, ttfb_p50: 300, versuch_gt1: 1 })
  })
})

describe("bench.bewerteLauf", () => {
  const tool = (command: string, background = false) => ({ type: "tool", name: "shell", state: { input: { command, background } } })
  it("Hintergrund-Fan-out mit richtiger Tabelle", () => {
    const ms = [
      { type: "user" },
      { type: "assistant", content: [tool("cd alpha && ./pruefe.sh", true), tool("cd beta && ./pruefe.sh", true), tool("cd gamma && ./pruefe.sh", true)] },
      { type: "synthetic" },
      { type: "assistant", content: [{ type: "text", text: "| alpha | A-4417 | 3 |\n| beta | B-9062 | 5 |\n| gamma | G-1385 | 2 |" }] },
    ]
    expect(bewerteLauf("B1", ms, null)).toMatchObject({ arbeitsaufrufe: 3, davon_bg: 3, fanouts_bg: 1, sleep_poll: 0, alle_korrekt: true, synthetic: 1 })
  })
  it("B2: ein misslungener Fix macht den Lauf falsch, auch bei richtigen Codes", () => {
    const ms = [{ type: "assistant", content: [{ type: "text", text: "D-7720 A-4417 B-9062 G-1385" }] }]
    expect(bewerteLauf("B2", ms, false).alle_korrekt).toBe(false)
    expect(bewerteLauf("B2", ms, true).alle_korrekt).toBe(true)
  })
})

describe("wecken.bewerteWecken", () => {
  const a = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] })
  it("bestanden: WARTE, dann synthetic, dann FERTIG mit beiden Codes", () => {
    const r = bewerteWecken([{ type: "user" }, a("WARTE AUF 2"), { type: "idle" }, { type: "synthetic" }, a(`FERTIG ${CODE_A} ${CODE_B}`)])
    expect(r).toMatchObject({ fertig_nach_wecken: true, fertig_vorweg: false, warte_gesagt: true, synthetic: 1, assistant_nach_synthetic: 1 })
  })
  it("nicht bestanden: FERTIG vor der Fertig-Meldung (gewartet statt geweckt)", () => {
    const r = bewerteWecken([{ type: "user" }, a(`FERTIG ${CODE_A} ${CODE_B}`)])
    expect(r).toMatchObject({ fertig_nach_wecken: false, fertig_vorweg: true })
  })
})

describe("live", () => {
  it("Titel beginnt immer mit abnahme-live — sonst zählt woche.ts die Abnahme ins Feld", () => {
    expect(abnahmeTitel("W1 23.10.")).toBe("abnahme-live W1 23.10.")
    expect(abnahmeTitel("abnahme-live X")).toBe("abnahme-live X")
    expect(abnahmeTitel(undefined, new Date("2026-10-23T10:00:00Z"))).toBe("abnahme-live 2026-10-23")
  })
  it("Kontrollwerte im Schlussbericht", () => {
    const ms = [{ type: "assistant", content: [{ type: "text", text: "früher 9.200.0" }] }, { type: "assistant", content: [{ type: "text", text: "dharma 0.4.2" }] }]
    expect(kontrollwerteImSchluss(ms, ["0.4.2", "9.200.0"])).toEqual({ "0.4.2": true, "9.200.0": false })
  })
})

describe("fixture.sh trägt dieselben Sollwerte wie AUFGABEN", () => {
  it.skipIf(process.platform === "win32")("TODO-Zahlen und ERGEBNIS-Codes", () => {
    const t = mkdtempSync(join(tmpdir(), "bench-fixture-"))
    const ziel = join(t, "repo")
    try {
      const r = spawnSync("bash", [join(import.meta.dir, "fixture.sh"), ziel], { encoding: "utf8" })
      expect(r.status).toBe(0)
      const soll = Object.values(AUFGABEN).flatMap((a) => Object.entries(a.soll))
      expect(soll.filter(([, [, todo]]) => todo !== null).length).toBe(3)
      for (const [paket, [code, todo]] of soll) {
        expect(readFileSync(join(ziel, paket, "pruefe.sh"), "utf8")).toContain(code)
        if (todo === null) continue
        const zeilen = readdirSync(join(ziel, paket, "src")).flatMap((d) => readFileSync(join(ziel, paket, "src", d), "utf8").split("\n"))
        expect(zeilen.filter((z) => z.includes("TODO")).length).toBe(todo)
      }
    } finally {
      rmSync(t, { recursive: true, force: true })
    }
  })
})
