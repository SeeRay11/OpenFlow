/**
 * Tests für of-nutzung.ts (bun test).
 *
 * Läuft of-nutzung.ts als Subprozess gegen ein Temp-Ledger (--ledger), ein
 * Temp-Log (--log, inkl. rotierter --log-rotated) und ein Temp-Runs-Dir
 * (--runs-dir, für den Scorecard-Abschnitt). Alle Eingaben entstehen
 * ausschließlich in fs.mkdtemp(os.tmpdir())-Verzeichnissen — kein Lesen
 * echter $HOME-/Log-/Runs-Pfade. Nur der Loop-Abschnitt läuft gegen die
 * echte of-loopcheck.ts-Sonde (GRÜN/ROT-Zeile, niemals ein Abbruch).
 *
 * Der Selbst-Beobachtungsfilter ist der Kern: Zeilen mit timestamp >=
 * Skript-Start zählen nicht — getestet mit einer Zukunft-Zeile, die im
 * Fenster-Liegeblend bleiben müsste, wenn der Filter versagt.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "of-nutzung.ts")

interface Parsed {
  fenster: { tage: number; von: string; bis: string; startTs: string }
  ledger: {
    tabelle: Array<{ tag: string; direkt: number; grauzone: number; fabrik: number; fabrikRun: number; fabrikRunMonitoring: number }>
    grauzoneOhneGrund: Array<{ ts: string; task: string }>
    abweichungen: Array<{ ts: string; task: string }>
  }
  log: {
    tabelle: Array<{ tag: string; treffer: number; ofRunSh: number }>
    invalidDharma: number
    rotatedTotal: number
  }
  scorecard: { ok: boolean }
  loop: { zeile: string; probleme: string[] }
}

let txDirs: string[] = []

afterEach(() => {
  for (const d of txDirs) rmSync(d, { recursive: true, force: true })
  txDirs = []
})

function newCase() {
  const d = mkdtempSync(join(tmpdir(), "of-nutzung-case-"))
  txDirs.push(d)
  const logDir = join(d, "log")
  mkdirSync(logDir)
  return {
    dir: d,
    ledger: join(d, "gate-ledger.jsonl"),
    log: join(logDir, "opencode.log"),
    logRotated: join(logDir, "opencode.log.1"),
    runsDir: join(d, "runs"),
  }
}

/**
 * Fester Bezugszeitpunkt (Abnahme R18 (4)): Mit der echten Uhr lagen die
 * Zeilen „heute T07:00Z" zwischen 00:00 und 07:30 UTC in der Zukunft und
 * fielen dem Selbst-Beobachtungsfilter zum Opfer. 12:00Z liegt nach jeder
 * Testzeile von heute ausser der absichtlichen Zukunftszeile 23:59:59.999Z.
 */
const JETZT = "2026-10-13T12:00:00.000Z"
const JETZT_MS = Date.parse(JETZT)

function day(offsetDays: number): string {
  return new Date(JETZT_MS - offsetDays * 86_400_000).toISOString().slice(0, 10)
}
const ts = (offsetDays: number, time = "T12:00:00.000Z") => day(offsetDays) + time

async function nutzung(paths: { ledger: string; log: string; logRotated: string; runsDir: string }, tage = 6) {
  const proc = Bun.spawn(
    ["bun", SCRIPT, String(tage), "--jetzt", JETZT, "--ledger", paths.ledger, "--log", paths.log, "--log-rotated", paths.logRotated, "--runs-dir", paths.runsDir, "--json"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, report: JSON.parse(stdout) as Parsed }
}

describe("of-nutzung — Gate-Ledger", () => {
  test("Tages-Tabelle, GRAUZONE-ohne-grund und ABWEICHUNG wie gefordert", async () => {
    const c = newCase()
    const entries = [
      { ts: ts(1), event: "task", entscheidung: "DIREKT", grund: "x", task: "d1" },
      { ts: ts(1), event: "task", entscheidung: "GRAUZONE", grund: "y", task: "g1" },
      { ts: ts(0), event: "task", entscheidung: "GRAUZONE", task: "g-ohne-grund" }, // Regelverstoß
      { ts: ts(2), event: "task", entscheidung: "FABRIK", grund: "z", task: "FABRIK-Empfehlung ohne Folgen" }, // ABWEICHUNG (Tag ohne fabrik_run)
      { ts: ts(0), event: "task", entscheidung: "FABRIK", grund: "z", task: "gefolgt" },
      { ts: ts(0), event: "fabrik_run", command: "…" },
      { ts: ts(10), event: "task", entscheidung: "FABRIK", grund: "alt", task: "außerhalb Fenster" },
    ]
    writeFileSync(c.ledger, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z level=INFO message=leer\n")
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    const heute = r.report.ledger.tabelle.find((x) => x.tag === day(0))!
    const gestern = r.report.ledger.tabelle.find((x) => x.tag === day(1))!
    expect(gestern).toEqual({ tag: day(1), direkt: 1, grauzone: 1, fabrik: 0, fabrikRun: 0, fabrikRunMonitoring: 0 })
    expect(heute.direkt).toBe(0)
    expect(heute.grauzone).toBe(1)
    expect(heute.fabrik).toBe(1)
    expect(heute.fabrikRun).toBe(1)
    // nur der GRAUZONE-Eintrag ohne grund zählt — der mit grund nicht
    expect(r.report.ledger.grauzoneOhneGrund).toEqual([{ ts: ts(0), task: "g-ohne-grund" }])
    // FABRIK ohne fabrik_run am selben Tag = ABWEICHUNG; der gefolgte und der
    // außerhalb des Fensters nicht
    expect(r.report.ledger.abweichungen).toEqual([{ ts: ts(2), task: "FABRIK-Empfehlung ohne Folgen" }])
  })

  test("Hebel 14: fabrik_run mit monitoring:true zählt NICHT in fabrikRun, nur in fabrikRunMonitoring", async () => {
    const c = newCase()
    const entries = [
      { ts: ts(1), event: "fabrik_run", command: "echter Fabrik-Run" },
      { ts: ts(1), event: "fabrik_run", command: "Monitoring-Sonde", monitoring: true },
    ]
    writeFileSync(c.ledger, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z level=INFO message=leer\n")
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    const gestern = r.report.ledger.tabelle.find((x) => x.tag === day(1))!
    expect(gestern.fabrikRun).toBe(1) // nur der echte Run
    expect(gestern.fabrikRunMonitoring).toBe(1) // die Sonde getrennt
  })

  test("Hebel 2: task_ref→gate_id matcht über die Tagesgrenze — keine ABWEICHUNG", async () => {
    const c = newCase()
    const entries = [
      { ts: ts(1), event: "task", entscheidung: "FABRIK", grund: "z", gate_id: "gate-42", task: "spät gefolgt" },
      { ts: ts(2), event: "fabrik_run", task_ref: "gate-42", command: "…" },
    ]
    writeFileSync(c.ledger, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z level=INFO message=leer\n")
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    // FABRIK-Verdict Tag 1, fabrik_run mit passendem task_ref Tag 2 → gefolgt
    expect(r.report.ledger.abweichungen).toEqual([])
  })

  test("Hebel 2: task_ref eines ANDEREN gate_id ist keine Folge — ABWEICHUNG bleibt", async () => {
    const c = newCase()
    const entries = [
      { ts: ts(0), event: "task", entscheidung: "FABRIK", grund: "z", gate_id: "gate-1", task: "falsch verknüpft" },
      { ts: ts(0), event: "fabrik_run", task_ref: "gate-999", command: "…" },
    ]
    writeFileSync(c.ledger, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z level=INFO message=leer\n")
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    // fabrik_run gehört zu einem anderen gate_id → die Empfehlung blieb ohne Folge
    expect(r.report.ledger.abweichungen).toEqual([{ ts: ts(0), task: "falsch verknüpft" }])
  })

  test("fehlendes Ledger meldet 0 statt zu sterben", async () => {
    const c = newCase()
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z level=INFO message=leer\n")
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)
    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    expect(r.report.ledger.tabelle.every((x) => x.direkt + x.grauzone + x.fabrik + x.fabrikRun === 0)).toBe(true)
    expect(r.report.ledger.abweichungen).toEqual([])
  })
})

describe("of-nutzung — OpenCode-Log", () => {
  test("Treffer je Tag, of-run.sh-Teilmenge, Invalid-dharma, rotierte Gesamtzahl", async () => {
    const c = newCase()
    const lines = [
      `timestamp=${ts(1, "T08:00:00.000Z")} level=INFO message=evaluated pattern="of-run.sh --scorecard"`,
      `timestamp=${ts(1, "T09:00:00.000Z")} level=ERROR message="Failed to drain Session" cause="LLM.Error: ProviderShared.stream: Invalid dharma/openai-compatible-chat stream event"`,
      `timestamp=${ts(0, "T07:00:00.000Z")} level=INFO pattern="fabrik: artikel schreiben"`,
      `timestamp=${ts(0, "T07:30:00.000Z")} level=INFO pattern="grep OpenFlow docs"`,
      `timestamp=${ts(0, "T23:59:59.999Z")} level=INFO pattern="of-run.sh --nutzung aus der Zukunft"`, // >= Start: verboten
      `timestamp=${ts(0, "T07:00:00.000Z")} level=INFO message="ohne Bezug"`, // kein Muster
    ]
    writeFileSync(c.log, lines.join("\n") + "\n")
    writeFileSync(c.logRotated, `a fabrik b\nc\nOpenFlow d\n`.repeat(3))
    mkdirSync(c.runsDir)
    writeFileSync(c.ledger, "")

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    const heute = r.report.log.tabelle.find((x) => x.tag === day(0))!
    const gestern = r.report.log.tabelle.find((x) => x.tag === day(1))!
    expect(gestern.treffer).toBe(1)
    expect(gestern.ofRunSh).toBe(1)
    expect(heute.treffer).toBe(2) // Zukunftszeile und Muster-lose Zeile zählen nicht
    expect(heute.ofRunSh).toBe(0)
    expect(r.report.log.invalidDharma).toBe(1)
    expect(r.report.log.rotatedTotal).toBe(6)
  })

  test("fehlendes Log meldet 0 statt zu sterben", async () => {
    const c = newCase()
    writeFileSync(c.logRotated, "")
    mkdirSync(c.runsDir)
    writeFileSync(c.ledger, "")
    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    expect(r.report.log.tabelle.every((x) => x.treffer === 0 && x.ofRunSh === 0)).toBe(true)
    expect(r.report.log.invalidDharma).toBe(0)
  })
})

describe("of-nutzung — Scorecard + Loop", () => {
  test("Scorecard-Kopf aus Temp-Runs, Loop-Zeile wörtlich, Exit 0 auch bei ROT", async () => {
    const c = newCase()
    mkdirSync(c.runsDir)
    writeFileSync(join(c.runsDir, "run-1.json"), JSON.stringify({ id: "r1", pipeline: "p", status: "done", started: Date.now() - 1000, finished: Date.now(), nodes: [{ status: "done", output: "eins zwei" }] }))
    writeFileSync(c.ledger, "")
    writeFileSync(c.log, "timestamp=2020-01-01T00:00:00.000Z message=leer\n")
    writeFileSync(c.logRotated, "")

    const r = await nutzung(c)
    expect(r.exitCode).toBe(0)
    expect(r.report.scorecard.ok).toBe(true)
    expect(r.report.scorecard.kopf.join("\n")).toContain("1 Runs")
    expect(r.report.loop.zeile).toMatch(/GRÜN|ROT/)
  })
})
