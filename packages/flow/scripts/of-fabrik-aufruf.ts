/**
 * of-fabrik-aufruf — DIE Regel, was ein Aufruf von of-run.sh ist: ein echter
 * Run-Start, eine Monitoring-Sonde oder ein abgelehnter Aufruf.
 *
 * Anlass (Ledger 16.–23.10.2026): 6 fabrik_run ohne monitoring-Flag standen
 * 4 Run-Datensätzen gegenüber. Zwei davon waren keine Starts:
 *   - `cat > plugin-test.mjs <<'EOF' … 'bash of-run.sh auto-orchestrator' … EOF`
 *     — of-run.sh stand nur im Heredoc-RUMPF (Daten), und `isMonitoringRun`
 *     im Plugin prüfte per `indexOf`/Regex auf dem ganzen Text: das erste
 *     „of-run.sh" lag im Rumpf, `auto-orchestrator`/`--resume` im Rumpf
 *     hoben die Monitoring-Einstufung auf.
 *   - `…of-run.sh --loop-check; …` — das Semikolon klebte am Schalter.
 * Beides sind Textsuchen auf einem Shell-Befehl. Hier entscheidet die
 * Argumentliste NACH dem Skript, und zwar mit genau der Verzweigung, die
 * of-run.sh selbst fährt (Monitoring-Schalter nur an $1, dann --wait,
 * --resume <id>, --spread, dann die Pipeline; ein `-…` dort lehnt of-run.sh ab).
 *
 * Zwei Zerleger, eine Regel:
 *   - Das fabrik-gate-Plugin hat einen vollständigen Shell-Zerleger
 *     (plugins-shared/befehl.ts) und reicht dessen argv an `ofRunModus`.
 *   - Für ALTE Ledger-Zeilen (ohne `art`, Befehl auf 200 Zeichen gekürzt)
 *     zerlegt `ofRunAufrufe` den gespeicherten Text selbst: Heredoc-Rümpfe
 *     sind Daten (offener Rumpf bis zum Ende — so kürzt das Ledger), Zitate
 *     sind Daten, Trenner ; & | && || und Zeilenumbruch beginnen einen Befehl.
 */

export type OfRunArt = "start" | "monitoring" | "abgelehnt"

/** of-run.sh Zeilen 41–45: diese Schalter an $1 führen nie einen Run. */
export const MONITORING_SCHALTER = ["--scorecard", "--reap", "--loop", "--loop-check", "--nutzung"]

/** Argumente NACH of-run.sh → was of-run.sh damit tut. */
export function ofRunModus(args: string[]): OfRunArt {
  let i = 0
  if (MONITORING_SCHALTER.includes(args[0] ?? "")) return "monitoring"
  if (args[i] === "--wait") i++
  if (args[i] === "--resume") {
    if (args[i + 1] === undefined) return "abgelehnt"
    i += 2
  }
  if (args[i] === "--spread") i++
  const pipeline = args[i]
  if (pipeline !== undefined && pipeline.startsWith("-")) return "abgelehnt"
  return "start"
}

const basis = (w: string) => w.replace(/^.*\//, "")

/** Heredoc-Rümpfe entfernen; ein offener Rumpf läuft bis zum Textende (gekürzte Ledger-Zeile). */
function ohneHeredocRuempfe(cmd: string): string {
  let aus = ""
  let pos = 0
  const kopf = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g
  for (;;) {
    kopf.lastIndex = pos
    const m = kopf.exec(cmd)
    if (!m) return aus + cmd.slice(pos)
    aus += cmd.slice(pos, m.index) + cmd.slice(m.index, m.index + m[0].length - 1) // Kopfzeile ohne \n
    const rumpfStart = m.index + m[0].length
    const ende = new RegExp(`^[\\t]*${m[2]}[ \\t]*$`, "m")
    ende.lastIndex = 0
    const rest = cmd.slice(rumpfStart)
    const e = ende.exec(rest)
    if (!e) return aus // offener Rumpf: alles Weitere ist Daten
    aus += "\n"
    pos = rumpfStart + e.index + e[0].length
  }
}

/** Einfache, zitatbewusste Zerlegung in Befehle (argv je Befehl). */
function zerlege(cmd: string): string[][] {
  const befehle: string[][] = []
  let argv: string[] = []
  let wort = ""
  let hatWort = false
  const wortEnde = () => {
    if (hatWort) argv.push(wort)
    wort = ""
    hatWort = false
  }
  const befehlEnde = () => {
    wortEnde()
    if (argv.length) befehle.push(argv)
    argv = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      wort += j < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, j)
      hatWort = true
      if (j < 0) break
      i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) j++
        wort += cmd[j]
        j++
      }
      hatWort = true
      i = j
    } else if (c === "\\" && i + 1 < cmd.length) {
      wort += cmd[++i]
      hatWort = true
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      befehlEnde()
    } else if (c === " " || c === "\t") {
      wortEnde()
    } else {
      wort += c
      hatWort = true
    }
  }
  befehlEnde()
  return befehle
}

// Vorsilben, nach denen das eigentliche Befehlswort folgt.
const VORSILBEN = new Set(["sudo", "env", "nohup", "setsid", "time", "exec", "command", "nice", "stdbuf"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash"])

function ofRunInArgv(argv: string[], tiefe: number): OfRunArt[] {
  let i = 0
  while (i < argv.length) {
    const w = argv[i]
    if (/^[A-Za-z_]\w*=/.test(w)) { i++; continue } // VAR=wert
    const b = basis(w)
    if (VORSILBEN.has(b)) { i++; while (argv[i]?.startsWith("-")) i++; continue }
    if (b === "timeout") { i++; while (argv[i]?.startsWith("-")) i++; i++; continue } // Dauer
    if (SHELLS.has(b)) {
      i++
      while (argv[i]?.startsWith("-")) {
        if (argv[i] === "-c" && argv[i + 1] !== undefined && tiefe < 3) return ofRunAufrufe(argv[i + 1], tiefe + 1)
        i++
      }
      continue
    }
    if (b === "of-run.sh") return [ofRunModus(argv.slice(i + 1))]
    return []
  }
  return []
}

/** Alle of-run.sh-AUFRUFE eines (evtl. gekürzten) Befehlstexts, je mit Art. */
export function ofRunAufrufe(cmd: string, tiefe = 0): OfRunArt[] {
  if (!cmd.includes("of-run.sh")) return []
  return zerlege(ohneHeredocRuempfe(cmd)).flatMap((argv) => ofRunInArgv(argv, tiefe))
}

/** Gesamtart eines Befehls: start schlägt monitoring schlägt abgelehnt; null = kein Aufruf. */
export function artAusBefehl(cmd: string): OfRunArt | null {
  const arten = ofRunAufrufe(cmd)
  if (arten.includes("start")) return "start"
  if (arten.includes("monitoring")) return "monitoring"
  if (arten.includes("abgelehnt")) return "abgelehnt"
  return null
}

/**
 * Art eines Ledger-Eintrags event=fabrik_run:
 *   - neue Zeilen tragen `art` (vom Plugin über `ofRunModus` bestimmt)
 *   - alte mit monitoring:true bleiben Monitoring
 *   - alte ohne Flag: aus dem gespeicherten Befehl; ohne Befehl (sehr alte
 *     Zeilen, `of-gate.ts log --event fabrik_run`) gilt der Eintrag als Start
 */
export function fabrikRunArt(e: any): OfRunArt | null {
  if (e?.event !== "fabrik_run") return null
  if (e.art === "start" || e.art === "monitoring" || e.art === "abgelehnt") return e.art
  if (e.monitoring === true) return "monitoring"
  if (typeof e.command !== "string") return "start"
  return artAusBefehl(e.command)
}

/** Ein fabrik_run, der wirklich einen Run startet — und dessen Start nicht nachweislich scheiterte. */
export function istEchterStart(e: any, fehlgeschlagen: Set<string> = new Set()): boolean {
  if (fabrikRunArt(e) !== "start") return false
  return !(typeof e.aufruf_id === "string" && fehlgeschlagen.has(e.aufruf_id))
}

/** aufruf_id aller Starts, die das Plugin als gescheitert gemeldet hat (event fabrik_start_fehlgeschlagen). */
export function gescheiterteStarts(entries: any[]): Set<string> {
  return new Set(
    entries
      .filter((e) => e?.event === "fabrik_start_fehlgeschlagen" && typeof e.aufruf_id === "string")
      .map((e) => e.aufruf_id as string),
  )
}

/** Alle echten Starts eines Ledgers (gescheiterte abgezogen). */
export function echteStarts(entries: any[]): any[] {
  const weg = gescheiterteStarts(entries)
  return entries.filter((e) => istEchterStart(e, weg))
}
