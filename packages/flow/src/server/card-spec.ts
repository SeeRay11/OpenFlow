import type { CardSpec } from "../../shared/engine"
import { SWARM_MODES, type SwarmMode } from "../../shared/swarm"
import { isCritic, orchestrationShape } from "../graph/orchestration"
import { gauntletOf, modeOf, type FlowNode, type Pipeline } from "../graph/types"

/**
 * Tool names an `agent.tools` map can switch off, in OpenFlow's own vocabulary.
 *
 * The host translates these onto Omp's tools when it launches the card, so this
 * list is the only guard against a typo becoming a toggle that does nothing.
 * `write`, `edit` and `patch` collapse onto the single `edit` toggle (see
 * `TOOL_ALIASES`): offering them separately lets a graph ask for contradictory
 * states. `question` is what lets a card stop and ask a person something; a card
 * with it off runs headless and guesses instead.
 */
export const TOOL_ACTIONS: Record<string, string> = {
  read: "read",
  grep: "grep",
  glob: "glob",
  edit: "edit",
  bash: "bash",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  skill: "skill",
  question: "question",
}

export const TOOLS = Object.keys(TOOL_ACTIONS)

/** Older graphs (and the role presets) name the edit capability three ways. */
const TOOL_ALIASES: Record<string, string> = {
  write: "edit",
  patch: "edit",
  "apply-patch": "edit",
}

/**
 * Folds a node's tool map onto the names the host acts on. Aliases merge, and a
 * deny anywhere in a merged group wins — losing a restriction on the way to the
 * launch would hand a card more access than the graph asked for.
 */
export function toolMap(tools: Record<string, boolean> | undefined) {
  const merged: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(tools ?? {})) {
    if (typeof value !== "boolean") continue
    const resolved = TOOL_ALIASES[name] ?? name
    if (!(resolved in TOOL_ACTIONS)) continue
    merged[resolved] = resolved in merged ? merged[resolved] && value : value
  }
  return merged
}

/**
 * The stable per-card key: pipeline, role and node id, sanitised.
 *
 * The node id is part of it because a role is not unique — two `coder` cards
 * would otherwise share one key, and whatever is keyed on it (a state directory,
 * a swarm task store) would be shared between them.
 */
export function agentKey(pipeline: Pipeline, node: FlowNode) {
  return `${pipeline.name}-${node.role}-${node.id}`.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()
}

/**
 * The swarm mode a card launches with, or `undefined` for the host's settings
 * default. A value this build does not know is ignored rather than passed on: a
 * hand-edited file must not be able to name a mode the host would reject.
 */
export function swarmOf(pipeline: Pipeline, node: FlowNode): SwarmMode | undefined {
  const own = node.agent.swarm
  if (own && SWARM_MODES.includes(own)) return own
  const fallback = pipeline.defaultSwarm
  return fallback && SWARM_MODES.includes(fallback) ? fallback : undefined
}

/**
 * Everything the host needs to launch one card, in OpenFlow's own vocabulary.
 *
 * In a gauntlet the critics and the root orchestrator judge and assign; none of
 * them may change the work. That is derived into the launch as an `edit` deny
 * rather than answered at a permission prompt, because under `auto` omp never
 * asks. `bash` stays as authored: a critic proves its verdict by running things.
 */
export function cardSpec(pipeline: Pipeline, node: FlowNode): CardSpec {
  const shape = orchestrationShape(pipeline)
  const judges = gauntletOf(pipeline) !== undefined && (isCritic(node) || shape.root?.id === node.id)
  const tools = judges ? { ...toolMap(node.agent.tools), edit: false } : toolMap(node.agent.tools)
  const orchestrates = modeOf(pipeline) === "orchestration" && shape.children(node.id).length > 0
  return {
    key: agentKey(pipeline, node),
    role: node.role,
    ...(node.agent.prompt.trim() ? { prompt: node.agent.prompt } : {}),
    // Absent means every tool: a card authored before toggles existed, or one
    // that names none, was never restricted and must not become so now.
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(orchestrates ? { dispatch: true } : {}),
  }
}
