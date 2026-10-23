/**
 * T-02 (Plan „Autonomie 10/10", W2.2, A10): Ein Run-Ende läuft IMMER durch
 * einen Abschlusspunkt.
 *
 * Vorher hatte headless-run keinen Signal-Handler: ein Reap (SIGTERM), ein
 * Strg-C oder ein geschlossenes Terminal (SIGHUP) beendete den Prozess
 * mitten im Lauf — kein Verdict, kein Bericht, nichts, was die aufrufende
 * Sitzung hätte lesen können. Jetzt: Verdict `stopped`, Checkpoint, eine
 * `ergebnis.md` (≤ 25 KB) neben dem Checkpoint, deren Pfad als LETZTE
 * stdout-Zeile `ergebnis: <pfad>` — wie bei jedem regulären Ende.
 *
 * Alles schreibt in Temp-Verzeichnisse; der headless-run-Fall redet mit einem
 * Fake-Flow-Store auf einem freien Port, nie mit Canvas oder Engine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { abschliessen, buildScorecard, ERGEBNIS_MAX_BYTES, ergebnisMarkdown, ergebnisPfad, gestoppt } from "./of-ergebnis"

const SCRIPTS = import.meta.dir
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "of-abbruch-"))
  dirs.push(d)
  return d
}

const logMit = (outputs: Record<string, string>) => ({
  id: "run-T02",
  pipeline: "auto-orchestrator",
  status: "running",
  started: Date.now() - 60_000,
  nodes: [
    ...Object.entries(outputs).map(([id, output]) => ({ id, status: "done", output, started: Date.now() - 50_000, finished: Date.now() - 40_000 })),
    { id: "boss", status: "running", started: Date.now() - 30_000 },
    { id: "spaeter", status: "queued" },
  ],
})

describe("ergebnis.md — Inhalt und Grenze", () => {
  it("Scorecard plus Karten-Outputs", () => {
    const log = gestoppt(logMit({ "worker-1": "Befund A" }), "SIGTERM")
    const md = ergebnisMarkdown(log, buildScorecard(log, 1, [], Date.now() - 60_000))
    expect(md).toContain("run-T02")
    expect(md).toContain("STOPPED")
    expect(md).toContain('"verdict": "STOPPED"')
    expect(md).toContain("## worker-1")
    expect(md).toContain("Befund A")
  })

  it("höchstens 25 KB, gekürzt mit Hinweis", () => {
    const log = gestoppt(logMit({ a: "ä".repeat(20_000), b: "Z".repeat(20_000) + "ENDE-MARKE" }), "SIGTERM")
    const md = ergebnisMarkdown(log, buildScorecard(log, 1, [], Date.now()))
    expect(ERGEBNIS_MAX_BYTES).toBe(25 * 1024)
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(ERGEBNIS_MAX_BYTES)
    expect(md).toContain("gekürzt")
    expect(md).not.toContain("ENDE-MARKE")
    expect(md).not.toContain("�")
  })

  it("gestoppt: Run und noch offene Karten → stopped, fertige bleiben", () => {
    const log = gestoppt(logMit({ w: "x" }), "SIGHUP", 123)
    expect(log.status).toBe("stopped")
    expect(log.finished).toBe(123)
    expect(String(log.error)).toContain("SIGHUP")
    expect(log.nodes.map((n: any) => n.status)).toEqual(["done", "stopped", "stopped"])
  })

  it("abschliessen: Checkpoint + ergebnis.md, ergebnis: ist die letzte stdout-Zeile", () => {
    const dir = tmp()
    const log = gestoppt(logMit({ w: "Ausgabe" }), "SIGTERM")
    const out: string[] = []
    const pfad = abschliessen(log, buildScorecard(log, 1, [], Date.now()), { out: (s) => out.push(s), err: () => {} }, dir)
    expect(pfad).toBe(ergebnisPfad("run-T02", dir))
    expect(existsSync(pfad)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "openflow-checkpoint-run-T02.json"), "utf8")).status).toBe("stopped")
    const zeilen = out.join("\n").split("\n")
    expect(zeilen.at(-1)).toBe(`ergebnis: ${pfad}`)
    expect(zeilen).toContain("verdict: STOPPED · run run-T02 · stopped · 1 Wörter")
  })
})

// --- echter Prozess, echtes Signal ------------------------------------------

/** Ein Prozess mit dem Handler aus of-ergebnis und einem Run-Stand. */
function fixture(dir: string) {
  const f = join(dir, "fixture.ts")
  writeFileSync(
    f,
    `import { installiereSignalAbschluss } from ${JSON.stringify(join(SCRIPTS, "of-ergebnis.ts"))}
const log = ${JSON.stringify(logMit({ "worker-1": "Teilbefund" }))}
installiereSignalAbschluss({
  stand: () => ({ log, attempts: 1, predecessors: [], startedMs: Date.now() - 60_000 }),
  dir: ${JSON.stringify(dir)},
})
console.error("bereit")
setInterval(() => {}, 1000)
`,
  )
  return f
}

async function bisBereit(p: ReturnType<typeof Bun.spawn>, marke: string) {
  const reader = (p.stderr as ReadableStream<Uint8Array>).getReader()
  let text = ""
  const ende = Date.now() + 10_000
  while (!text.includes(marke) && Date.now() < ende) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return text
}

// POSIX-Signale: Windows kennt SIGTERM/SIGINT/SIGHUP an einen Prozess nicht
// (kill beendet hart). Die Fabrik läuft unter Linux/WSL.
const POSIX = process.platform !== "win32"

describe.skipIf(!POSIX)("T-02 echtes Signal", () => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
    it(`${sig}: Verdict stopped, ergebnis.md, letzte Zeile ergebnis:, Exit ${code}`, async () => {
      const dir = tmp()
      const p = Bun.spawn([process.execPath, fixture(dir)], { stdout: "pipe", stderr: "pipe" })
      await bisBereit(p, "bereit")
      p.kill(sig)
      const exit = await p.exited
      const stdout = await new Response(p.stdout).text()
      const pfad = ergebnisPfad("run-T02", dir)
      expect(exit).toBe(code)
      expect(stdout.trimEnd().split("\n").at(-1)).toBe(`ergebnis: ${pfad}`)
      expect(readFileSync(pfad, "utf8")).toContain("Teilbefund")
      const cp = JSON.parse(readFileSync(join(dir, "openflow-checkpoint-run-T02.json"), "utf8"))
      expect(cp.status).toBe("stopped")
      expect(cp.scorecard.verdict).toBe("STOPPED")
    })
  }
})

describe.skipIf(!POSIX)("T-02 headless-run.ts selbst", () => {
  // Fake-Flow-Store: nimmt die Pipeline-Anfrage an und antwortet nie — der
  // Lauf hängt so, wie ein echter an einer Karte hängt.
  let angefragt = false
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        angefragt = true
        return new Promise<Response>(() => {})
      },
    })
  })
  afterAll(() => server.stop(true))

  it("SIGTERM vor dem ersten Checkpoint: eigener Exit 143 + Meldung statt stillem Tod", async () => {
    const p = Bun.spawn([process.execPath, join(SCRIPTS, "headless-run.ts"), "auto-orchestrator", "aufgabe"], {
      env: { ...process.env, OPENFLOW_ORIGIN: `http://127.0.0.1:${server.port}`, OPENFLOW_ENGINE: "", OPENFLOW_AUTO_RETRY: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const ende = Date.now() + 10_000
    while (!angefragt && Date.now() < ende) await Bun.sleep(20)
    expect(angefragt).toBe(true)
    p.kill("SIGTERM")
    const exit = await p.exited
    const stderr = await new Response(p.stderr).text()
    expect(p.signalCode).toBeNull()
    expect(exit).toBe(143)
    expect(stderr).toContain("vor dem ersten Checkpoint")
  })
})
