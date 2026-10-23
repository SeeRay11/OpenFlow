/**
 * Defekt 2 (Woche 16.–23.10.2026): Regeltreue war nicht messbar — das Ledger
 * kannte weder „befolgt"/„abgewichen" noch eine Begründung; die Loop-Sonde
 * meldete eine absolute Zahl (`I3-regeltreue: 5/18`), 16 von 37 FABRIK-
 * Empfehlungen blieben ohne fabrik_run, ohne dass man sah, warum.
 *
 * Jetzt löst of-regeltreue.ts JEDE FABRIK-Empfehlung auf; Scorecard, Digest
 * und Loop zeigen eine QUOTE je Fenster. Fälle: gate-ledger-feldfaelle.ts.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loeseAuf, regeltreueJeFenster, REGELTREUE_FENSTER_MS } from "./of-regeltreue"
import { EMPFEHLUNGEN_WOCHE, FABRIK_RUN_ZEILEN } from "./gate-ledger-feldfaelle"
import { runDailyDigest } from "./of-digest"
import { computeI3 } from "./of-loop-logik"

const TMP = mkdtempSync(join(tmpdir(), "regeltreue-"))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
const MIN = 60_000
const NOW = Date.parse("2026-10-23T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()
const WOCHE = [...EMPFEHLUNGEN_WOCHE, ...FABRIK_RUN_ZEILEN.map((z) => z.eintrag)]

const empf = (ts: number, session: string, extra: Record<string, unknown> = {}) => ({
  ts: iso(ts), event: "user_prompt", session_id: session, entscheidung: "FABRIK", injiziert: true, task: "t", ...extra,
})

describe("loeseAuf — jede FABRIK-Empfehlung bekommt einen Ausgang", () => {
  test("Feldfälle: ses_C befolgt (Fabrik), ses_B ohne Begründung, ses_A nie zugestellt", () => {
    const a = loeseAuf(WOCHE, NOW)
    const st = Object.fromEntries(a.map((x) => [x.session_id, x.status]))
    expect(st).toEqual({ ses_C: "befolgt_fabrik", ses_B: "abgewichen_ohne_begruendung", ses_A: "nicht_zugestellt" })
  })

  test("Monitoring-Sonden derselben Session gelten NICHT als Befolgung", () => {
    const t = NOW - 2 * 60 * MIN
    const a = loeseAuf([empf(t, "s1"), { ts: iso(t + MIN), event: "fabrik_run", session_id: "s1", command: "bash of-run.sh --scorecard", monitoring: true }], NOW)
    expect(a[0].status).toBe("abgewichen_ohne_begruendung")
  })

  test("Abweichung mit Begründung (event abweichung, gleiche Session)", () => {
    const t = NOW - 2 * 60 * MIN
    const a = loeseAuf([empf(t, "s1"), { ts: iso(t + 2 * MIN), event: "abweichung", session_id: "s1", grund: "Geldpfad: Deploy" }], NOW)
    expect(a[0].status).toBe("abgewichen_begruendet")
    expect(a[0].grund).toBe("Geldpfad: Deploy")
  })

  test("Stufe 1: subagent-Aufruf derselben Session → befolgt_subagent", () => {
    const t = NOW - 2 * 60 * MIN
    const a = loeseAuf([empf(t, "s1"), { ts: iso(t + MIN), event: "task", quelle: "subagent", session_id: "s1", entscheidung: "GRAUZONE", injiziert: false }], NOW)
    expect(a[0].status).toBe("befolgt_subagent")
  })

  test("task-Empfehlung: Fabrik-Start aus der KIND-Session (task_kind) → befolgt_fabrik", () => {
    const t = NOW - 2 * 60 * MIN
    const a = loeseAuf([
      { ts: iso(t), event: "task", quelle: "subagent", session_id: "eltern", gate_id: "g1", entscheidung: "FABRIK", injiziert: true },
      { ts: iso(t + 5 * MIN), event: "task_kind", gate_id: "g1", kind_session: "kind" },
      { ts: iso(t + 3 * MIN), event: "fabrik_run", art: "start", session_id: "kind", command: "bash of-run.sh auto-orchestrator x" },
    ], NOW)
    expect(a[0].status).toBe("befolgt_fabrik")
  })

  test("ein Start deckt höchstens EINE Empfehlung (1:1)", () => {
    const t = NOW - 3 * 60 * MIN
    const a = loeseAuf([empf(t, "s1"), empf(t + MIN, "s1"), { ts: iso(t + 2 * MIN), event: "fabrik_run", art: "start", session_id: "s1" }], NOW)
    expect(a.map((x) => x.status)).toEqual(["befolgt_fabrik", "abgewichen_ohne_begruendung"])
  })

  test("Start NACH dem Fenster zählt nicht; jüngere Empfehlung bleibt offen", () => {
    const t = NOW - 3 * 60 * MIN
    const a = loeseAuf([empf(t, "s1"), { ts: iso(t + REGELTREUE_FENSTER_MS + MIN), event: "fabrik_run", art: "start", session_id: "s1" }, empf(NOW - 5 * MIN, "s2")], NOW)
    expect(a.map((x) => x.status)).toEqual(["abgewichen_ohne_begruendung", "offen"])
  })
})

describe("regeltreueJeFenster — Quote statt absoluter Zahl", () => {
  test("Feldfälle: gesamt 1 von 2 aufgelösten = 50 %, nicht zugestellte außerhalb der Quote", () => {
    const f = regeltreueJeFenster(loeseAuf(WOCHE, NOW), NOW)
    const gesamt = f.find((x) => x.name === "gesamt")!
    expect(gesamt).toMatchObject({ empfehlungen: 3, nicht_zugestellt: 1, aufgeloest: 2, befolgt_fabrik: 1, ohne_begruendung: 1, quote: 50 })
    expect(f.map((x) => x.name)).toEqual(["24 h", "7 Tage", "gesamt"])
    expect(f.find((x) => x.name === "24 h")!.quote).toBeNull() // keine Empfehlung im 24-h-Fenster
  })
})

describe("Anzeige: Scorecard, Digest und Loop tragen die Quote", () => {
  const ledger = join(TMP, "ledger.jsonl")
  writeFileSync(ledger, WOCHE.map((e) => JSON.stringify(e)).join("\n") + "\n")

  test("Scorecard --json: ledger.regeltreue je Fenster", () => {
    const runs = join(TMP, "runs")
    mkdirSync(runs, { recursive: true })
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-scorecard.ts"), "--runs-dir", runs, "--ledger", ledger, "--json"], { stdout: "pipe", stderr: "pipe" })
    const j = JSON.parse(p.stdout.toString())
    const gesamt = j.ledger.regeltreue.find((x: any) => x.name === "gesamt")
    expect(gesamt.quote).toBe(50)
  })

  test("Scorecard Text: Zeile „Regeltreue gesamt“ mit Quote", () => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-scorecard.ts"), "--runs-dir", join(TMP, "runs"), "--ledger", ledger], { stdout: "pipe" })
    expect(p.stdout.toString()).toMatch(/Regeltreue gesamt \| 1\/2 \(50 %\)/)
  })

  test("Digest: Quote-Zeile in Datei und Konsolenzeile", () => {
    const dir = join(TMP, "digest")
    const r = runDailyDigest(dir, ledger, new Date(NOW))!
    expect(r.zeile).toMatch(/Regeltreue 7 Tage: 1\/2 \(50 %\)/)
    const datei = readFileSync(r.datei, "utf8")
    expect(datei).toContain("ses_B")
    expect(datei).toMatch(/abgewichen_ohne_begruendung/)
  })

  test("I3: Quote aus der Auflösung (1/2), Alert bei < 50 % ab 3 aufgelösten", () => {
    const i3 = computeI3(WOCHE, NOW)
    expect(i3.kandidaten).toBe(2)
    expect(i3.matches).toBe(1)
    expect(i3.bewertet).toBe(false)
  })
})

describe("of-gate.ts abweichung — Begründung landet mit Session im Ledger", () => {
  test("OPENFLOW_SESSION wird mitgeschrieben", () => {
    const l = join(TMP, "abw.jsonl")
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-gate.ts"), "abweichung", "Deploy ist Nein-Fall"], {
      env: { ...process.env, OPENFLOW_LEDGER: l, OPENFLOW_SESSION: "ses_X" }, stdout: "pipe", stderr: "pipe",
    })
    expect(p.exitCode).toBe(0)
    expect(existsSync(l)).toBe(true)
    const z = JSON.parse(readFileSync(l, "utf8").trim())
    expect(z).toMatchObject({ event: "abweichung", session_id: "ses_X", grund: "Deploy ist Nein-Fall" })
  })
  test("ohne Begründung: Exit 2, nichts geschrieben", () => {
    const l = join(TMP, "abw2.jsonl")
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-gate.ts"), "abweichung"], { env: { ...process.env, OPENFLOW_LEDGER: l }, stdout: "pipe", stderr: "pipe" })
    expect(p.exitCode).toBe(2)
    expect(existsSync(l)).toBe(false)
  })
})
