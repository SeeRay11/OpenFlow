import { readFileSync } from "node:fs"

/**
 * Riegel gegen verschachtelte Fabrik-Starts.
 *
 * Anlass (Abnahme 12.10.2026): Die Boss-Karte eines auto-orchestrator-Runs
 * (dharma/power, mit Shell) startete selbst drei weitere `of-run.sh`-Läufe —
 * Verschachtelungstiefe 2, Kosten ×4.
 *
 * Warum keine Umgebungsvariable aus of-run.sh: Karten-Shells sind Kinder der
 * DAUERHAFT laufenden Engine (`… src/index.ts serve --port 4096`), nicht des
 * Runs. Gemessen 12.10.2026 in einer echten Karten-Shell: Eltern-Kette
 * `sh → bun … src/index.ts serve --port 4096 → vite → bun dev → bun openflow.ts`,
 * Umgebung = Engine-Umgebung plus `OPENCODE=1`/`OPENCODE_PID=<engine>` — nichts
 * vom Run. Was ein Run exportiert, erreicht seine Karten also nie.
 *
 * Erkannt wird deshalb die Herkunft selbst, auf zwei Wegen:
 *   1. `OPENFLOW_ENGINE=1` — setzt `opencode-process.ts` beim Start der Engine,
 *      jede Karten-Shell erbt es (billig, ohne /proc).
 *   2. ein Vorfahre ist die Engine des Forks (`packages/opencode … serve`) —
 *      greift auch bei einer Engine, die nicht von OpenFlow gestartet wurde
 *      oder vor diesem Riegel lief.
 * `OPENCODE=1` allein taugt NICHT: opencode 2.0 setzt es in jeder Shell, und
 * aus dessen Sitzungen ist der Fabrik-Start ausdrücklich erwünscht.
 */

export type Vorfahre = { pid: number; cmdline: string }

/** Engine des OpenFlow-Forks: `bun run --cwd packages/opencode … src/index.ts serve …`. */
export function istFabrikEngine(cmdline: string): boolean {
  return /\bpackages\/opencode\b/.test(cmdline) && /\bsrc\/index\.ts\s+serve\b/.test(cmdline)
}

/** Grund für die Ablehnung, oder null wenn der Start erlaubt ist. */
export function verschachtelterStart(
  env: Record<string, string | undefined>,
  vorfahren: Vorfahre[],
): string | null {
  if (env.OPENFLOW_ENGINE === "1") return "Umgebung trägt OPENFLOW_ENGINE=1 (Shell der Fabrik-Engine)"
  const engine = vorfahren.find((v) => istFabrikEngine(v.cmdline))
  if (engine) return `Vorfahre PID ${engine.pid} ist die Fabrik-Engine (${engine.cmdline.slice(0, 100)})`
  return null
}

/** Eltern-Kette ab `pid` (ohne sie selbst) aus /proc; leer, wo /proc fehlt. */
export function vorfahrenAus(pid: number, lese: (pfad: string) => string = (p) => readFileSync(p, "utf8")): Vorfahre[] {
  const kette: Vorfahre[] = []
  let aktuell = pid
  for (let i = 0; i < 64; i++) {
    let stat: string
    try {
      stat = lese(`/proc/${aktuell}/stat`)
    } catch {
      break
    }
    // Feld 2 (comm) steht in Klammern und darf Leerzeichen enthalten.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
    if (!Number.isFinite(ppid) || ppid <= 1) break
    let cmdline = ""
    try {
      cmdline = lese(`/proc/${ppid}/cmdline`).split("\0").join(" ").trim()
    } catch {}
    kette.push({ pid: ppid, cmdline })
    aktuell = ppid
  }
  return kette
}

export const ABLEHNUNG = "verschachtelter Fabrik-Start aus Karte abgelehnt"
