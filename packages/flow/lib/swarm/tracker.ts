import fs from "node:fs"
import path from "node:path"
import { EMPTY_SWARM_COUNTS, type SwarmAgentState, type SwarmMode, type SwarmStatus, type SwarmTracker } from "../../shared/swarm"

/**
 * Turns one card's Omp frames (and, on `poll`, the task store's `live.json`)
 * into the card-visible `SwarmStatus`.
 *
 * Three sources describe the same agents and are folded together rather than
 * counted separately:
 *  - `task` tool calls whose agent is a swarm slug (the card's own, or those an
 *    A01 subagent makes, seen through `subagent_event`);
 *  - `subagent_lifecycle` / `subagent_progress`, which only flow once the
 *    session asked for `set_subagent_subscription` (progress or events). Field
 *    names are from omp 18.12.2 `modes/rpc/wire/frames.ts` and `AgentProgress`;
 *  - `<store>/live.json` (`swarm.live.v1`), written by agent-swarm itself.
 *
 * Memory is bounded: at most MAX_AGENTS rows, MAX_ACTIVITY characters per
 * activity line. Frames of an unknown type are ignored.
 */

const MAX_AGENTS = 64
const MAX_ACTIVITY = 200
const MAX_CORRELATION = 100
const MAX_LIVE_BYTES = 1_048_576
const MAX_TASK_SCAN = 65_536
const SLUG_SHAPE = /^a\d\d-[a-z-]+$/
const CORRELATION_SHAPE = /^[A-Za-z0-9._:-]+$/
const CORRELATION_FIELD = /"correlation_id"\s*:\s*"([^"]{1,100})"/

type State = SwarmAgentState["state"]

/** One row: where it was seen decides which identifiers it carries. */
type Row = {
  key: string
  agent: string
  state: State
  activity?: string
  at: number
  /** The `task` tool call that spawned it. */
  callId?: string
  /** omp's subagent id, once a lifecycle or progress frame named it. */
  subagentId?: string
  /** `live.json` run id, once matched. */
  liveId?: string
}

export type TrackerOptions = {
  mode: SwarmMode
  /** Per-session directory; the task store is `<stateDir>/swarm`. */
  stateDir: string
  /** Known swarm slugs (the checkout's omp/agents). Empty or absent falls back to the slug shape. */
  roster?: ReadonlySet<string>
  /** Why the swarm degraded to off, when preflight said so. */
  error?: string
  now?: () => number
}

const AGENT_STATUS: Record<string, State> = {
  pending: "queued",
  running: "running",
  started: "running",
  completed: "completed",
  failed: "failed",
  aborted: "cancelled",
}

const LIVE_STATE: Record<string, State> = {
  waiting: "queued",
  queued: "queued",
  starting: "running",
  running: "running",
  handing_off: "running",
  completed: "completed",
  failed: "failed",
  timed_out: "failed",
  cancelled: "cancelled",
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_AGENTS) : []
}

function clip(value: string | undefined): string | undefined {
  const line = value?.replace(/\s+/g, " ").trim().slice(0, MAX_ACTIVITY)
  return line || undefined
}

function terminal(state: State): boolean {
  return state === "completed" || state === "failed" || state === "cancelled"
}

function correlationOf(task: string | undefined): string | undefined {
  if (!task) return undefined
  const head = task.slice(0, MAX_TASK_SCAN)
  const found = CORRELATION_FIELD.exec(head)?.[1]
  return found && CORRELATION_SHAPE.test(found) && found.length <= MAX_CORRELATION ? found : undefined
}

/** The (agent, task) pairs of a `task` call, single or batched. */
function taskUnits(args: unknown): { agent: string | undefined; task: string | undefined }[] {
  const input = record(args)
  if (!input) return []
  if (!Array.isArray(input.tasks)) return [{ agent: text(input.agent), task: text(input.task) }]
  return list(input.tasks).map((item) => {
    const unit = record(item)
    return { agent: text(unit?.agent) ?? text(input.agent), task: text(unit?.task) }
  })
}

/** Resolves a settled `SingleResult`-shaped record to the state it ended in. */
function resultState(result: Record<string, unknown>): State {
  if (result.aborted === true) return "cancelled"
  return result.error || (typeof result.exitCode === "number" && result.exitCode !== 0) ? "failed" : "completed"
}

export function createTracker(options: TrackerOptions): SwarmTracker {
  const now = options.now ?? Date.now
  const rows = new Map<string, Row>()
  const live = path.join(path.resolve(options.stateDir), "swarm", "live.json")
  const enabled = options.mode !== "off"
  let active = false
  let correlationId: string | undefined
  let failure: string | undefined
  let updatedAt = now()
  let signature = fingerprint()
  let disposed = false

  const isSwarm = (agent: string | undefined): agent is string =>
    agent !== undefined && (options.roster?.size ? options.roster.has(agent) : SLUG_SHAPE.test(agent))

  function status(): SwarmStatus {
    const counts = { ...EMPTY_SWARM_COUNTS }
    const agents: SwarmAgentState[] = []
    for (const row of rows.values()) {
      counts[row.state] += 1
      agents.push({ agent: row.agent, state: row.state, ...(row.activity ? { activity: row.activity } : {}), at: row.at })
    }
    const error = options.error ?? failure
    return {
      mode: options.mode,
      active,
      ...(correlationId ? { correlationId } : {}),
      counts,
      agents,
      ...(error ? { error } : {}),
      updatedAt,
    }
  }

  function fingerprint(): string {
    return JSON.stringify([
      active,
      correlationId,
      failure,
      [...rows.values()].map((row) => [row.key, row.agent, row.state, row.activity]),
    ])
  }

  /** Returns the new status when anything visible changed since the last call. */
  function commit(): SwarmStatus | undefined {
    const next = fingerprint()
    if (next === signature) return undefined
    signature = next
    updatedAt = now()
    return status()
  }

  function make(key: string, agent: string): Row {
    if (rows.size >= MAX_AGENTS) {
      let evict: Row | undefined
      for (const row of rows.values()) if (terminal(row.state) && (!evict || row.at < evict.at)) evict = row
      rows.delete(evict?.key ?? rows.keys().next().value!)
    }
    const row: Row = { key, agent, state: "queued", at: now() }
    rows.set(key, row)
    active = true
    return row
  }

  function change(row: Row, state: State | undefined, activity: string | undefined): void {
    if (activity !== undefined) row.activity = clip(activity)
    if (state === undefined || state === row.state) return
    // A terminal state is final: late frames of a finished agent do not reopen it.
    if (terminal(row.state)) return
    row.state = state
    row.at = now()
    if (state === "failed") failure = `${row.agent} failed`
  }

  /** The row omp's subagent `id` refers to, adopting a not-yet-named `task` call row of that agent. */
  function subagent(id: string, agent: string, callId: string | undefined): Row {
    const known = [...rows.values()].find((row) => row.subagentId === id)
    if (known) return known
    const adopt = [...rows.values()].find(
      (row) => row.agent === agent && !row.subagentId && row.callId !== undefined && !terminal(row.state) && (!callId || row.callId === callId),
    )
    const row = adopt ?? make(`sub:${id}`, agent)
    row.subagentId = id
    return row
  }

  function settleCall(callId: string, result: unknown, isError: boolean): void {
    const details = record(record(result)?.details)
    // With `async.enabled` the call returns at once; the agents are still running.
    if (record(details?.async)?.state === "running") return
    const results = list(details?.results).flatMap((item) => {
      const entry = record(item)
      return entry ? [entry] : []
    })
    for (const row of rows.values()) {
      if (row.callId !== callId || terminal(row.state)) continue
      const match = results.find((item) => (row.subagentId && item.id === row.subagentId) || (!row.subagentId && item.agent === row.agent))
      change(row, match ? resultState(match) : isError ? "failed" : "completed", undefined)
    }
  }

  /** `tool_execution_*` of the card (no owner) or of subagent `owner` (seen through `subagent_event`). */
  function tool(event: Record<string, unknown>, owner: string | undefined): void {
    const name = text(event.toolName)
    const callId = text(event.toolCallId)
    if (event.type === "tool_execution_end") {
      if (name === "task" && callId) settleCall(callId, event.result, event.isError === true)
      return
    }
    if (event.type !== "tool_execution_start") return
    if (name === "task" && callId) {
      taskUnits(event.args).forEach((unit, index) => {
        if (!isSwarm(unit.agent)) return
        const key = `call:${callId}:${index}`
        const row = rows.get(key) ?? make(key, unit.agent)
        row.callId = callId
        change(row, "running", "delegated")
        correlationId = correlationOf(unit.task) ?? correlationId
      })
      return
    }
    const row = owner ? [...rows.values()].find((candidate) => candidate.subagentId === owner) : undefined
    if (row) change(row, undefined, name)
  }

  function agentFrame(payload: Record<string, unknown>): void {
    const progress = record(payload.progress)
    const agent = text(payload.agent) ?? text(progress?.agent)
    const id = text(progress?.id) ?? text(payload.id)
    if (isSwarm(agent) && id) {
      const row = subagent(id, agent, text(payload.parentToolCallId))
      const activity = text(progress?.currentTool) ?? text(progress?.lastIntent) ?? text(payload.description)
      change(row, AGENT_STATUS[text(progress?.status) ?? text(payload.status) ?? ""], activity)
    }
    // A01's in-flight `task` call lists its specialists one level down.
    const inflight = record(progress?.inflightTaskDetails)
    for (const item of list(inflight?.progress)) {
      const child = record(item)
      const childAgent = text(child?.agent)
      const childId = text(child?.id)
      if (!child || !isSwarm(childAgent) || !childId) continue
      change(subagent(childId, childAgent, undefined), AGENT_STATUS[text(child.status) ?? ""], text(child.currentTool) ?? text(child.lastIntent))
    }
    for (const item of list(inflight?.results)) {
      const child = record(item)
      const childAgent = text(child?.agent)
      const childId = text(child?.id)
      if (!child || !isSwarm(childAgent) || !childId) continue
      change(subagent(childId, childAgent, undefined), resultState(child), undefined)
    }
  }

  return {
    observe(frame) {
      if (!enabled || disposed) return undefined
      const payload = record(frame.payload)
      if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") tool(frame, undefined)
      else if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
        if (payload) agentFrame(payload)
      } else if (frame.type === "subagent_event") {
        const event = record(payload?.event)
        if (event) tool(event, text(payload?.id))
      } else return undefined
      return commit()
    },

    snapshot: status,

    async poll() {
      if (!enabled || disposed) return undefined
      let doc: Record<string, unknown> | undefined
      try {
        const handle = await fs.promises.open(live, "r")
        try {
          if ((await handle.stat()).size > MAX_LIVE_BYTES) return undefined
          doc = record(JSON.parse(await handle.readFile("utf8")))
        } finally {
          await handle.close()
        }
      } catch {
        return undefined // missing, partial or corrupt: keep what the frames told us
      }
      if (disposed || doc?.schema !== "swarm.live.v1") return undefined

      const corr = text(doc.correlation_id)
      if (corr && CORRELATION_SHAPE.test(corr)) correlationId = corr.slice(0, MAX_CORRELATION)
      for (const item of list(doc.runs)) {
        const run = record(item)
        const agent = text(run?.agent)
        const runId = text(run?.run_id)
        const state = LIVE_STATE[text(run?.state) ?? ""]
        if (!run || !isSwarm(agent) || !runId || !state) continue
        const key = `live:${runId}`
        const row =
          [...rows.values()].find((candidate) => candidate.liveId === runId) ??
          [...rows.values()].find(
            (candidate) => candidate.agent === agent && !candidate.liveId && !candidate.key.startsWith("live:") && (!terminal(candidate.state) || candidate.state === state),
          ) ??
          make(key, agent)
        row.liveId = runId
        change(row, state, text(run.activity) ?? text(run.last_tool))
        if (state === "failed" && text(run.error)) failure = clip(`${agent} failed: ${text(run.error)}`)
      }
      return commit()
    },

    /**
     * Ends the session's swarm: no agent stays queued or running, `active`
     * drops. Returns that final status once, and only when the swarm ever
     * showed anything; later calls, a disabled tracker and a swarm that never
     * delegated return undefined.
     */
    dispose() {
      if (disposed) return undefined
      disposed = true
      if (rows.size === 0) return undefined
      for (const row of rows.values()) {
        if (terminal(row.state)) continue
        row.state = "cancelled"
        row.at = now()
      }
      active = false
      updatedAt = now()
      const final = status()
      rows.clear()
      return final
    },
  }
}
