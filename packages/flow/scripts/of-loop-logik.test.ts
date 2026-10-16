/**
 * Tests für of-loop-logik.ts — die reinen Loop-Regeln.
 *
 * T1-T4: computeI3 (O6 — I3-Messkorrektur)
 * T5:    dedupAlerts (O1 — Alert-Dedup)
 * dazu:  gapLueckeMin (O5), letzterTick (O4 — Herzschlag-/State-Fallback)
 */
import { describe, test, expect } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { computeI3, dedupAlerts, gapLueckeMin, letzterTick, type AlertLike, type AlertDedupEintrag } from "./of-loop-logik.ts"

const MIN = 60_000
const TAG = 24 * 3_600_000
const NOW = Date.parse("2026-10-17T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()

const kandidat = (ts: number) => ({ event: "user_prompt", entscheidung: "FABRIK", ts: iso(ts) })
const taskFanout = (ts: number) => ({ event: "task", entscheidung: "FABRIK", ts: iso(ts) })
const run = (ts: number, monitoring = false) => ({ event: "fabrik_run", ts: iso(ts), ...(monitoring ? { monitoring: true } : {}) })

describe("computeI3 (O6: 7-Tage-Fenster, user_prompt-Kandidaten, non-monitoring-Runs)", () => {
  test("T1: 3 Kandidaten + 2 passende non-monitoring-Runs → Quote 2/3, kein Alert", () => {
    const entries = [
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 3 * TAG + 10 * MIN),
      run(NOW - 2 * TAG + 10 * MIN),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.fabrikAufrufe).toBe(2)
    expect(e.matches).toBe(2)
    expect(e.bewertet).toBe(true)
    expect(e.alert).toBe(false) // 2/3 ≈ 67 % >= 50 %
  })

  test("T2: monitoring:true-Runs (--loop-check/ls/--scorecard) zählen nicht", () => {
    const entries = [
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 1 * TAG + 10 * MIN, true),
      run(NOW - 1 * TAG + 20 * MIN, true),
      run(NOW - 1 * TAG + 30 * MIN, true),
    ]
    const e = computeI3(entries, NOW)
    expect(e.fabrikAufrufe).toBe(0)
    expect(e.matches).toBe(0)
    expect(e.alert).toBe(true) // 0/3 < 50 %
  })

  test("T3: Kandidat älter als 7 Tage fällt aus dem Fenster → n<3, nicht bewertet", () => {
    const entries = [
      kandidat(NOW - 8 * TAG), // aus dem Fenster
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 2 * TAG + 10 * MIN),
      run(NOW - 1 * TAG + 10 * MIN),
      run(NOW - 8 * TAG + 10 * MIN),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(2)
    expect(e.bewertet).toBe(false)
    expect(e.alert).toBe(false)
  })

  test("T4: Run VOR dem Kandidaten matcht nicht", () => {
    const entries = [
      run(NOW - 4 * TAG), // liegt vor allen Kandidaten
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
    ]
    const e = computeI3(entries, NOW)
    expect(e.matches).toBe(0)
    expect(e.alert).toBe(true)
  })

  test("ein Run matcht höchstens einen Kandidaten", () => {
    const entries = [kandidat(NOW - 3 * TAG), kandidat(NOW - 2 * TAG), kandidat(NOW - 1 * TAG), run(NOW - 3 * TAG + 10 * MIN)]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.matches).toBe(1)
  })

  test("task|FABRIK sind Fan-out-Signale (Kontext fanouts), keine Kandidaten", () => {
    const entries = [taskFanout(NOW - 1 * TAG), taskFanout(NOW - 2 * TAG), kandidat(NOW - 3 * TAG), kandidat(NOW - 2 * TAG), kandidat(NOW - 1 * TAG)]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.fanouts).toBe(2)
  })
})

describe("dedupAlerts (O1: neu / stumm / Bestätigung nach 24 h)", () => {
  const alert = (wert: string, tsMs: number): AlertLike => ({ ts: iso(tsMs), invariante: "I3-regeltreue", wert, schwelle: ">=50% ab n>=3" })

  test("T5a: erster Alert → art neu, gemeldet, erstes_ts gesetzt", () => {
    const r = dedupAlerts([alert("0/3", NOW)], {}, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("neu")
    expect(r.melden[0].erstes_ts).toBe(iso(NOW))
    expect(r.zustand["I3-regeltreue"].wert).toBe("0/3")
  })

  test("T5b: 1 h später unverändert → stumm (keine Meldung — kein 13x-in-1h mehr)", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 3_600_000), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(0)
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW - 3_600_000))
  })

  test("T5c: 25 h später unverändert → art bestätigt („besteht seit“), gemeldet", () => {
    const vor = NOW - 25 * 3_600_000
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(vor), letzte_bestaetigung: iso(vor) },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("bestaetigt")
    expect(r.melden[0].erstes_ts).toBe(iso(vor)) // ursprünglicher Beginn bleibt
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW))
  })

  test("T5d: Wertänderung (invariante+wert-Kombination ändert sich) → erneut neu", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 5 * TAG), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([alert("1/4", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("neu")
    expect(r.melden[0].erstes_ts).toBe(iso(NOW))
  })

  test("nicht mehr aktiver Alert fällt aus dem Zustand", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 3_600_000), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([], alt, NOW)
    expect(r.melden).toHaveLength(0)
    expect(r.zustand["I3-regeltreue"]).toBeUndefined()
  })
})

describe("gapLueckeMin (O5: Schwelle 15 min)", () => {
  test("unter 15 min → null (kein Marker)", () => {
    expect(gapLueckeMin(NOW - 10 * MIN, NOW)).toBeNull()
    expect(gapLueckeMin(NOW - 15 * MIN, NOW)).toBeNull() // exakt Schwelle: keine Lücke
  })
  test("über 15 min → Lücke in gerundeten Minuten", () => {
    expect(gapLueckeMin(NOW - 20 * MIN, NOW)).toBe(20)
    expect(gapLueckeMin(NOW - 20 * 3_600_000, NOW)).toBe(1200) // ~20 h Stillstand (15.10.)
  })
})

describe("letzterTick (O4: Herzschlag bevorzugt, State-Fallback für Altdaten)", () => {
  const dir = "/tmp/opencode/of-loop-logik-test"
  const hb = `${dir}/heartbeat`
  const state = `${dir}/state.jsonl`

  test("Herzschlag existiert → dessen ts, Quelle heartbeat", () => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(hb, JSON.stringify({ ts: iso(NOW - 4 * MIN), gereapt: 0, geheilt_n: 0, alerts_n: 0 }) + "\n")
    writeFileSync(state, JSON.stringify({ ts: iso(NOW - 30 * TAG) }) + "\n") // alter State darf nicht gewinnen
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t?.quelle).toBe("heartbeat")
    expect(t?.ms).toBe(NOW - 4 * MIN)
  })

  test("Herzschlag fehlt → letzte ts aus State (Altdaten-Kompatibilität)", () => {
    rmSync(hb, { force: true })
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t?.quelle).toBe("state")
    expect(t?.ms).toBe(NOW - 30 * TAG)
  })

  test("beide fehlen → null (Loop lief noch nie)", () => {
    rmSync(state, { force: true })
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t).toBeNull()
  })
})
