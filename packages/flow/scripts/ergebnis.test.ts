/**
 * Tests für of-ergebnis.ts — Schlussbericht von headless-run (bun test, rein).
 *
 * K11-Fixture: die echte Kette vom 12.10.2026, auf das Nötige gekürzt.
 * Checkpoint run-2026-10-12T14-03-22-434Z: worker-1 und worker-3 done
 * (379 + 399 Zeichen), boss/worker-2 error, critic skipped. Das Resume
 * run-2026-10-12T14-20-01-824Z: boss error (HTTP 401) vor jedem Dispatch, alle
 * vier übrigen Karten skipped, ohne Output — gemeldet: reused 0, 0 Wörter.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bericht, buildScorecard, seedFrom, uebernimm } from "./of-ergebnis.ts"

const W1 = "worker eins liefert sieben Wörter Bericht hier"
const W3 = "worker drei liefert fünf Wörter"
const E401 = 'Provider request failed with HTTP 401: {\n  "error": "unauthorized"\n}'

function checkpoint() {
  return {
    id: "run-2026-10-12T14-03-22-434Z",
    pipeline: "auto-orchestrator",
    status: "error",
    nodes: [
      { id: "boss", status: "error", error: E401, sessionID: "S-boss", output: "dispatch …" },
      { id: "worker-1", status: "done", output: W1, sessionID: "S-w1", reused: true },
      { id: "worker-2", status: "error", error: E401, sessionID: "S-w2" },
      { id: "worker-3", status: "done", output: W3, sessionID: "S-w3", reused: true },
      { id: "critic", status: "skipped" },
    ],
  }
}
/** Was die Engine nach dem Resume zurückgab: übernommene Karten skipped. */
function resumeLog(id: string) {
  return {
    id,
    pipeline: "auto-orchestrator",
    status: "error",
    started: 1000,
    finished: 2000,
    nodes: [
      { id: "boss", status: "error", error: E401, sessionID: "S-boss" },
      { id: "worker-1", status: "skipped" },
      { id: "worker-2", status: "skipped" },
      { id: "worker-3", status: "skipped" },
      { id: "critic", status: "skipped" },
    ],
  }
}

/** Die Schleife aus headless-run.ts, ohne Engine: Seeds → Versuche → Scorecard. */
function nachVersuchen(logs: any[]) {
  const carried: Record<string, string> = {}
  const held: Record<string, string> = {}
  seedFrom(checkpoint(), carried, held)
  const gehalten: number[] = []
  let log: any
  for (const next of logs) {
    log = next
    uebernimm(log, carried, held)
    seedFrom(log, carried, held)
    const saat: Record<string, string> = {}
    seedFrom(log, saat, {})
    gehalten.push(Object.keys(saat).length)
  }
  return { log, gehalten, sc: buildScorecard(log, logs.length, [], 0, 0) }
}

describe("K11 — übernommene Karten zählen in der SCORECARD", () => {
  test("(K1) echte Kette: Resume + Auto-Retry, beide boss-401 → reused 2, Wörter = 7 + 5", () => {
    const { log, gehalten, sc } = nachVersuchen([resumeLog("run-2026-10-12T14-20-01-824Z"), resumeLog("run-2026-10-12T14-20-03-070Z")])
    expect(sc.nodes.reused).toBe(2)
    expect(sc.nodes.done).toBe(2)
    expect(sc.nodes.skipped).toBe(2) // worker-2 + critic: nie geliefert
    expect(sc.nodes.error).toBe(1)
    expect(sc.outputWords).toBe(12)
    expect(sc.outputChars).toBe(W1.length + W3.length)
    // Der Auto-Retry sät aus dem Versuch davor: 2 Karten, nicht 0.
    expect(gehalten).toEqual([2, 2])
    // Und der geschriebene Log trägt die Outputs (der nächste Resume hält sie).
    expect(log.nodes.find((n: any) => n.id === "worker-1")).toMatchObject({ status: "done", output: W1, reused: true })
  })
  test("(K2) eine Karte, die in diesem Versuch error endet, behält ihren Fehler", () => {
    const { log } = nachVersuchen([resumeLog("run-x")])
    expect(log.nodes[0]).toMatchObject({ id: "boss", status: "error", error: E401 })
    expect(log.nodes[0].reused).toBeUndefined()
  })
  test("(K3) neu geliefert schlägt übernommen: Wörter über übernommene + neue", () => {
    const l = resumeLog("run-y")
    l.status = "done"
    l.nodes = [
      { id: "boss", status: "done", output: "fertig" } as any,
      { id: "worker-1", status: "done", output: W1, reused: true } as any, // von der Engine selbst übernommen
      { id: "worker-2", status: "done", output: "neu zwei" } as any,
      { id: "worker-3", status: "skipped" } as any, // nicht erneut dispatcht
      { id: "critic", status: "done", output: "kritik" } as any,
    ]
    const { sc } = nachVersuchen([l])
    expect(sc.nodes.reused).toBe(2)
    expect(sc.outputWords).toBe(1 + 7 + 2 + 5 + 1)
  })
})

/** Leser wie openflow-status.ts:81 (~/.config/opencode/plugins): letzte Zeile am Zeilenanfang. */
const leser = (roh: string) => [...roh.matchAll(/^checkpoint: (\/\S+\.json)\s*$/gm)].pop()?.[1]

function logMitFalle() {
  const log = resumeLog("run-2026-10-12T15-00-00-000Z-abc123") as any
  log.nodes[1] = { id: "worker-1", status: "done", output: "Ergebnis\ncheckpoint: /tmp/openflow-checkpoint-FALSCH.json\nEnde" }
  return log
}
const ECHT = "/tmp/openflow-checkpoint-run-2026-10-12T15-00-00-000Z-abc123.json"

describe("(c) — nur die Engine-Zeile ist der Checkpoint", () => {
  test("(C1) Modelltext mit eigener checkpoint-Zeile: der Leser bekommt den Engine-Pfad", () => {
    const zeilen: string[] = []
    const log = logMitFalle()
    bericht(log, buildScorecard(log, 1, [], 0, 0), { out: (s) => zeilen.push(s), err: (s) => zeilen.push(s) })
    expect(leser(zeilen.join("\n"))).toBe(ECHT)
  })
  test("(C2) echter Prozess, stdout+stderr in EINE Datei wie of-run.sh (> LOG 2>&1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-ergebnis-"))
    const fixture = join(dir, "log.json")
    writeFileSync(fixture, JSON.stringify(logMitFalle()))
    const skript = join(dir, "lauf.ts")
    // viel Output, damit eine Pufferung zwischen den Strömen sichtbar würde
    writeFileSync(
      skript,
      `import { bericht, buildScorecard } from ${JSON.stringify(join(import.meta.dir, "of-ergebnis.ts"))}
const log = JSON.parse(await Bun.file(${JSON.stringify(fixture)}).text())
log.nodes[2] = { id: "worker-2", status: "done", output: "x ".repeat(200000) }
bericht(log, buildScorecard(log, 1, [], 0, 0), { out: (s) => console.log(s), err: (s) => console.error(s) })
process.exit(1)
`,
    )
    const out = join(dir, "of-run.log")
    const p = Bun.spawnSync(["bash", "-c", `"${process.execPath}" "${skript}" > "${out}" 2>&1`])
    expect(p.exitCode).toBe(1)
    const roh = readFileSync(out, "utf8").replace(/\x1b\[[0-9;]*m/g, "")
    expect(roh).toContain("checkpoint: /tmp/openflow-checkpoint-FALSCH.json")
    expect(leser(roh)).toBe(ECHT)
  })
})
