/**
 * Tests für of-heilung.ts — die Heil-Regel von of-loop (bun test, rein, ohne
 * Prozessstart). Fixture A ist die echte Kette vom 12.10.2026 (Familie
 * 13-56-16, Session …9SLBisQc), Felder auf das Nötige gekürzt.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { familien, herkunft, planeHeilung, HEIL_MAX, SERIE_GLEICH, type RunLog } from "./of-heilung.ts"

const NOW = Date.parse("2026-10-12T15:00:00Z")
const MIN = 60_000
const E401 = 'Provider request failed with HTTP 401: {\n  "error": "unauthorized"\n}'
const ALT = () => NOW - 30 * MIN // Checkpoint alt genug (> 15 min)
const opts = (checkpoint: (id: string) => number | null = ALT) => ({ now: NOW, pipelines: ["auto-orchestrator"], maxAgeH: 24, checkpoint })

let t = Date.parse("2026-10-12T13:50:00Z")
function run(id: string, status: string, extra: Partial<RunLog> & { fehler?: string; ses?: string } = {}): RunLog {
  t += MIN
  const { fehler, ses, ...rest } = extra
  return {
    id, status, pipeline: "auto-orchestrator", started: t, finished: t + 30_000,
    nodes: [{ status: status === "error" ? "error" : "done", error: status === "error" ? (fehler ?? "boom") : undefined, sessionID: ses }],
    ...rest,
  }
}
const marke = (at: string) => ({ loop: { resumedAt: at, by: "of-loop" } })

describe("herkunft — jeder Versuch trägt seinen Ursprung", () => {
  test("(1) Versuch 1 eines Resume: resumeOf + origin aus dem Checkpoint, auch über Generationen", () => {
    expect(herkunft({ resumeRef: "run-A", checkpoint: { id: "run-A" }, vorige: [] })).toEqual({ resumeOf: "run-A", origin: "run-A" })
    expect(herkunft({ resumeRef: "run-H", checkpoint: { id: "run-H", origin: "run-A" }, vorige: [] }).origin).toBe("run-A")
  })
  test("(2) Auto-Retry eines frischen Laufs: retryOf + origin = erster Versuch; Ursprung selbst ohne Felder", () => {
    expect(herkunft({ vorige: [] })).toEqual({})
    expect(herkunft({ vorige: ["run-A"] })).toEqual({ retryOf: "run-A", origin: "run-A" })
  })
  test("(3) headless-run setzt die Herkunft in onRun (jeder Checkpoint), nicht erst am Ende", () => {
    const src = readFileSync(join(import.meta.dir, "headless-run.ts"), "utf8")
    const onRun = src.slice(src.indexOf("onRun: (current"), src.indexOf("log = current"))
    expect(onRun).toContain("Object.assign(current, herkunft(")
  })
})

describe("planeHeilung — nie einen Heilungslauf, höchstens HEIL_MAX je Ursprung", () => {
  test("(4) echte Kette 12.10. (Alt-Logs ohne Felder, über Sessions verbunden): kein dritter Resume", () => {
    const logs = [
      run("run-2026-10-12T13-56-16-302Z", "error", { fehler: E401, ses: "S9", ...marke("2026-10-12T14:15:02Z") }),
      run("run-2026-10-12T13-56-17-643Z", "error", { fehler: E401, ses: "S9", scorecard: { attempts: 2 } } as any),
      run("run-2026-10-12T14-15-02-571Z", "error", { fehler: E401, ses: "S9", ...marke("2026-10-12T14:35:01Z") }),
      run("run-2026-10-12T14-15-03-876Z", "error", { fehler: E401, ses: "S9", resumeOf: "run-2026-10-12T13-56-16-302Z" }),
      run("run-2026-10-12T14-35-01-810Z", "error", { fehler: "Failed to read dharma/openai-compatible-chat stream", ses: "S9" }),
    ]
    expect(familien(logs)).toHaveLength(1)
    expect(planeHeilung(logs, opts()).heilen).toEqual([])
  })
  test("(5) Budget: Heilung 1 und 2 aus dem jüngsten Lauf, danach Schluss", () => {
    const O = run("run-O", "error", { fehler: "a" })
    const O2 = run("run-O2", "error", { fehler: "b", retryOf: "run-O", origin: "run-O" })
    expect(planeHeilung([O, O2], opts()).heilen).toEqual([{ ursprung: "run-O", quelle: "run-O2", heilung: 1 }])
    Object.assign(O2, marke("x"))
    const H1 = run("run-H1", "error", { fehler: "c", resumeOf: "run-O2", origin: "run-O" })
    expect(planeHeilung([O, O2, H1], opts()).heilen).toEqual([{ ursprung: "run-O", quelle: "run-H1", heilung: 2 }])
    Object.assign(H1, marke("y"))
    const H2 = run("run-H2", "error", { fehler: "d", resumeOf: "run-H1", origin: "run-O" })
    expect(planeHeilung([O, O2, H1, H2], opts()).heilen).toEqual([])
    expect(HEIL_MAX).toBe(2)
  })
  test("(6) Heilung unterwegs (jüngster Lauf schon markiert, neuer Log fehlt noch): kein zweiter Start", () => {
    const O = run("run-P", "error", { fehler: "a" })
    const O2 = run("run-P2", "error", { fehler: "b", retryOf: "run-P", origin: "run-P", ...marke("z") })
    expect(planeHeilung([O, O2], opts()).heilen).toEqual([])
  })
  test("(7) laufend / fertig / von Hand gestoppt / frischer Checkpoint / fremde Pipeline: nichts", () => {
    const base = () => run("run-Q", "error", { fehler: "a" })
    expect(planeHeilung([base(), run("run-Q2", "running", { resumeOf: "run-Q", origin: "run-Q" })], opts()).heilen).toEqual([])
    expect(planeHeilung([base(), run("run-Q3", "done", { resumeOf: "run-Q", origin: "run-Q" })], opts()).heilen).toEqual([])
    expect(planeHeilung([run("run-R", "stopped"), run("run-R2", "error", { resumeOf: "/tmp/openflow-checkpoint-run-R.json", origin: "run-R" })], opts()).heilen).toEqual([])
    expect(planeHeilung([base()], opts(() => NOW - 5 * MIN)).heilen).toEqual([])
    expect(planeHeilung([{ ...base(), pipeline: "refine-probe" }], opts()).heilen).toEqual([])
  })
  test("(8) Positivkontrolle: frischer gescheiterter Ursprung wird geheilt", () => {
    expect(planeHeilung([run("run-S", "error")], opts()).heilen).toEqual([{ ursprung: "run-S", quelle: "run-S", heilung: 1 }])
  })
})

describe("planeHeilung — Fehlerserie stoppt mit EINEM Alarm", () => {
  test("(9) drei gleiche 401 in Folge: kein Resume, Alarm am Ursprung", () => {
    const logs = [
      run("run-T", "error", { fehler: E401, ses: "ST" }),
      run("run-T2", "error", { fehler: E401, ses: "ST", ...marke("1") }),
      run("run-T3", "error", { fehler: E401.replace(/\n\s*/g, " "), ses: "ST" }),
    ]
    const plan = planeHeilung(logs, opts())
    expect(plan.heilen).toEqual([])
    expect(plan.alarme).toEqual([{ ursprung: "run-T", fehler: 'Provider request failed with HTTP 401: { "error": "unauthorized" }', anzahl: 3 }])
    expect(SERIE_GLEICH).toBe(3)
  })
  test("(10) Alarm steht schon am Ursprung: nicht wiederholen, weiterhin nicht heilen", () => {
    const logs = [
      run("run-U", "error", { fehler: E401, loop: { alarm: { at: "x", fehler: "f", anzahl: 3 } } }),
      run("run-U2", "error", { fehler: E401, retryOf: "run-U", origin: "run-U" }),
      run("run-U3", "error", { fehler: E401, resumeOf: "run-U2", origin: "run-U" }),
    ]
    expect(planeHeilung(logs, opts())).toEqual({ heilen: [], alarme: [] })
  })
  test("(11) zwei gleiche + ein anderer: keine Serie, Heilung erlaubt", () => {
    const logs = [run("run-V", "error", { fehler: E401 }), run("run-V2", "error", { fehler: E401, retryOf: "run-V", origin: "run-V" })]
    expect(planeHeilung(logs, opts()).alarme).toEqual([])
    expect(planeHeilung(logs, opts()).heilen).toHaveLength(1)
  })
  test("(12) Alt-Log: Versuch 2 ohne retryOf hängt über scorecard.predecessors am gestoppten Ursprung — nicht heilen", () => {
    const logs = [run("run-W", "stopped", { ses: "W1" }), run("run-W2", "error", { ses: "W2", scorecard: { attempts: 2, predecessors: ["run-W"] } })]
    expect(planeHeilung(logs, opts()).heilen).toEqual([])
  })
})
