import { isCritic, orchestrationShape } from "./orchestration"
import { gauntletOf, modeOf, verifyOf } from "./types"
import type { Pipeline, RunLog } from "./types"

/**
 * Something a finished run's own record says about how far to trust it.
 *
 * The coach is deterministic code over `RunLog` and the pipeline: no model, no
 * network, nothing it did not read off the record. It audits the *run* — the
 * critic judges the work. Every finding states what was observed, never an
 * opinion of a model, and a detector with missing evidence says nothing.
 */
export type Finding = {
  /** The rule that fired, e.g. `unearned-pass`. */
  kind: string
  /** `kind` plus the cards involved, so dismissing one run's finding is stable. */
  id: string
  severity: "error" | "warn" | "info"
  /** Node ids the finding is about. */
  cards: string[]
  /** What was observed, in plain words. */
  evidence: string
  /** One concrete action the user can take. */
  fix: string
}

/** A run ending can show at most this many findings, most severe first. */
export const MAX_FINDINGS = 3

const RANK = { error: 0, warn: 1, info: 2 }

export function coach(log: RunLog, pipeline: Pipeline): Finding[] {
  // `sort` is stable, so findings of one severity keep detector order.
  return [...unearnedPass(log, pipeline), ...neverDispatched(log, pipeline), ...toolFailures(log)]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, MAX_FINDINGS)
}

/**
 * Whether a bar names something a critic can only check by running it: a
 * backticked command, or exit-code language. A prose-only bar does not count —
 * a critic reviewing prose has nothing to run, so not running anything is not
 * evidence against its verdict.
 */
export function commandShaped(bar: string) {
  return [
    /`[^`\n]+`/,
    /\bexit(s|ed)?\s+(with\s+)?(code\s+|status\s+)?0\b/i,
    /\bexit\s+(code|status)\b/i,
    /\bnon-?zero\b/i,
    /\b0\s+(failures|failed|errors)\b/i,
  ].some((pattern) => pattern.test(bar))
}

function finding(kind: string, severity: Finding["severity"], cards: string[], evidence: string, fix: string): Finding {
  return { kind, id: `${kind}:${cards.join(",")}`, severity, cards, evidence, fix }
}

/**
 * A pass against a bar that names a command, from a critic whose judging turn
 * ran no shell call that succeeded. `ranShell` absent is unknown, never false.
 */
function unearnedPass(log: RunLog, pipeline: Pipeline) {
  const bar = gauntletOf(pipeline)?.bar ?? verifyOf(pipeline)?.bar ?? ""
  if (log.verdict?.kind !== "pass" && !log.best) return []
  if (!commandShaped(bar)) return []
  const critics = new Set(pipeline.nodes.filter(isCritic).map((node) => node.id))
  const idle = log.nodes.filter((node) => critics.has(node.id) && node.ranShell === false)
  if (!idle.length) return []
  return [
    finding(
      "unearned-pass",
      "error",
      idle.map((node) => node.id),
      `The run recorded a pass against a bar that names a command, but ${idle
        .map((node) => `${node.role} card ${node.id}`)
        .join(", ")} made no shell call that succeeded on its judging turn.`,
      `Add "if you cannot run a check, the verdict is FAIL" to the bar, or add a second critic.`,
    ),
  ]
}

/**
 * An orchestrator whose every subagent is recorded `skipped`, in a run with no
 * dispatch rounds: it answered without handing out any work.
 */
function neverDispatched(log: RunLog, pipeline: Pipeline) {
  // A run the user stopped early settles its children `skipped` too, and the
  // fix below would be the wrong thing to say to somebody who pressed Stop.
  if (modeOf(pipeline) !== "orchestration" || log.rounds?.length || log.status === "stopped") return []
  const shape = orchestrationShape(pipeline)
  const status = new Map(log.nodes.map((node) => [node.id, node.status] as const))
  return shape.roots
    .filter((root) => {
      const children = shape.children(root.id)
      return children.length && children.every((child) => status.get(child) === "skipped")
    })
    .map((root) =>
      finding(
        "never-dispatched",
        "error",
        [root.id],
        `${root.role} card ${root.id} has ${shape.children(root.id).length} subagent card(s); every one is recorded skipped and the run recorded no dispatch rounds.`,
        "The orchestrator answered without dispatching: put a stronger model in that seat, or re-run.",
      ),
    )
}

/** A card whose tool calls were rejected settles `done` with its edits missing. */
function toolFailures(log: RunLog) {
  return log.nodes
    .filter((node) => (node.toolFailures ?? 0) > 0)
    .map((node) =>
      finding(
        "tool-failures",
        "warn",
        [node.id],
        `${node.role} card ${node.id} had ${node.toolFailures} tool call(s) rejected on its last turn.`,
        "That card could not write: check its tool permissions in the inspector, then re-run it.",
      ),
    )
}
