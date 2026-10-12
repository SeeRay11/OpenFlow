/**
 * The Run button, without the canvas.
 *
 * The engine runs in the page: `start` in src/server/engine.ts is plain
 * TypeScript, but its `api` dependency (src/server/client.ts) resolves the
 * engine through `window.location.origin` — the vite dev server, whose proxy
 * carries the engine password so the browser never needs it. A headless caller
 * gets the same service by faking `window` to the canvas origin and importing
 * the same modules, so run orchestration, prompts, permissions and usage all
 * come from the tested engine path rather than a reimplementation.
 *
 * Usage:
 *   bun packages/flow/scripts/headless-run.ts <pipeline-name> [task words...]
 *
 * What it does, in the canvas's own order:
 *   1. loads the pipeline from the flow store (GET /flow/api/pipelines/:name)
 *   2. merges the per-node agent defs (POST .../agents?merge=1), the same
 *      write the canvas does before every run
 *   3. connects the engine client through the dev-server proxy
 *   4. starts the run with permissions on "auto"; arriving questions are
 *      rejected so each card continues on its own assumption instead of
 *      stalling an unattended run
 *   5. checkpoints the run log to the flow store (PUT /flow/api/runs/:id), so
 *      the run shows up in the canvas's Runs menu like any other
 *
 * Exit code 0 only when the run log ends "done". Node outputs print to stdout,
 * everything else goes to stderr.
 */

;(globalThis as unknown as { window: unknown }).window = {
  location: { origin: process.env.OPENFLOW_ORIGIN ?? "http://127.0.0.1:5174" },
}

import { start } from "../src/server/engine"
import * as api from "../src/server/client"
import { agentBlock } from "../src/server/store"
import { isPipeline } from "../src/graph/pipeline-io"
import { ABLEHNUNG, verschachtelterStart, vorfahrenAus } from "../lib/fabrik-guard"

// Riegel gegen verschachtelte Runs auch für den direkten Aufruf ohne of-run.sh
// (Begründung in lib/fabrik-guard.ts).
const verschachtelt = verschachtelterStart(process.env, vorfahrenAus(process.pid))
if (verschachtelt) {
  console.error(`headless-run: ${ABLEHNUNG} — ${verschachtelt}`)
  process.exit(3)
}

const origin = process.env.OPENFLOW_ORIGIN ?? "http://127.0.0.1:5174"

// `connect()` fetches relative paths ("/flow/api/context") - legal in a page,
// invalid in bun. Rewrite relative URLs to the canvas origin before they leave.
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/")) input = origin + input
  return realFetch(input, init)
}) as typeof fetch

// bun exits on an unhandled rejection by default; a run that dies mid-run
// loses its log with it. The engine callbacks already catch their own errors,
// so anything reaching here is a wiring bug - report it and keep the run.
process.on("unhandledRejection", (reason) => console.error(`[unhandledRejection] ${String(reason)}`))
process.on("uncaughtException", (error) => console.error(`[uncaughtException] ${error.stack ?? error}`))
// `--resume <checkpoint-path|run-id>` continues an interrupted run: finished
// cards keep their output (no session, no cost), the rest are prompted in the
// sessions they already hold - the same contract the canvas's resume uses.
const argv = process.argv.slice(2)
const spread = argv.includes("--spread")
const rest0 = argv.filter((a) => a !== "--spread")
const resumeIdx = rest0.indexOf("--resume")
const resumeRef = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined
const rest = resumeIdx >= 0 ? [...rest0.slice(0, resumeIdx), ...rest0.slice(resumeIdx + 2)] : rest0
let name = rest[0]
let input = rest.slice(1).join(" ")
const initialResume: Record<string, string> = {}
const initialSessions: Record<string, string> = {}
if (resumeRef !== undefined) {
  const path = resumeRef.startsWith("/") ? resumeRef : `/tmp/openflow-checkpoint-${resumeRef}.json`
  // Ein trunkierter Checkpoint (Crash mitten im Bun.write) ist ein harter
  // Fehler mit klarer Meldung — kein uncaughtException-Labyrinth.
  let log: any
  try {
    log = JSON.parse(await Bun.file(path).text())
  } catch (error) {
    console.error(`checkpoint unlesbar (${path}): ${String(error)} — Checkpoint neu anlegen oder Run neu starten`)
    process.exit(2)
  }
  name = log.pipeline
  if (!input) input = log.input ?? ""
  for (const node of log.nodes ?? []) {
    if (node.status === "done" && typeof node.output === "string") initialResume[node.id] = node.output
    else if (node.sessionID) initialSessions[node.id] = node.sessionID
  }
  console.error(
    `resuming ${log.id} - ${Object.keys(initialResume).length} card(s) kept, ${Object.keys(initialSessions).length} continued in session`,
  )
}
if (!name) {
  console.error("usage: bun packages/flow/scripts/headless-run.ts [--resume <checkpoint|run-id>] <pipeline-name> [task words...]")
  process.exit(2)
}

async function flow<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${origin}/flow/api/${path}`, init)
  if (!response.ok) throw new Error(`flow store ${path} -> ${response.status} ${await response.text().catch(() => "")}`)
  return (await response.json()) as T
}

const pipeline = await flow<unknown>(`pipelines/${encodeURIComponent(name)}`)
if (!isPipeline(pipeline)) throw new Error(`"${name}" did not load as a pipeline`)

const servers = await flow<Array<{ name: string }>>("mcp")
const names = servers.map((entry) => entry.name)
const merged = await flow(`pipelines/${encodeURIComponent(name)}/agents?merge=1`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(agentBlock(pipeline, names)),
})
console.error(`agents merged (${names.length} mcp server(s) known)`)

await api.connect()

// --spread: deterministisches Modell-Round-Robin ueber die Karten — Karte i
// kriegt SPREAD_MODELS[i % laenge] (a=1, b=2, c=3, d=1, ...). Quality-Heads
// bewusst: qwen3.8-27b bleibt draussen (Messbefund 18.09.2026).
const SPREAD_MODELS = (process.env.OPENFLOW_SPREAD ?? "dharma/fast,dharma/balanced,dharma/power").split(",").map((m) => m.trim()).filter(Boolean)
if (spread) {
  pipeline.nodes.forEach((node, i) => {
    node.agent = { ...node.agent, model: SPREAD_MODELS[i % SPREAD_MODELS.length] }
  })
  console.error(`spread: ${pipeline.nodes.length} card(s) over ${SPREAD_MODELS.join(", ")}`)
}
// Auto-Retry (v1.5.0): Ein Run, der mit error endet, wird über das eigene
// Checkpoint-Resume erneut gestartet — done-Karten behalten ihr Output (keine
// Kosten), die Karten, die den Run brachen, laufen in ihren Sessions nochmal.
// Beweisfall 20.09.2026: 2 saubere Worker-Reports, 1 Knoten-Error, Rest
// skipped, niemand startete neu. OPENFLOW_AUTO_RETRY=0 schaltet ab (Default 1).
const AUTO_RETRY = Math.max(0, Number(process.env.OPENFLOW_AUTO_RETRY ?? "1"))
const attemptsMax = 1 + AUTO_RETRY

interface Scorecard {
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

function buildScorecard(log: any, attempts: number, predecessors: string[], startedMs: number): Scorecard {
  const nodes: any[] = Array.isArray(log.nodes) ? log.nodes : []
  const count = (s: string) => nodes.filter((n) => n?.status === s).length
  const outputs = nodes.filter((n) => n?.status === "done" && typeof n.output === "string").map((n) => n.output as string)
  const durationSec = typeof log.finished === "number" && typeof log.started === "number"
    ? Math.round((log.finished - log.started) / 1000)
    : Math.round((Date.now() - startedMs) / 1000)
  return {
    runId: log.id,
    pipeline: log.pipeline,
    verdict: log.status === "done" ? (attempts > 1 ? "PASS_RETRIED" : "PASS") : log.status === "error" ? "FAIL" : log.status.toUpperCase(),
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

const startedMs = Date.now()
const predecessors: string[] = []
let log: any
for (let attempt = 1; attempt <= attemptsMax; attempt++) {
  const resumeOutputs: Record<string, string> = attempt === 1 ? { ...initialResume } : {}
  const resumeSessions: Record<string, string> = attempt === 1 ? { ...initialSessions } : {}
  if (attempt > 1 && log) {
    for (const node of log.nodes ?? []) {
      if (node.status === "done" && typeof node.output === "string") resumeOutputs[node.id] = node.output
      else if (node.sessionID) resumeSessions[node.id] = node.sessionID
    }
    console.error(
      `auto-retry ${attempt}/${attemptsMax}: ${Object.keys(resumeOutputs).length} Karte(n) gehalten, ${Object.keys(resumeSessions).length} in Session weiter — vorheriger Fehler: ${log.status}`,
    )
  }
  const run = start(pipeline, input, {
    resume: resumeOutputs,
    sessions: resumeSessions,
    onNode: (id, patch) => {
      if (patch.status) console.error(`[${id}] ${patch.status}`)
    },
    onRun: (current: any) => {
      log = current
      void Bun.write(`/tmp/openflow-checkpoint-${current.id}.json`, JSON.stringify(current, null, 2)).catch(() => undefined)
      void flow(`runs/${encodeURIComponent(current.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current),
      }).catch((error) => console.error(`run log save failed: ${String(error)}`))
    },
    onNotice: (kind, text) => console.error(`[${kind}] ${text}`),
    onQuestion: () => Promise.resolve(undefined),
    onEngineStale: () => console.error("engine config is stale — restart opencode serve"),
  })
  log = await run.done
  predecessors.push(log.id)
  console.error(`run ${log.id}: ${log.status} (Versuch ${attempt}/${attemptsMax})`)
  if (log.status === "done" || attempt === attemptsMax) break
}

// Scorecard in den finalen Run-Log schreiben (der letzte onRun-PUT kam ohne
// sie) und als Block ausdrucken — die 10/10-Frage ist damit pro Run messbar.
const scorecard = buildScorecard(log, predecessors.length, predecessors.slice(0, -1), startedMs)
log.scorecard = scorecard
// Tiefen-Grenze für Heilungsketten: dieser Run ist aus <resumeRef> entstanden —
// of-loop startet keine Heilung für Nachkommen (sonst repetiert ein endgültig
// kaputter Task im 5-Minuten-Takt bis zum 24h-Fenster).
if (resumeRef !== undefined) log.resumeOf = resumeRef
void flow(`runs/${encodeURIComponent(log.id)}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(log),
}).catch((error) => console.error(`scorecard save failed: ${String(error)}`))
await Bun.write(`/tmp/openflow-checkpoint-${log.id}.json`, JSON.stringify(log, null, 2)).catch(() => undefined)
console.error(`checkpoint: /tmp/openflow-checkpoint-${log.id}.json`)
console.log(`=== SCORECARD ===\n${JSON.stringify(scorecard, null, 2)}`)
for (const node of log.nodes) {
  console.error(`[${node.id}] ${node.status}`)
  if (node.output !== undefined) console.log(`=== ${node.id} ===\n${node.output}`)
}
console.error(`run ${log.id}: ${log.status} — verdict ${scorecard.verdict} (${scorecard.attempts} Versuch(e), ${scorecard.outputWords} Wörter Output)`)
process.exit(log.status === "done" ? 0 : 1)
