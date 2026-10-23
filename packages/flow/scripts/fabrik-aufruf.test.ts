/**
 * Defekt 3 (Woche 16.–23.10.2026): das Ledger führte 6 fabrik_run als „real"
 * bei 4 Run-Datensätzen. Fälle: gate-ledger-feldfaelle.ts.
 *
 * Geprüft wird die Regel (ofRunModus/ofRunAufrufe) UND jeder Zähler, der
 * fabrik_run liest — Scorecard, I3 (Loop), Digest. Die Gegenprobe vor dem Fix:
 * I3 und Scorecard zählten 6 bzw. 9, der Digest ließ einen Heredoc-„Run" eine
 * Empfehlung abdecken.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artAusBefehl, echteStarts, fabrikRunArt, ofRunAufrufe, ofRunModus } from "./of-fabrik-aufruf"
import { FABRIK_RUN_ZEILEN, L670_VOLL } from "./gate-ledger-feldfaelle"
import { computeI3 } from "./of-loop-logik"
import { buildFabrikDigest } from "./of-digest"

const TMP = mkdtempSync(join(tmpdir(), "fabrik-aufruf-"))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
const eintraege = FABRIK_RUN_ZEILEN.map((z) => z.eintrag)
const NACH_WOCHE = Date.parse("2026-10-23T12:00:00Z")

describe("ofRunModus — dieselbe Verzweigung wie of-run.sh", () => {
  const faelle: [string[], string][] = [
    [["auto-orchestrator", "task"], "start"],
    [["--wait", "auto-orchestrator", "t"], "start"],
    [["--resume", "run-1"], "start"],
    [["--spread", "auto-orchestrator", "t"], "start"],
    [["--scorecard", "--limit", "3"], "monitoring"],
    [["--loop-check"], "monitoring"],
    [["--nutzung", "6"], "monitoring"],
    [["--reap", "--dry-run"], "monitoring"],
    [["--loop"], "monitoring"],
    [["--status"], "abgelehnt"],
    [["--resume"], "abgelehnt"],
    [["--wait", "--scorecard"], "abgelehnt"], // Monitoring nur an $1
    [["--"], "abgelehnt"],
  ]
  for (const [args, soll] of faelle) test(`of-run.sh ${args.join(" ")} → ${soll}`, () => expect(ofRunModus(args)).toBe(soll as any))
})

describe("ofRunAufrufe — Zitat und Heredoc-Rumpf sind Daten", () => {
  test("L670 vollständig: nur der echte Aufruf hinter dem Heredoc zählt (monitoring)", () => {
    expect(ofRunAufrufe(L670_VOLL)).toEqual(["monitoring"])
  })
  test("python -c \"…of-run.sh…\" ist kein Aufruf", () => expect(artAusBefehl('python3 -c "print(\'of-run.sh auto-orchestrator\')"')).toBeNull())
  test("echo mit of-run.sh im Zitat ist kein Aufruf", () => expect(artAusBefehl('echo "starte bash of-run.sh auto-orchestrator x"')).toBeNull())
  test("bash -c '…of-run.sh auto-orchestrator…' ist ein Start", () => expect(artAusBefehl("bash -c 'cd /x && bash of-run.sh auto-orchestrator t'")).toBe("start"))
  test("timeout 55 bash …of-run.sh --scorecard ist Monitoring", () => expect(artAusBefehl("timeout 55 bash packages/flow/scripts/of-run.sh --scorecard 2>&1 | tail")).toBe("monitoring"))
  test("Monitoring und Start im selben Befehl: Start gewinnt", () => expect(artAusBefehl("bash of-run.sh --scorecard; bash of-run.sh --wait auto-orchestrator t")).toBe("start"))
})

describe("Feldfälle 16.–23.10.: Art je Ledger-Zeile", () => {
  for (const z of FABRIK_RUN_ZEILEN) test(`L${z.zeile} → ${z.soll}`, () => expect(fabrikRunArt(z.eintrag)).toBe(z.soll))
  test("echte Starts der Woche: 4 (L638, L682, L684, L949)", () => {
    expect(echteStarts(eintraege).map((e) => e.ts)).toEqual(
      FABRIK_RUN_ZEILEN.filter((z) => z.soll === "start").map((z) => z.eintrag.ts),
    )
    expect(echteStarts(eintraege).length).toBe(4)
  })
  test("neue Zeile mit art hat Vorrang vor der Befehlsanalyse", () => {
    expect(fabrikRunArt({ event: "fabrik_run", art: "monitoring", command: "bash of-run.sh auto-orchestrator t" })).toBe("monitoring")
  })
  test("vom Plugin als gescheitert gemeldeter Start zählt nicht", () => {
    const e = [
      { event: "fabrik_run", art: "start", aufruf_id: "call_1", ts: "2026-10-23T10:00:00Z" },
      { event: "fabrik_start_fehlgeschlagen", aufruf_id: "call_1", ts: "2026-10-23T10:00:01Z" },
      { event: "fabrik_run", art: "start", aufruf_id: "call_2", ts: "2026-10-23T10:01:00Z" },
    ]
    expect(echteStarts(e).map((x) => x.aufruf_id)).toEqual(["call_2"])
  })
})

describe("Zähler lesen nur echte Starts", () => {
  test("I3 (Loop-Sonde): fabrikAufrufe = 4, nicht 6", () => {
    expect(computeI3(eintraege, NACH_WOCHE).fabrikAufrufe).toBe(4)
  })

  test("Digest: der Heredoc-„Run“ L670 deckt keine Empfehlung ab", () => {
    const l670 = FABRIK_RUN_ZEILEN.find((z) => z.zeile === 670)!.eintrag
    const kandidat = { event: "task", entscheidung: "FABRIK", ts: "2026-10-17T12:30:00.000Z", signale: ["review"] }
    const d = buildFabrikDigest([kandidat, l670], new Date(NACH_WOCHE))
    expect(d.fabrikOhneRun).toBe(1)
  })

  test("Scorecard --json: ledger.fabrikAufrufe = 4", () => {
    const runs = join(TMP, "runs")
    mkdirSync(runs, { recursive: true })
    const ledger = join(TMP, "ledger.jsonl")
    writeFileSync(ledger, eintraege.map((e) => JSON.stringify(e)).join("\n") + "\n")
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-scorecard.ts"), "--runs-dir", runs, "--ledger", ledger, "--json"], { stdout: "pipe", stderr: "pipe" })
    expect(p.exitCode).toBe(0)
    expect(JSON.parse(p.stdout.toString()).ledger.fabrikAufrufe).toBe(4)
  })
})
