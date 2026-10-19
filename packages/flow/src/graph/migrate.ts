/**
 * Loading documents saved by the OpenCode build into the Omp build.
 *
 * Both functions are pure and total: any JSON value goes in, a document and a
 * list of notes comes out, and nothing here throws. They never decide what the
 * user meant. A model the Omp catalog cannot be shown to contain stays exactly
 * as written and is reported, because guessing a replacement would silently run
 * a card on a different model than the one the file names.
 *
 * Idempotence: the first migration that has anything to report stamps the
 * document with `MIGRATED`. A stamped document is the user's acknowledged state,
 * so the notes that describe data we *kept* (model ids, session ids, unknown
 * fields) are not repeated; `legacyModelProblems` is what keeps reporting a
 * model that still cannot run. Nothing is walked recursively, so nesting depth
 * in the input cannot exhaust the stack.
 */

export type MigrationNote = {
  kind: "legacy-model" | "legacy-agent" | "legacy-session" | "unknown-field"
  nodeId?: string
  message: string
}

/** Present (as `1`) on a document that has already been through a migration that reported something. */
const MIGRATED = "migratedFromOpencode"

const PIPELINE_KEYS = [
  "id",
  "name",
  "nodes",
  "edges",
  "mode",
  "rounds",
  "depth",
  "dispatches",
  "gauntlet",
  "isolate",
  "verify",
  "defaultSwarm",
  MIGRATED,
]
const NODE_KEYS = ["id", "role", "agent", "position"]
// `mcp` was a per-card MCP allowlist: still recognised so an old file loads without an unknown-field note, then
// dropped by `migrateAgent`, which reports an explicit allowlist because dropping it widens what the card can reach.
const AGENT_KEYS = ["model", "prompt", "tools", "mcp", "attachments", "swarm", "uplift"]
const EDGE_KEYS = ["id", "source", "target"]

const RUN_KEYS = [
  "id",
  "pipeline",
  "pipelineID",
  "input",
  "attachments",
  "status",
  "started",
  "finished",
  "nodes",
  "usage",
  "verdict",
  "rounds",
  "best",
  "updatedAt",
  "resumedBy",
  MIGRATED,
]
const RUN_NODE_KEYS = [
  "id",
  "role",
  "toolFailures",
  "ranShell",
  "status",
  "sessionID",
  "permissions",
  "questions",
  "attachments",
  "model",
  "agent",
  "prompt",
  "output",
  "error",
  "started",
  "finished",
  "reused",
  "uplift",
  "memory",
  "swarm",
  "usage",
  "diff",
  "steps",
  "events",
]

/** OpenCode mints `ses_…`; the host mints `s_…`. The two never collide. */
export function isLegacySession(id: string): boolean {
  return id.startsWith("ses_")
}

export function migratePipeline(raw: unknown): { pipeline: unknown; notes: MigrationNote[] } {
  const notes: MigrationNote[] = []
  if (!isRecord(raw)) {
    notes.push({ kind: "unknown-field", message: "the pipeline is not a JSON object, so it was left untouched" })
    return { pipeline: raw, notes }
  }

  const stamped = raw[MIGRATED] === 1
  if (!stamped) noteExtras(raw, PIPELINE_KEYS, "the pipeline", undefined, notes)

  const next: Record<string, unknown> = { ...raw }
  if (Array.isArray(raw.nodes)) next.nodes = raw.nodes.map((node) => migrateNode(node, stamped, notes))
  if (Array.isArray(raw.edges) && !stamped) {
    for (const edge of raw.edges) {
      if (isRecord(edge)) noteExtras(edge, EDGE_KEYS, `edge ${label(edge)}`, undefined, notes)
    }
  }

  return { pipeline: stamp(next, stamped, notes), notes }
}

export function migrateRunLog(raw: unknown): { run: unknown; notes: MigrationNote[] } {
  const notes: MigrationNote[] = []
  if (!isRecord(raw)) {
    notes.push({ kind: "unknown-field", message: "the run log is not a JSON object, so it was left untouched" })
    return { run: raw, notes }
  }

  const stamped = raw[MIGRATED] === 1
  if (!stamped) noteExtras(raw, RUN_KEYS, "the run log", undefined, notes)

  if (!stamped && Array.isArray(raw.nodes)) {
    for (const node of raw.nodes) {
      if (!isRecord(node)) continue
      const nodeId = typeof node.id === "string" ? node.id : undefined
      noteExtras(node, RUN_NODE_KEYS, `card ${label(node)}`, nodeId, notes)
      if (typeof node.sessionID !== "string" || !isLegacySession(node.sessionID)) continue
      notes.push({
        kind: "legacy-session",
        nodeId,
        message: `session ${node.sessionID} is an OpenCode session: it can be read but cannot be resumed`,
      })
    }
  }

  return { run: stamp({ ...raw }, stamped, notes), notes }
}

/** One line per card whose model the Omp engine cannot be given as written. For preflight. */
export function legacyModelProblems(pipeline: unknown): string[] {
  if (!isRecord(pipeline) || !Array.isArray(pipeline.nodes)) return []
  const problems: string[] = []
  for (const node of pipeline.nodes) {
    if (!isRecord(node) || !isRecord(node.agent)) continue
    const problem = modelProblem(node.agent.model)
    if (problem) problems.push(`Card ${label(node)}: ${problem}`)
  }
  return problems
}

function migrateNode(node: unknown, stamped: boolean, notes: MigrationNote[]): unknown {
  if (!isRecord(node)) return node
  const nodeId = typeof node.id === "string" ? node.id : undefined
  if (!stamped) noteExtras(node, NODE_KEYS, `card ${label(node)}`, nodeId, notes)
  if (!isRecord(node.agent)) return node
  return { ...node, agent: migrateAgent(node.agent, nodeId, label(node), stamped, notes) }
}

function migrateAgent(
  agent: Record<string, unknown>,
  nodeId: string | undefined,
  card: string,
  stamped: boolean,
  notes: MigrationNote[],
): Record<string, unknown> {
  if (!stamped) {
    noteExtras(agent, AGENT_KEYS, `the agent of card ${card}`, nodeId, notes, "name")
    const problem = modelProblem(agent.model)
    if (problem) notes.push({ kind: "legacy-model", nodeId, message: problem })
  }

  // `mcp` was a per-card MCP allowlist; Omp has no per-session MCP selection, so
  // nothing consumes it and it is dropped, so it is not saved again. An absent
  // list said nothing and is dropped silently; an explicit one (even empty)
  // restricted the card, and its absence now grants every configured server.
  if (!("name" in agent) && !("mcp" in agent)) return agent
  const next = { ...agent }
  delete next.mcp
  if (Array.isArray(agent.mcp)) {
    const listed = agent.mcp.filter((entry): entry is string => typeof entry === "string")
    const limited = listed.length ? `to ${listed.map((entry) => `'${entry}'`).join(", ")}` : "to none"
    notes.push({
      kind: "legacy-agent",
      nodeId,
      message: `card ${card} limited its MCP servers ${limited}: Omp cannot limit MCP servers per card, so it now sees every configured server`,
    })
  }
  if (!("name" in agent)) return next
  delete next.name
  // An empty or null name meant "server default": nothing was chosen, so
  // nothing is lost by dropping it.
  if (agent.name === undefined || agent.name === null || agent.name === "") return next
  const named = typeof agent.name === "string" ? `agent '${agent.name}'` : "an agent"
  notes.push({
    kind: "legacy-agent",
    nodeId,
    message: `card ${card} named ${named}, which is an OpenCode agent: Omp has no agents by name, so the name was dropped and the card runs on its own prompt`,
  })
  return next
}

/** Why a model string cannot be handed to Omp as written, or `undefined` when it can (or is blank, which preflight owns). */
function modelProblem(model: unknown): string | undefined {
  if (model === undefined || model === null || model === "") return undefined
  if (typeof model !== "string") return `model is ${typeof model}, not a "provider/id" string: pick an Omp model`
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    return `model ${model} is not a "provider/id" pair: pick an Omp model`
  }
  if (model.slice(0, slash).toLowerCase() === "opencode") {
    return `model ${model} is an OpenCode zen model: pick an Omp model`
  }
  return undefined
}

/**
 * Names only, never values: an unknown field is as likely to hold a credential
 * as anything else, and a note ends up in the UI.
 */
function noteExtras(
  value: Record<string, unknown>,
  known: string[],
  where: string,
  nodeId: string | undefined,
  notes: MigrationNote[],
  alsoKnown?: string,
) {
  const extras = Object.keys(value).filter((key) => !known.includes(key) && key !== alsoKnown)
  if (!extras.length) return
  const shown = extras.slice(0, 5).join(", ") + (extras.length > 5 ? `, and ${extras.length - 5} more` : "")
  notes.push({ kind: "unknown-field", nodeId, message: `${where} has fields this version does not know (${shown}): kept as written` })
}

function stamp(document: Record<string, unknown>, stamped: boolean, notes: MigrationNote[]) {
  if (stamped || !notes.length) return document
  document[MIGRATED] = 1
  return document
}

function label(value: Record<string, unknown>) {
  if (typeof value.role === "string" && value.role) return `'${value.role}'`
  if (typeof value.id === "string") return `'${value.id}'`
  return "(unnamed)"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
