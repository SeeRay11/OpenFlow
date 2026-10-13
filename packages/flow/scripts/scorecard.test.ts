/**
 * Tests für of-scorecard.ts (bun test).
 *
 * Läuft of-scorecard.ts als Subprozess gegen ein Temp-Runs-Dir (--runs-dir)
 * und ein Temp-Ledger (--ledger). Eingaben (Run-JSONs, Ledger-JSONL) entstehen
 * ausschließlich in fs.mkdtemp(os.tmpdir())-Verzeichnissen — kein Schreiben
 * in echte Runs, $HOME oder ~/.openflow. Ein kaputtes Ledger-Fragment wird
 * (wie im Skript) über try/catch verworfen.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "of-scorecard.ts")

interface Agg {
  runsTotal: number
  pass: number
  passRetried: number
  fail: number
  stopped: number
  stoppedMitGrund: number
  stoppedOhneGrund: number
  runningNow: number
  reaped: number
  passQuote: number
  avgDurationSecPass: number | null
  outputWordsTotal: number
}
interface LedgerAgg {
  eintraege: number
  taskBewertungen: number
  fabrikKandidaten: number
  direktEmpfohlen: number
  grauzone: number
  fabrikAufrufe: number
  regeltreue: number | null
}
interface Parsed {
  aggregate: Agg
  ledger: LedgerAgg | null
  runs: Array<Record<string, any>>
}

let txDirs: string[] = []
let runsDir = ""
let ledger = ""

afterEach(() => {
  for (const d of txDirs) rmSync(d, { recursive: true, force: true })
  txDirs = []
})

/** Eigenes Temp-Verzeichnis pro Fall; Ledger liegt darin (als *.jsonl ignoriert die Run-Scan-Logik es als Run). */
function newCase() {
  const d = mkdtempSync(join(tmpdir(), "of-scorecard-case-"))
  txDirs.push(d)
  runsDir = d
  ledger = join(d, "gate-ledger.jsonl")
}

function writeRun(id: string, log: unknown) {
  writeFileSync(join(runsDir, `${id}.json`), JSON.stringify(log, null, 2))
}

async function scorecard(args: string[]) {
  const proc = Bun.spawn(["bun", SCRIPT, "--runs-dir", runsDir, "--ledger", ledger, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

/** Erstellt Runs + Ledger im Temp-Dir und misst sie durch `bun of-scorecard.ts --json`. */
async function measure(
  logs: Array<Record<string, any>>,
  opts: { ledger?: Array<Record<string, any>>; order?: string[] } = {},
): Promise<Parsed> {
  const ids = new Set(logs.map((l) => l.id))
  expect(ids.size).toBe(logs.length)
  for (const log of logs) writeRun(log.id, log)
  if (opts.ledger) {
    writeFileSync(
      ledger,
      opts.ledger.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n",
    )
  }
  const r = await scorecard(["--json"])
  expect(r.exitCode).toBe(0)
  expect(r.stderr).toBe("")
  const parsed = JSON.parse(r.stdout) as Parsed
  if (opts.order) expect(parsed.runs.map((x) => x.id)).toEqual(opts.order)
  return parsed
}

describe("of-scorecard — Aggregate inkl. attempts & reaped", () => {
  test("(1) Run mit nur PASS → pass=1, andere Verdicts 0, attempts=1, passQuote=100", async () => {
    newCase()
    const p = await measure([{ id: "onlypass", status: "done", started: 0, finished: 10_000 }], {
      order: ["onlypass"],
    })
    expect(p.aggregate.runsTotal).toBe(1)
    expect(p.aggregate.pass).toBe(1)
    expect(p.aggregate.passRetried).toBe(0)
    expect(p.aggregate.fail).toBe(0)
    expect(p.aggregate.stopped).toBe(0)
    expect(p.aggregate.reaped).toBe(0)
    expect(p.aggregate.passQuote).toBe(100)
    expect(p.runs[0].verdict).toBe("PASS")
    expect(p.runs[0].attempts).toBe(1)
    expect(p.runs[0].reaped).toBe(false)
    expect(p.runs[0].durationSec).toBe(10)
    expect(p.aggregate.avgDurationSecPass).toBe(10)
    expect(p.ledger).toBeNull() // Ledger-Datei fehlt → null statt Objekt
  })

  test("(2) status done mit scorecard.attempts=3 → PASS_RETRIED, attempts korrekt", async () => {
    newCase()
    const p = await measure([{ id: "retried", status: "done", scorecard: { attempts: 3 } }], {
      order: ["retried"],
    })
    expect(p.runs[0].verdict).toBe("PASS_RETRIED")
    expect(p.runs[0].attempts).toBe(3)
    expect(p.aggregate.passRetried).toBe(1)
    expect(p.aggregate.pass).toBe(1) // PASS_RETRIED zählt mit in die PASS-Quote
  })

  test("(3) status error → FAIL gezählt, unabhängig von attempts", async () => {
    newCase()
    const p = await measure([{ id: "fail", status: "error", scorecard: { attempts: 4 } }], {
      order: ["fail"],
    })
    expect(p.runs[0].verdict).toBe("FAIL")
    expect(p.runs[0].attempts).toBe(4)
    expect(p.aggregate.fail).toBe(1)
    expect(p.aggregate.pass).toBe(0)
    expect(p.aggregate.passRetried).toBe(0)
  })

  test("(4) status stopped → als STOPPED gezählt, nicht als FAIL", async () => {
    newCase()
    const p = await measure([{ id: "stopped-plain", status: "stopped" }], { order: ["stopped-plain"] })
    expect(p.runs[0].verdict).toBe("STOPPED")
    expect(p.aggregate.stopped).toBe(1)
    expect(p.aggregate.fail).toBe(0)
    expect(p.runs[0].reaped).toBe(false)
    expect(p.aggregate.reaped).toBe(0)
  })

  test("(5) reaped-Vermerk → aggregate.reaped=1 und Text-Ausgabe nennt gereapte Leiche", async () => {
    newCase()
    const p = await measure(
      [{ id: "reaped-run", status: "stopped", reaped: { reason: "kein Checkpoint" } }],
      { order: ["reaped-run"] },
    )
    expect(p.aggregate.reaped).toBe(1)
    expect(p.runs[0].reaped).toBe(true)
    expect(p.runs[0].reapedReason).toBe("kein Checkpoint")
    expect(p.runs[0].verdict).toBe("STOPPED")

    const t = await scorecard([])
    expect(t.exitCode).toBe(0)
    expect(t.stdout).toContain("| STOPPED | 1 (davon 1 mit Grund (z. B. zombie), 0 ohne Grund) |")
    expect(t.stdout).toContain("gereapte Zombies | 1")
    expect(t.stdout).toContain("(gereapte Leiche)")
  })

  test("(5c) R18 K11: gereapter Alt-Log (finished = Abräumzeit) → Dauer bis zur letzten Aktivität", async () => {
    newCase()
    // Messwerte von run-2026-10-13T00-14-05-710Z-8uustv (vor dem Fix gereapt).
    const p = await measure(
      [
        {
          id: "reaped-8uustv",
          status: "stopped",
          started: Date.parse("2026-10-13T00:14:05.710Z"),
          finished: Date.parse("2026-10-13T00:30:01.107Z"),
          reaped: { reason: "zombie", at: "2026-10-13T00:30:01.107Z", lastActivity: "2026-10-13T00:15:43.299Z" },
        },
      ],
      { order: ["reaped-8uustv"] },
    )
    expect(p.runs[0].durationSec).toBe(98)
  })

  test("(5b) STOPPED-Breakdown: mit reaped.reason vs. ohne (reaped:true hat keinen Grund)", async () => {
    newCase()
    const p = await measure(
      [
        { id: "stop-mit-grund", status: "stopped", reaped: { reason: "zombie: 15 min stumm" } },
        { id: "stop-reaped-bool", status: "stopped", reaped: true }, // boolean → kein Grund-Objekt
        { id: "stop-ohne-alles", status: "stopped" }, // kein reaped-Feld
      ],
      { order: ["stop-mit-grund", "stop-ohne-alles", "stop-reaped-bool"] }, // readdirSync().sort() = alphabetisch
    )
    expect(p.aggregate.stopped).toBe(3)
    expect(p.aggregate.stoppedMitGrund).toBe(1)
    expect(p.aggregate.stoppedOhneGrund).toBe(2)
    expect(p.runs[0].reapedReason).toBe("zombie: 15 min stumm")
    expect(p.runs[1].reapedReason).toBeNull()
    expect(p.runs[2].reapedReason).toBeNull()
  })

  test("(5c) Text-Ausgabe nennt Quelle (runs-dir) direkt unter der Überschrift", async () => {
    newCase()
    writeRun("quelle-run", { id: "quelle-run", status: "done" })
    const t = await scorecard([])
    expect(t.exitCode).toBe(0)
    const zeilen = t.stdout.split("\n")
    const kopf = zeilen.findIndex((z) => z.startsWith("## OpenFlow Scorecard"))
    expect(kopf).toBeGreaterThanOrEqual(0)
    expect(zeilen[kopf + 1]).toBe(`Quelle: ${runsDir}`)
  })

  test("(5d) OF_RUNS_DIR-Env steuert das Run-Verzeichnis ohne --runs-dir-Flag", async () => {
    newCase()
    writeRun("env-run", { id: "env-run", status: "error" })
    const prev = process.env.OF_RUNS_DIR
    process.env.OF_RUNS_DIR = runsDir
    try {
      // Bun.spawn erbt Laufzeit-Mutationen von process.env nicht (gemessen:
      // SEEN=UNSET ohne explizites env) — deshalb explizit weiterreichen.
      const proc = Bun.spawn(["bun", SCRIPT, "--ledger", ledger, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      const parsed = JSON.parse(stdout) as Parsed
      expect(parsed.aggregate.runsTotal).toBe(1)
      expect(parsed.aggregate.fail).toBe(1)
      expect(parsed.runs[0].id).toBe("env-run")
    } finally {
      if (prev === undefined) delete process.env.OF_RUNS_DIR
      else process.env.OF_RUNS_DIR = prev
    }
  })

  test("(6) Mischfall: alle Kennzahlen in Runs und Aggregat korrekt", async () => {
    newCase()
    const p = await measure(
      [
        { id: "mix-a", status: "done", started: 0, finished: 3000 },
        { id: "mix-b", status: "done", scorecard: { attempts: 2 } },
        { id: "mix-c", status: "error" },
        { id: "mix-d", status: "stopped", reaped: true },
        { id: "mix-e", status: "running" },
      ],
      { order: ["mix-a", "mix-b", "mix-c", "mix-d", "mix-e"] },
    )
    expect(p.aggregate.runsTotal).toBe(5)
    expect(p.aggregate.pass).toBe(2)
    expect(p.aggregate.passRetried).toBe(1)
    expect(p.aggregate.fail).toBe(1)
    expect(p.aggregate.stopped).toBe(1)
    expect(p.aggregate.runningNow).toBe(1)
    expect(p.aggregate.reaped).toBe(1)
    expect(p.aggregate.passQuote).toBe(40)
    expect(p.aggregate.avgDurationSecPass).toBe(3)
    expect(p.runs[0].verdict).toBe("PASS")
    expect(p.runs[1].verdict).toBe("PASS_RETRIED")
    expect(p.runs[1].attempts).toBe(2)
    expect(p.runs[2].verdict).toBe("FAIL")
    expect(p.runs[3].reaped).toBe(true)
    expect(p.runs[4].verdict).toBe("RUNNING")
  })

  test("(7) ungültige Run-Dateien werden übersprungen (try/catch → null → gefiltert)", async () => {
    newCase()
    writeRun("good-two", { id: "good-two", status: "error" })
    writeFileSync(join(runsDir, "broken.json"), "{kein gültiges json")
    writeFileSync(join(runsDir, "leer.json"), "")
    // Dateien sind da; das Skript filtert sie via try/catch → null → filter(Boolean):
    const p = await measure([], { order: ["good-two"] })
    expect(p.aggregate.runsTotal).toBe(1)
    expect(p.aggregate.fail).toBe(1)
  })
})

describe("of-scorecard — Ledger-Sektion (Regeltreue)", () => {
  test("(8) Kandidaten/Aufrufe/Regeltreue-Quote; kaputte JSONL-Zeilen fliegen raus", async () => {
    newCase()
    const p = await measure(
      [{ id: "ledger-run", status: "done" }],
      {
        ledger: [
          { event: "task", entscheidung: "FABRIK" },
          "{kaputt",
          { event: "task", entscheidung: "DIREKT" },
          { event: "task", entscheidung: "GRAUZONE" },
          { event: "task", quelle: "subagent", entscheidung: "GRAUZONE" },
          { event: "user_prompt", entscheidung: "FABRIK" },
          { event: "fabrik_run" },
          // Session-Matching: Kandidat s1 wird durch subagent-Nutzung in s1
          // binnen 5 min abgedeckt; s2 bleibt unbedeckt (andere Session).
          { ts: "2026-10-13T10:00:00Z", event: "user_prompt", entscheidung: "FABRIK", session_id: "s1" },
          { ts: "2026-10-13T10:05:00Z", event: "task", quelle: "subagent", entscheidung: "GRAUZONE", session_id: "s1" },
          { ts: "2026-10-13T10:00:00Z", event: "user_prompt", entscheidung: "FABRIK", session_id: "s2" },
          // Fenster-Grenzfälle (13.10.): Nutzung erst nach 31 min (s3) bzw.
          // NUTZUNG VOR Kandidat (s4) — beides darf NICHT als Abdeckung zählen.
          { ts: "2026-10-13T11:00:00Z", event: "user_prompt", entscheidung: "FABRIK", session_id: "s3" },
          { ts: "2026-10-13T11:31:00Z", event: "task", quelle: "subagent", entscheidung: "GRAUZONE", session_id: "s3" },
          { ts: "2026-10-13T09:00:00Z", event: "task", quelle: "subagent", entscheidung: "GRAUZONE", session_id: "s4" },
          { ts: "2026-10-13T09:05:00Z", event: "user_prompt", entscheidung: "FABRIK", session_id: "s4" },
          "",
        ],
        order: ["ledger-run"],
      },
    )
    expect(p.ledger).not.toBeNull()
    expect(p.ledger!.eintraege).toBe(13)
    expect(p.ledger!.taskBewertungen).toBe(7)
    expect(p.ledger!.subagentNutzung).toBe(4)
    expect(p.ledger!.fabrikKandidaten).toBe(1)
    expect(p.ledger!.fanoutKandidaten).toBe(6) // 1 task FABRIK + 5 user_prompt FABRIK
    expect(p.ledger!.direktEmpfohlen).toBe(1)
    expect(p.ledger!.grauzone).toBe(5)
    expect(p.ledger!.fabrikAufrufe).toBe(1)
    // Session-Matching: s1 bedeckt (subagent in s1, +5 min); s2 offen (andere
    // Session); s3 offen (Nutzung erst nach 31 min > Fenster); s4 offen
    // (Nutzung VOR dem Kandidat) → 1/4 = 25 %.
    expect(p.ledger!.fanoutKandidatenSession).toBe(4)
    expect(p.ledger!.fanoutAbdeckungSession).toBe(25)
    // Näherung ohne Matching: (1 fabrik_run + 4 subagent) / 6 Kandidaten = 83.3 %
    expect(p.ledger!.fanoutAbdeckung).toBe(83.3)
    expect(p.ledger!.regeltreueFabrik).toBe(100) // alte, enge Definition: 1 Fabrik-Aufruf / 1 task-Kandidat
  })
})

describe("of-scorecard — Textausgabe (--limit)", () => {
  test("(9) Kennzahlzeilen: Verdict-Zähler, PASS_RETRIED-Spalte, Wörter, Ø Dauer", async () => {
    newCase()
    writeRun("text-a", { id: "text-a", status: "done", output: "zwei vier" })
    writeRun("text-b", { id: "text-b", status: "done", scorecard: { attempts: 2 }, output: "Hallo Welt drei zwei eins" })
    writeRun("text-c", { id: "text-c", status: "error" })
    writeRun("text-d", { id: "text-d", status: "stopped", reaped: true })
    const r = await scorecard(["--limit", "5"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("| PASS (done) | 2 (50 %) |")
    expect(r.stdout).toContain("| davon PASS_RETRIED (Auto-Retry) | 1 |")
    expect(r.stdout).toContain("| FAIL (error) | 1 |")
    expect(r.stdout).toContain("| STOPPED | 1 (davon 0 mit Grund (z. B. zombie), 1 ohne Grund) |")
    expect(r.stdout).toContain("gereapte Zombies | 1")
    expect(r.stdout).toContain("PASS_RETRIED") // Verdict-Spalte
    expect(r.stdout).toContain("| Output gesamt | 0 Wörter |")
    expect(r.stdout).toContain("Ø Dauer PASS | k.A.")
  })
})
