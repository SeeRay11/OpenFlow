/**
 * of-ergebnis — was headless-run am Ende eines Laufs meldet, als reine
 * Funktionen (testbar ohne Engine, ohne Prozessstart).
 *
 * K11 (12.10.2026): Ein Resume übernahm 2 fertige Karten aus dem Checkpoint
 * (worker-1, worker-3 von run-2026-10-12T14-03-22-434Z), der boss scheiterte
 * vor jedem Dispatch, die Engine trug beide Karten als `skipped` — ihr Output
 * war im neuen Log weg. Der Auto-Retry säte daraus „0 Karte(n) gehalten", und
 * die SCORECARD meldete `reused 0` und 0 Wörter. `uebernimm` legt das
 * Übernommene deshalb in den Log zurück, bevor gesät, gezählt oder gedruckt
 * wird — eine Karte, die nicht lief, behält das Ergebnis, das sie schon hatte.
 *
 * (c) (12.10.2026): Die Zeile `checkpoint: <pfad>` stand VOR den Karten-
 * Outputs; ein Modelltext mit einer eigenen Zeile „checkpoint: /…json" kam
 * danach, und Leser, die die letzte Zeile nehmen (openflow-status:
 * `[...matchAll(/^checkpoint: …$/gm)].pop()`), nahmen die des Modells.
 * `bericht` schreibt die Engine-Zeile deshalb als LETZTE Zeile, auf
 * demselben Kanal wie die Outputs (stdout), damit keine Pufferung zwischen
 * stdout und stderr die Reihenfolge im Log umdrehen kann.
 */

import { writeFileSync } from "node:fs"
import { recordedTurns, type RecordedTurn } from "../src/server/turn-hash"

export interface Scorecard {
  runId: string
  pipeline: string
  verdict: string
  attempts: number
  predecessors: string[]
  nodes: { total: number; done: number; error: number; stopped: number; skipped: number; reused: number }
  durationSec: number | null
  outputWords: number
  outputChars: number
}

/**
 * Seeds a continuation from a run log: done cards keep their output, and every
 * card that held a session names it. A done card's session is not reopened in
 * a pipeline (the engine drops it); in an orchestration the orchestrator's
 * later turns continue there, which is what keeps their context.
 */
export function seedFrom(log: any, outputs: Record<string, string>, held: Record<string, string>) {
  for (const node of log?.nodes ?? []) {
    if (node.status === "done" && typeof node.output === "string") outputs[node.id] = node.output
    if (node.sessionID) held[node.id] = node.sessionID
  }
}

/**
 * K7: die aufgezeichneten Züge jeder fertigen Karte (Eingabe-Hash + Antwort),
 * damit die Engine eine Karte nur übernimmt, wenn ihre Eingabe dieselbe ist —
 * auch wenn der Orchestrator sie neu anlegt. Alte Logs ohne `turns`: der
 * letzte Prompt gilt als Zug 1 (siehe `recordedTurns`).
 */
export function turnsFrom(log: any, turns: Record<string, RecordedTurn[]>) {
  for (const node of log?.nodes ?? []) {
    const recorded = recordedTurns(node)
    if (recorded) turns[node.id] = recorded
  }
}

/**
 * Vorgänger eines Laufs für die SCORECARD: der Checkpoint-Lauf, aus dem
 * fortgesetzt wurde (falls Resume), dann die früheren Versuche dieses
 * Prozesses. Abnahme R13 K11: ein Resume meldete `predecessors: []`.
 */
export function vorgaenger(resumeId: string | undefined, versuche: string[]): string[] {
  return [...(resumeId ? [resumeId] : []), ...versuche.slice(0, -1)]
}

/** Zustände, in denen eine Karte in DIESEM Versuch nichts eigenes geliefert hat. */
const OHNE_EIGENES = new Set(["skipped", "stopped", "queued", "idle", undefined])

/**
 * Legt übernommene Outputs in den Log zurück: jede Karte, die in diesem
 * Versuch nicht lief (skipped/stopped/queued/idle) und aus einem früheren Lauf
 * einen Output hat, wird `done` + `reused` mit diesem Output. Eine Karte, die
 * in diesem Versuch `error` oder `done` endete, bleibt, wie sie ist — ihr
 * eigener Ausgang ist die Wahrheit. Gibt die Zahl zurückgelegter Karten.
 */
export function uebernimm(log: any, outputs: Record<string, string>, held: Record<string, string> = {}): number {
  let n = 0
  for (const node of log?.nodes ?? []) {
    const seed = outputs[node?.id]
    if (seed === undefined || !OHNE_EIGENES.has(node.status)) continue
    node.status = "done"
    node.output = seed
    node.reused = true
    delete node.error
    if (!node.sessionID && held[node.id]) node.sessionID = held[node.id]
    n++
  }
  return n
}

/**
 * K11 (R18): was die Startzeile „angeboten" hat, gegen das, was die Engine
 * wirklich übernommen hat (`reused`). Ein Resume meldete „3 card(s) kept" und
 * die SCORECARD `reused 0` — die Worker liefen neu. Die Zahl hier IST die der
 * SCORECARD (dieselbe Eigenschaft), und neu Gerechnetes steht namentlich da.
 */
export function uebernahme(log: any, angeboten: string[]) {
  const reused = new Set((log?.nodes ?? []).filter((n: any) => n?.reused).map((n: any) => n.id as string))
  const uebernommen = (log?.nodes ?? []).filter((n: any) => n?.reused).map((n: any) => n.id as string)
  const neu = angeboten.filter((id) => !reused.has(id))
  const zeile = angeboten.length
    ? `übernommen: ${uebernommen.length} von ${angeboten.length} angebotenen Karte(n)${neu.length ? ` — neu gerechnet: ${neu.join(", ")}` : ""}`
    : ""
  return { uebernommen, neu, zeile }
}

export function buildScorecard(log: any, attempts: number, predecessors: string[], startedMs: number, now = Date.now()): Scorecard {
  const nodes: any[] = Array.isArray(log.nodes) ? log.nodes : []
  const count = (s: string) => nodes.filter((n) => n?.status === s).length
  const outputs = nodes.filter((n) => n?.status === "done" && typeof n.output === "string").map((n) => n.output as string)
  const durationSec = typeof log.finished === "number" && typeof log.started === "number"
    ? Math.round((log.finished - log.started) / 1000)
    : Math.round((now - startedMs) / 1000)
  return {
    runId: log.id,
    pipeline: log.pipeline,
    verdict: log.status === "done" ? (attempts > 1 ? "PASS_RETRIED" : "PASS") : log.status === "error" ? "FAIL" : String(log.status).toUpperCase(),
    attempts,
    predecessors,
    nodes: {
      total: nodes.length,
      done: count("done"),
      error: count("error"),
      stopped: count("stopped"),
      skipped: count("skipped"),
      reused: nodes.filter((n) => n?.reused).length,
    },
    durationSec,
    outputWords: outputs.reduce((a, o) => a + o.split(/\s+/).filter(Boolean).length, 0),
    outputChars: outputs.reduce((a, o) => a + o.length, 0),
  }
}

/** Die Engine-Zeile, die Leser des Logs als Checkpoint nehmen. */
export const checkpointZeile = (id: string) => `checkpoint: /tmp/openflow-checkpoint-${id}.json`

/**
 * Schlussbericht in Log-Reihenfolge. `out` = stdout (Ergebnis), `err` =
 * stderr (Status). Die Checkpoint-Zeile kommt zuletzt und auf `out`: nach
 * allen Modelltexten, im selben Strom wie sie.
 */
export function bericht(log: any, scorecard: Scorecard, io: { out: (s: string) => void; err: (s: string) => void }) {
  io.out(`=== SCORECARD ===\n${JSON.stringify(scorecard, null, 2)}`)
  for (const node of log.nodes ?? []) {
    io.err(`[${node.id}] ${node.status}`)
    if (node.output !== undefined) io.out(`=== ${node.id} ===\n${node.output}`)
  }
  io.err(`run ${log.id}: ${log.status} — verdict ${scorecard.verdict} (${scorecard.attempts} Versuch(e), ${scorecard.outputWords} Wörter Output)`)
  io.out(checkpointZeile(log.id))
}

// ---------------------------------------------------------------------------
// W2.2 (Plan „Autonomie 10/10", A10, 23.10.2026): JEDES Ende läuft durch
// einen Abschlusspunkt. Vorher hatte headless-run keinen Signal-Handler — ein
// Reap (SIGTERM), Strg-C (SIGINT) oder ein geschlossenes Terminal (SIGHUP)
// beendete ihn ohne Verdict, ohne Bericht, ohne etwas Lesbares für die
// aufrufende Sitzung. Jetzt schreibt jedes Ende — regulär oder per Signal —
// Checkpoint + `ergebnis.md` und nennt den Pfad als letzte stdout-Zeile.

/** Obergrenze der ergebnis.md (Byte, UTF-8). */
export const ERGEBNIS_MAX_BYTES = 25 * 1024

/** Die ergebnis.md liegt neben dem Checkpoint und teilt seinen Stamm. */
export const ergebnisPfad = (id: string, dir = "/tmp") => `${dir}/openflow-checkpoint-${id}.ergebnis.md`
export const checkpointPfad = (id: string, dir = "/tmp") => `${dir}/openflow-checkpoint-${id}.json`

/** Exit-Code je Signal (128 + Signalnummer, wie die Shell ihn meldet). */
export const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const
export type AbbruchSignal = keyof typeof SIGNAL_EXIT

/** Kürzt auf höchstens `max` Byte UTF-8, ohne ein Zeichen zu zerschneiden. */
function aufBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= max) return text
  let end = max
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/** Markdown: Kopf, Scorecard, Karten-Outputs — höchstens `max` Byte, gekürzt mit Hinweis. */
export function ergebnisMarkdown(log: any, scorecard: Scorecard, max = ERGEBNIS_MAX_BYTES, dir = "/tmp"): string {
  const teile: string[] = [
    `# Ergebnis ${log.id}`,
    "",
    `- Pipeline: ${log.pipeline ?? "?"}`,
    `- Verdict: ${scorecard.verdict} (Status ${log.status}, ${scorecard.attempts} Versuch(e), ${scorecard.outputWords} Wörter)`,
    ...(log.error ? [`- Fehler: ${String(log.error)}`] : []),
    `- Checkpoint: ${checkpointPfad(log.id, dir)}`,
    "",
    "## Scorecard",
    "",
    "```json",
    JSON.stringify(scorecard, null, 2),
    "```",
  ]
  for (const node of log.nodes ?? []) {
    teile.push("", `## ${node.id} — ${node.status}${node.reused ? " (übernommen)" : ""}`, "")
    if (typeof node.output === "string" && node.output) teile.push(node.output)
    else if (node.error) teile.push(`Fehler: ${String(node.error)}`)
    else teile.push("(kein Output)")
  }
  const voll = teile.join("\n") + "\n"
  const gesamt = Buffer.byteLength(voll, "utf8")
  if (gesamt <= max) return voll
  const hinweis = `\n\n… gekürzt: ${max} von ${gesamt} Byte — vollständig im Checkpoint ${checkpointPfad(log.id, dir)}\n`
  return aufBytes(voll, max - Buffer.byteLength(hinweis, "utf8")) + hinweis
}

/** Kopie eines abgebrochenen Laufs: Run und alle noch offenen Karten `stopped`. */
export function gestoppt(log: any, signal: string, jetzt = Date.now()): any {
  const offen = new Set(["running", "queued", "idle"])
  return {
    ...log,
    status: log?.status === "running" || log?.status === undefined ? "stopped" : log.status,
    error: log?.error ?? `abgebrochen: ${signal}`,
    finished: typeof log?.finished === "number" ? log.finished : jetzt,
    stoppedBySignal: { signal, at: new Date(jetzt).toISOString() },
    nodes: (log?.nodes ?? []).map((n: any) => (offen.has(n?.status) ? { ...n, status: "stopped" } : n)),
  }
}

/**
 * Der eine Abschluss: Checkpoint + ergebnis.md schreiben (synchron — ein
 * SIGKILL danach verliert nichts mehr), Bericht drucken, dann `verdict:` und
 * `ergebnis: <pfad>` als LETZTE stdout-Zeile. Gibt den ergebnis-Pfad zurück.
 */
export function abschliessen(
  log: any,
  scorecard: Scorecard,
  io: { out: (s: string) => void; err: (s: string) => void },
  dir = "/tmp",
): string {
  try {
    writeFileSync(checkpointPfad(log.id, dir), JSON.stringify({ ...log, scorecard }, null, 2))
  } catch (error) {
    io.err(`checkpoint nicht geschrieben: ${String(error)}`)
  }
  const pfad = ergebnisPfad(log.id, dir)
  try {
    writeFileSync(pfad, ergebnisMarkdown(log, scorecard, ERGEBNIS_MAX_BYTES, dir))
  } catch (error) {
    io.err(`ergebnis.md nicht geschrieben: ${String(error)}`)
  }
  bericht(log, scorecard, io)
  io.out(`verdict: ${scorecard.verdict} · run ${log.id} · ${log.status} · ${scorecard.outputWords} Wörter`)
  io.out(`ergebnis: ${pfad}`)
  return pfad
}

export interface LaufStand {
  log: any
  attempts: number
  predecessors: string[]
  startedMs: number
}

/**
 * Handler für SIGTERM/SIGINT/SIGHUP. `stand()` liefert den aktuellen Lauf
 * (oder `undefined` vor dem ersten Checkpoint); `nachher` erledigt
 * Best-effort-Arbeit (Store-PUT, Sessions stoppen) mit Zeitlimit. Ein zweites
 * Signal während des Abschlusses wird ignoriert; nach `limitMs` endet der
 * Prozess in jedem Fall.
 */
export function installiereSignalAbschluss(opts: {
  stand: () => LaufStand | undefined
  dir?: string
  nachher?: (log: any) => Promise<unknown>
  limitMs?: number
  proc?: { on: (sig: string, fn: () => void) => unknown; exit: (code: number) => never | void }
  io?: { out: (s: string) => void; err: (s: string) => void }
}) {
  const proc = opts.proc ?? process
  const io = opts.io ?? { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }
  const limit = opts.limitMs ?? 4_000
  let laeuft = false
  for (const sig of Object.keys(SIGNAL_EXIT) as AbbruchSignal[]) {
    proc.on(sig, () => {
      if (laeuft) return
      laeuft = true
      const code = SIGNAL_EXIT[sig]
      const stand = opts.stand()
      if (!stand?.log?.id) {
        io.err(`headless-run: abgebrochen (${sig}) vor dem ersten Checkpoint — kein Run-Log, nichts zu sichern`)
        proc.exit(code)
        return
      }
      const log = gestoppt(stand.log, sig)
      const scorecard = buildScorecard(log, stand.attempts, stand.predecessors, stand.startedMs)
      log.scorecard = scorecard
      io.err(`headless-run: ${sig} — Run ${log.id} wird als stopped abgeschlossen`)
      abschliessen(log, scorecard, io, opts.dir)
      const zeit = new Promise((r) => setTimeout(r, limit))
      void Promise.race([Promise.resolve(opts.nachher?.(log)).catch(() => undefined), zeit]).finally(() => proc.exit(code))
    })
  }
}
