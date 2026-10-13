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
