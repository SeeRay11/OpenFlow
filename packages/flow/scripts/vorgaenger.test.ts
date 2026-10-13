/**
 * K11 (Abnahme R20, 13.10.2026): Beim `--resume` stand der abgebrochene
 * Vorgängerlauf bis zum nächsten Reaper-Durchgang (30 min) als RUNNING in der
 * Scorecard. Der Resume markiert ihn jetzt sofort als `stopped` mit Verweis auf
 * den Nachfolger — aber nur, wenn sein Prozess nicht mehr lebt.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { vorgaengerStoppen } from "./of-lauf"

const tot = () => false
const lebt = () => true
const basis = () => ({
  id: "run-2026-10-13T07-02-41-657Z-3b9c2u",
  pipeline: "auto-orchestrator",
  status: "running",
  started: 1_000,
  host: { pid: 424242 },
  nodes: [
    { id: "boss", status: "done", started: 1_000, finished: 5_000 },
    { id: "worker-1", status: "running", started: 6_000 },
  ],
})

describe("vorgaengerStoppen (K11)", () => {
  it("toter Vorgänger im Status running → stopped, mit Nachfolger, Ende = letzte Aktivität", () => {
    const neu = vorgaengerStoppen(basis(), "run-NACHFOLGER", tot, 99_000)
    expect(neu).toBeDefined()
    expect(neu.status).toBe("stopped")
    expect(neu.resumedBy).toBe("run-NACHFOLGER")
    expect(neu.error).toContain("run-NACHFOLGER")
    expect(neu.finished).toBe(6_000)
    expect(neu.stoppedByResume.at).toBe(new Date(99_000).toISOString())
  })

  it("lebender Prozess → nicht anfassen", () => {
    expect(vorgaengerStoppen(basis(), "run-N", lebt, 99_000)).toBeUndefined()
  })

  it("Vorgänger schon beendet (error/stopped/done) → nicht anfassen", () => {
    for (const status of ["error", "stopped", "done"]) {
      expect(vorgaengerStoppen({ ...basis(), status }, "run-N", tot, 99_000)).toBeUndefined()
    }
  })

  it("verändert das übergebene Objekt nicht", () => {
    const alt = basis()
    vorgaengerStoppen(alt, "run-N", tot, 99_000)
    expect(alt.status).toBe("running")
  })

  it("headless-run ruft es beim Resume auf und schreibt den Vorgänger in den Store", () => {
    const src = readFileSync(join(import.meta.dir, "headless-run.ts"), "utf8")
    expect(src).toMatch(/vorgaengerStoppen\(/)
    expect(src).toMatch(/runs\/\$\{encodeURIComponent\(resumeCheckpoint\.id\)\}/)
  })
})
