import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { istFabrikEngine, verschachtelterStart, vorfahrenAus } from "./fabrik-guard"

// Gemessen 12.10.2026 in einer echten Karten-Shell (Run smoke-orch).
const ENGINE = "bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096"
const KETTE_KARTE = [
  { pid: 14251, cmdline: ENGINE },
  { pid: 14003, cmdline: "node /home/thoma/workspace/OpenFlow/packages/flow/node_modules/.bin/vite" },
  { pid: 13985, cmdline: "bun openflow.ts" },
]

describe("fabrik-guard", () => {
  test("die Fork-Engine wird erkannt, opencode 2.0 und vite nicht", () => {
    expect(istFabrikEngine(ENGINE)).toBe(true)
    expect(istFabrikEngine("/home/thoma/.opencode/bin/opencode serve --service")).toBe(false)
    expect(istFabrikEngine("opencode serve --port 4096")).toBe(false)
    expect(istFabrikEngine(KETTE_KARTE[1].cmdline)).toBe(false)
  })

  test("Karten-Shell (Engine als Vorfahre) wird abgelehnt", () => {
    expect(verschachtelterStart({ OPENCODE: "1" }, KETTE_KARTE)).toContain("PID 14251")
  })

  test("OPENFLOW_ENGINE=1 genügt allein, auch ohne Vorfahren", () => {
    expect(verschachtelterStart({ OPENFLOW_ENGINE: "1" }, [])).toContain("OPENFLOW_ENGINE")
  })

  test("Gegenprobe: OPENCODE=1 einer opencode-2.0-Sitzung bleibt erlaubt", () => {
    const kette = [{ pid: 6628, cmdline: "/home/thoma/.opencode/bin/opencode serve --service" }]
    expect(verschachtelterStart({ OPENCODE: "1", OPENCODE_PID: "6628" }, kette)).toBeNull()
    expect(verschachtelterStart({ OPENFLOW_ENGINE: "0" }, [])).toBeNull()
  })

  test("vorfahrenAus liest die Kette aus /proc, auch mit Klammern im comm-Feld", () => {
    const proc: Record<string, string> = {
      "/proc/833/stat": "833 (sh) S 14251 833 833 0",
      "/proc/14251/stat": "14251 (bun (x) y) S 14003 1 1 0",
      "/proc/14251/cmdline": ENGINE.split(" ").join("\0") + "\0",
      "/proc/14003/stat": "14003 (node) S 1 1 1 0",
      "/proc/14003/cmdline": "node\0vite\0",
    }
    const lese = (p: string) => {
      if (!(p in proc)) throw new Error("ENOENT")
      return proc[p]
    }
    expect(vorfahrenAus(833, lese)).toEqual([
      { pid: 14251, cmdline: ENGINE },
      { pid: 14003, cmdline: "node vite" },
    ])
  })
})

describe("of-run.sh mit Riegel", () => {
  const script = join(import.meta.dir, "../scripts/of-run.sh")
  // Seit Defekt 5 (23.10.2026) schreibt of-run.sh einen abgebrochenen Start ins
  // Ledger — Tests nie ins echte (~/.openflow/gate-ledger.jsonl).
  const ledger = join(mkdtempSync(join(tmpdir(), "fabrik-guard-")), "ledger.jsonl")
  const run = (args: string[], env: Record<string, string>) =>
    Bun.spawnSync(["bash", script, ...args], { env: { ...process.env, OPENFLOW_LEDGER: ledger, ...env }, stdout: "pipe", stderr: "pipe" })

  test("Start aus einer Karte: Exit 3, Meldung, kein Run gestartet", () => {
    const r = run(["guard-test-gibt-es-nicht", "x"], { OPENFLOW_ENGINE: "1" })
    expect(r.exitCode).toBe(3)
    expect(r.stderr.toString()).toContain("verschachtelter Fabrik-Start aus Karte abgelehnt")
    expect(r.stdout.toString()).not.toContain("PID=")
    expect(r.stdout.toString()).not.toContain("LOG=")
    expect(readFileSync(ledger, "utf8")).toContain('"event":"fabrik_start_fehlgeschlagen"')
  })

  test("Monitoring bleibt aus einer Karte erlaubt (--reap --dry-run)", () => {
    // eigenes, leeres runs-Verzeichnis: ohne lief der Test nur auf einem Rechner
    // mit ~/workspace/flow-lab (CI: of-reap „runs-dir fehlt", Exit 2)
    const runs = mkdtempSync(join(tmpdir(), "fabrik-guard-runs-"))
    const r = run(["--reap", "--dry-run", "--runs-dir", runs], { OPENFLOW_ENGINE: "1" })
    expect(r.exitCode).toBe(0)
    expect(r.stderr.toString()).not.toContain("abgelehnt")
  })

  test("of-guard.ts ohne Fabrik-Herkunft: Exit 0", () => {
    const env = { ...process.env }
    delete env.OPENFLOW_ENGINE
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/of-guard.ts")], { env })
    expect(r.exitCode).toBe(0)
  })
})
