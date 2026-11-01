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
 * everything else goes to stderr. Every end — regular or by SIGTERM/SIGINT/
 * SIGHUP (a reap, Ctrl-C, a closed terminal) — writes the checkpoint and an
 * `ergebnis.md` beside it; the LAST stdout line is `ergebnis: <path>`
 * (W2.2, 23.10.2026: before, a signal ended the run with nothing to read).
 */

;(globalThis as unknown as { window: unknown }).window = {
  location: { origin: process.env.OPENFLOW_ORIGIN ?? "http://127.0.0.1:5174" },
}

import { herkunft } from "./of-heilung"
import { ENGINE_WARTEN_MS, hostNeustart, hostProbe, infraFortsetzen, istVerbindungsfehler, warteAufEngine } from "./of-erreichbar"
import { speicherKette } from "./of-speicher"
import { fabrikProjekt, nochmalVersuchen, projektPruefung, resumePfad, vorgaengerStoppen } from "./of-lauf"
import { abschliessen, checkpointPfad, buildScorecard, installiereSignalAbschluss, seedFrom, turnsFrom, uebernahme, uebernimm, vorgaenger } from "./of-ergebnis"
import { start } from "../src/server/engine"
import type { RecordedTurn } from "../src/server/turn-hash"
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

// Alle Run-Log-PUTs über EINE Kette (of-speicher.ts). Die Zieladresse ist absolut,
// damit der Signal-Handler sie auch vor dem fetch-Umbau unten nutzen kann.
const speicher = speicherKette(
  async (body) => {
    const id = encodeURIComponent(String((body as { id?: unknown })?.id ?? ""))
    const r = await fetch(`${origin}/flow/api/runs/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error(`flow store runs/${id} -> ${r.status}`)
  },
  (error) => console.error(`run log save failed: ${String(error)}`),
  // Engine-/vite-Neustart (of-erreichbar.ts): ein Verbindungsfehler wird bis
  // 2 min wiederholt, ein überholter Zwischenstand verworfen.
  { istVoruebergehend: istVerbindungsfehler, budgetMs: 120_000 },
)

// `connect()` fetches relative paths ("/flow/api/context") - legal in a page,
// invalid in bun. Rewrite relative URLs to the canvas origin before they leave.
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/")) input = origin + input
  return realFetch(input, init)
}) as typeof fetch

// Der Lauf-Stand, den der Signal-Handler sichert. Oben deklariert und vor dem
// ersten await installiert: ein Signal während des Ladens der Pipeline endet
// mit eigener Meldung und Exit-Code statt stillem Tod (W2.2).
const stand: { log: any; attempts: number; predecessors: string[]; startedMs: number; run?: { stop: () => Promise<void> } } = {
  log: undefined,
  attempts: 0,
  predecessors: [],
  startedMs: Date.now(),
}
installiereSignalAbschluss({
  stand: () => (stand.log ? { log: stand.log, attempts: Math.max(1, stand.attempts), predecessors: stand.predecessors, startedMs: stand.startedMs } : undefined),
  // Best effort, mit Zeitlimit im Handler: Sessions der Engine anhalten (sonst
  // arbeitet opencode an verwaisten Karten weiter) und den Store nachziehen.
  // Über dieselbe Kette wie onRun: ein älterer Zwischenstand darf den Abschluss nicht überholen.
  nachher: async (log) => {
    await Promise.allSettled([stand.run?.stop(), (speicher.schreibe(log), speicher.leeren(3_000))])
  },
})

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
const initialTurns: Record<string, RecordedTurn[]> = {}
let resumeCheckpoint: { id?: string; origin?: string } | undefined
let resumeLog: any
const continued = (outputs: Record<string, string>, held: Record<string, string>) =>
  Object.keys(held).filter((id) => outputs[id] === undefined).length
if (resumeRef !== undefined) {
  const path = resumePfad(resumeRef)
  // Ein trunkierter Checkpoint (Crash mitten im Bun.write) ist ein harter
  // Fehler mit klarer Meldung — kein uncaughtException-Labyrinth.
  let log: any
  try {
    log = JSON.parse(await Bun.file(path).text())
  } catch (error) {
    console.error(`checkpoint unlesbar (${path}): ${String(error)} — Checkpoint neu anlegen oder Run neu starten`)
    process.exit(2)
  }
  resumeCheckpoint = { id: log.id, origin: log.origin }
  resumeLog = log
  name = log.pipeline
  if (!input) input = log.input ?? ""
  seedFrom(log, initialResume, initialSessions)
  turnsFrom(log, initialTurns)
  console.error(
    // „angeboten", nicht „kept": ob eine Karte übernommen wird, entscheidet ihr
    // Eingabe-Hash im Lauf (K7). Was wirklich übernommen wurde, steht am Ende
    // (`übernommen: N von M`) und ist dieselbe Zahl wie SCORECARD `reused`.
    `resuming ${log.id} - ${Object.keys(initialResume).length} card(s) offered for reuse, ${continued(initialResume, initialSessions)} continued in session`,
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

// Infrastruktur-Ausfall (of-erreichbar.ts, FAIL-Serie 28.10.2026): Engine oder
// Canvas-Host weg heißt warten, nicht scheitern — vor dem Start und zwischen
// den Versuchen, aus EINEM Budget (OPENFLOW_ENGINE_WARTEN_S, Vorgabe 300 s).
let engineBudgetMs = Math.max(0, Number(process.env.OPENFLOW_ENGINE_WARTEN_S ?? ENGINE_WARTEN_MS / 1000) * 1000)
async function aufEngineWarten() {
  const w = await warteAufEngine({
    pruefe: hostProbe(origin, realFetch),
    neustart: hostNeustart(origin, realFetch),
    budgetMs: engineBudgetMs,
    log: (zeile) => console.error(zeile),
  })
  engineBudgetMs = Math.max(0, engineBudgetMs - w.gewartetMs)
  return w.ok
}
if (!(await aufEngineWarten())) {
  console.error(`headless-run: Canvas/Engine unter ${origin} nicht erreichbar — kein Lauf gestartet`)
  process.exit(2)
}

// W2.5: Pipelines kommen aus dem AKTIVEN Canvas-Projekt. Vor dem Laden
// gemessen, wohin der Canvas zeigt — eine fehlende Pipeline nennt das Projekt
// und den Ausweg, ein fremdes Projekt wird gewarnt (Runs dort sieht kein Reaper).
const kontext = await flow<{ project?: string }>("context").catch(() => undefined)
const pipelineAntwort = await fetch(`${origin}/flow/api/pipelines/${encodeURIComponent(name)}`)
const pruefung = projektPruefung({ aktiv: kontext?.project, erwartet: fabrikProjekt(), pipeline: name, pipelineDa: pipelineAntwort.ok })
if (pruefung.fehler) {
  console.error(`headless-run: ${pruefung.fehler} (HTTP ${pipelineAntwort.status})`)
  process.exit(2)
}
if (pruefung.warnung) console.error(`headless-run: WARNUNG ${pruefung.warnung}`)
const pipeline = (await pipelineAntwort.json()) as unknown
if (!isPipeline(pipeline)) throw new Error(`"${name}" did not load as a pipeline`)

const servers = await flow<Array<{ name: string }>>("mcp")
const names = servers.map((entry) => entry.name)
await flow(`pipelines/${encodeURIComponent(name)}/agents?merge=1`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // { agent: ... }-Wrapper ist Pflicht: writeAgents() liest body.agent — der
  // Canvas-Caller (src/server/store.ts saveAgents) wrappt genauso. Nackter
  // agentBlock()-Body erzeugte LEERE Merges (gemessen 01.11.2026: alle headless
  // gemergten Pipelines seit Okt hatten 66-Byte-Leerblöcke → "the server does
  // not know an agent named …").
  body: JSON.stringify({ agent: agentBlock(pipeline, names) }),
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
// Auto-Retry (v1.5.0): Ein Run, der mit error endet (und nur der — B4), wird über das eigene
// Checkpoint-Resume erneut gestartet — done-Karten behalten ihr Output (keine
// Kosten), die Karten, die den Run brachen, laufen in ihren Sessions nochmal.
// Beweisfall 20.09.2026: 2 saubere Worker-Reports, 1 Knoten-Error, Rest
// skipped, niemand startete neu. OPENFLOW_AUTO_RETRY=0 schaltet ab (Default 1).
const AUTO_RETRY = Math.max(0, Number(process.env.OPENFLOW_AUTO_RETRY ?? "1"))
const attemptsMax = 1 + AUTO_RETRY
// Fortsetzungen nach einem Infrastruktur-Ausfall zählen nicht als Versuch;
// ihr eigenes Kontingent (OPENFLOW_INFRA_RETRY, Vorgabe 3) und das gemeinsame
// Wartebudget begrenzen sie.
let infraRest = Math.max(0, Number(process.env.OPENFLOW_INFRA_RETRY ?? "3"))

// K11 (Abnahme R20): Der abgebrochene Vorgänger eines Resume stand bis zum
// nächsten Reaper-Durchgang (30 min) als RUNNING in der Scorecard. Beim ersten
// Checkpoint des Nachfolgers wird er geschlossen — `stopped`, mit Verweis auf
// den Nachfolger —, sofern sein Prozess nicht mehr lebt. Maßgeblich ist die
// Store-Fassung (die liest die Scorecard); ohne sie der Checkpoint.
let vorgaengerGeschlossen = resumeCheckpoint?.id === undefined
async function schliesseVorgaenger(nachfolgerId: string) {
  if (!resumeCheckpoint?.id) return
  const gespeichert = await flow<any>(`runs/${encodeURIComponent(resumeCheckpoint.id)}`).catch(() => undefined)
  const neu = vorgaengerStoppen(gespeichert ?? resumeLog, nachfolgerId)
  if (!neu) return
  await flow(`runs/${encodeURIComponent(resumeCheckpoint.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(neu),
  })
  console.error(`Vorgänger ${resumeCheckpoint.id}: running → stopped (fortgesetzt als ${nachfolgerId})`)
}

const aufrufer = {
  aufruf_id: process.env.OPENFLOW_AUFRUF_ID || resumeLog?.host?.aufruf_id || undefined,
  session: process.env.OPENFLOW_SESSION || resumeLog?.host?.session || undefined,
}
const startedMs = Date.now()
stand.startedMs = startedMs
const predecessors: string[] = []
stand.predecessors = predecessors
let log: any
// Alles, was aus früheren Läufen übernommen ist (Resume-Checkpoint, dann jeder
// Versuch dieses Prozesses). K11: ohne diesen Speicher verlor ein Versuch, der
// übernommene Karten als `skipped` endete, ihre Outputs — der nächste Versuch
// säte 0, die SCORECARD meldete reused 0 und 0 Wörter.
const carried: Record<string, string> = { ...initialResume }
const carriedSessions: Record<string, string> = { ...initialSessions }
let fortsetzung = false
for (let attempt = 1; attempt <= attemptsMax; attempt++) {
  const erster = attempt === 1 && !fortsetzung
  const resumeOutputs: Record<string, string> = erster ? { ...initialResume } : {}
  const resumeSessions: Record<string, string> = erster ? { ...initialSessions } : {}
  const resumeTurns: Record<string, RecordedTurn[]> = erster ? { ...initialTurns } : {}
  if (!erster && log) {
    seedFrom(log, resumeOutputs, resumeSessions)
    turnsFrom(log, resumeTurns)
    console.error(
      `${fortsetzung ? "infra-fortsetzung" : "auto-retry"} ${attempt}/${attemptsMax}: ${Object.keys(resumeOutputs).length} Karte(n) zur Übernahme angeboten, ${continued(resumeOutputs, resumeSessions)} in Session weiter — vorheriger Fehler: ${log.status}`,
    )
  }
  fortsetzung = false
  // Seeds are run OPTIONS, the fourth argument. They used to ride in the hooks
  // object, where the engine never looks: every headless resume and auto-retry
  // since v1.5.0 re-ran its "kept" cards (Abnahme 12.10.2026, `reused: 0`).
  // tsconfig includes this file so the compiler holds the line.
  const run = start(pipeline, input, {
    onNode: (id, patch) => {
      if (patch.status) console.error(`[${id}] ${patch.status}`)
    },
    onRun: (current: any) => {
      // Wer den Run hält: of-reap beendet einen lebenden, aber stummen Prozess.
      // Aufrufer (W2.4): of-run.sh erbt OPENFLOW_SESSION/OPENFLOW_AUFRUF_ID
      // vom fabrik-gate-Plugin; der Reaper ordnet einen Rückruf darüber dem
      // Ledger-Eintrag des Starts zu. Ein Resume ohne eigene Umgebung erbt
      // sie vom fortgesetzten Lauf — sonst bliebe jede Heilung stumm.
      current.host = {
        pid: process.pid,
        ...(aufrufer.aufruf_id ? { aufruf_id: aufrufer.aufruf_id } : {}),
        ...(aufrufer.session ? { session: aufrufer.session } : {}),
      }
      // Herkunft ab dem ERSTEN Checkpoint jedes Versuchs (Abnahme 12.10.2026:
      // stand sie nur im letzten Log, sah Versuch 1 eines Resume wie ein
      // Ursprung aus, und of-loop heilte Heilungsläufe im 5-Minuten-Takt).
      Object.assign(current, herkunft({ resumeRef, checkpoint: resumeCheckpoint, vorige: predecessors }))
      log = current
      stand.log = current
      if (!vorgaengerGeschlossen) {
        vorgaengerGeschlossen = true
        void schliesseVorgaenger(current.id).catch((error) => console.error(`Vorgänger nicht geschlossen: ${String(error)}`))
      }
      void Bun.write(checkpointPfad(current.id), JSON.stringify(current, null, 2)).catch(() => undefined)
      void speicher.schreibe(current)
    },
    onNotice: (kind, text) => console.error(`[${kind}] ${text}`),
    onQuestion: () => Promise.resolve(undefined),
    onEngineStale: () => console.error("engine config is stale — restart opencode serve"),
  }, { resume: resumeOutputs, sessions: resumeSessions, turns: resumeTurns })
  stand.run = run
  stand.attempts = attempt
  log = await run.done
  stand.log = log
  uebernimm(log, carried, carriedSessions)
  seedFrom(log, carried, carriedSessions)
  predecessors.push(log.id)
  console.error(`run ${log.id}: ${log.status} (Versuch ${attempt}/${attemptsMax})`)
  // Nur ein `error` wird wiederholt (B4): `stopped` hat jemand gewollt.
  if (infraFortsetzen(log, infraRest)) {
    infraRest--
    console.error(`run ${log.id}: Infrastruktur-Ausfall (Verbindung zur Engine) — warte auf die Engine, dann Fortsetzung der betroffenen Karten`)
    // Engine nach dem Budget noch weg: ein weiterer Versuch scheiterte genauso.
    if (!(await aufEngineWarten())) break
    // Derselbe Versuch noch einmal: der Ausfall war nicht der Fehler des Laufs.
    fortsetzung = true
    attempt--
    continue
  }
  if (!nochmalVersuchen(log.status, attempt, attemptsMax)) break
}

// Scorecard in den finalen Run-Log schreiben (der letzte onRun-PUT kam ohne
// sie) und als Block ausdrucken — die 10/10-Frage ist damit pro Run messbar.
const scorecard = buildScorecard(log, predecessors.length, vorgaenger(resumeCheckpoint?.id, predecessors), startedMs)
log.scorecard = scorecard
// Herkunft (resumeOf/retryOf/origin) steht seit onRun in jedem Versuch;
// hier nur nachgezogen, falls run.done ein Objekt ohne sie liefert.
Object.assign(log, herkunft({ resumeRef, checkpoint: resumeCheckpoint, vorige: predecessors.slice(0, -1) }))
void speicher.schreibe(log)
const angeboten = uebernahme(log, Object.keys(initialResume))
if (angeboten.zeile) console.error(angeboten.zeile)
// Ein Abschluss für jedes Ende (W2.2): Checkpoint + ergebnis.md, Bericht,
// `checkpoint:` nach allen Modelltexten (Befund (c)), `ergebnis:` zuletzt.
abschliessen(log, scorecard, { out: (s) => console.log(s), err: (s) => console.error(s) })
// Vor dem Exit die Store-Kette leeren (of-speicher.ts): Ein `void` PUT direkt vor
// process.exit ging verloren, der fertige Run blieb im Store `running` und wurde
// als Zombie abgeräumt (R3, run …wpfg9a).
// Frist über dem Wiederholungsbudget der Kette: ist der Host gerade im Neustart,
// wartet der Endstand auf ihn, statt einen `running`-Zombie zu hinterlassen.
if (!(await speicher.leeren(130_000))) console.error("run log save: Frist 130 s abgelaufen — Store-Stand evtl. veraltet")
process.exit(log.status === "done" ? 0 : 1)
