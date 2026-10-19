import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../../shared/omp"

/**
 * Synthetic inputs for the swarm tests: a fake agent-swarm checkout, a fake
 * python (a real executable, so the probe spawns a real child), omp frames
 * shaped like omp 18.12.2's wire types, and `swarm.live.v1` documents. Key
 * values used anywhere are dummies.
 */

export const DUMMY_KEYS = {
  SWARM_ED25519_KEY: "dummy-ed25519-seed-not-a-secret-0001",
  SWARM_SIGNING_KEY: "dummy-hmac-key-not-a-secret-0002",
} as const

export const ROSTER = ["a01-orchestrator", "a05-backend", "a08-qa"]

export function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-swarm-"))
}

export function settings(root = ""): OmpSettings {
  return { ...DEFAULT_OMP_SETTINGS, swarm: { mode: "auto", root } }
}

/** A checkout with just what preflight and the tracker look at. */
export function fakeRoot(parent: string, name = "agent-swarm"): string {
  const root = path.join(parent, name)
  fs.mkdirSync(path.join(root, "omp", "agents"), { recursive: true })
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true })
  fs.writeFileSync(path.join(root, "omp", "package.json"), JSON.stringify({ name: "agent-swarm-omp", omp: { extensions: ["./src/index.ts"] } }))
  fs.writeFileSync(path.join(root, "scripts", "orch_plan.py"), "# fixture\n")
  for (const slug of ROSTER) fs.writeFileSync(path.join(root, "omp", "agents", `${slug}.md`), "# fixture\n")
  return root
}

/** An executable stand-in for python3: `--version` and `-c "import cryptography"` exit as asked; `log` gets one line per run. */
export function fakePython(parent: string, behaviour: { runs: boolean; crypto: boolean; log?: string }): string {
  const file = path.join(parent, behaviour.runs ? "python3-fake" : "python3-broken")
  const note = behaviour.log ? `echo run >> '${behaviour.log}'\n` : ""
  const script = behaviour.runs
    ? `#!/bin/sh\n${note}if [ "$1" = "-c" ]; then exit ${behaviour.crypto ? 0 : 1}; fi\necho "Python 3.12.0"\nexit 0\n`
    : "#!/bin/sh\nexit 127\n"
  fs.writeFileSync(file, script, { mode: 0o755 })
  return file
}

/** A host env with PATH/HOME and nothing else, plus `extra`. */
export function hostEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: "/nonexistent-home", ...extra }
}

type Frame = { type: string; [key: string]: unknown }

export const frames = {
  taskStart(toolCallId: string, args: unknown): Frame {
    return { type: "tool_execution_start", toolCallId, toolName: "task", args }
  },
  taskEnd(toolCallId: string, result: unknown, isError = false): Frame {
    return { type: "tool_execution_end", toolCallId, toolName: "task", result, isError }
  },
  lifecycle(id: string, agent: string, status: "started" | "completed" | "failed" | "aborted", parentToolCallId?: string): Frame {
    return {
      type: "subagent_lifecycle",
      payload: { id, agent, agentSource: "bundled", status, index: 0, ...(parentToolCallId ? { parentToolCallId } : {}) },
    }
  },
  progress(id: string, agent: string, status: string, extra: Record<string, unknown> = {}, parentToolCallId?: string): Frame {
    return {
      type: "subagent_progress",
      payload: {
        index: 0,
        agent,
        agentSource: "bundled",
        task: "do the work",
        ...(parentToolCallId ? { parentToolCallId } : {}),
        progress: { index: 0, id, agent, status, recentTools: [], toolCount: 0, ...extra },
      },
    }
  },
  subagentEvent(id: string, event: Frame): Frame {
    return { type: "subagent_event", payload: { id, event } }
  },
  toolStart(toolCallId: string, toolName: string, args: unknown = {}): Frame {
    return { type: "tool_execution_start", toolCallId, toolName, args }
  },
}

/** An envelope-shaped task text, as `/swarm` would hand A01. */
export function assignmentText(correlation: string): string {
  return JSON.stringify({ schema: "swarm.v1.task.assign", type: "task.assign", correlation_id: correlation, payload: { task_id: correlation } })
}

type LiveRun = { agent: string; state: string; run_id?: string; activity?: string | null; last_tool?: string | null; error?: string | null }

/** A `swarm.live.v1` document with every field the schema requires. */
export function liveDocument(runs: LiveRun[], correlation: string | null = "corr-1"): Record<string, unknown> {
  const count = (...states: string[]) => runs.filter((run) => states.includes(run.state)).length
  return {
    schema: "swarm.live.v1",
    correlation_id: correlation,
    seq: 3,
    updated_wall: 1_700_000_000,
    producer: "derived",
    pid: 4242,
    producer_updated: 1_700_000_000,
    swarm: {
      state: "running",
      elapsed_s: 12,
      max_parallel: 4,
      effective_parallel: 4,
      running: count("starting", "running", "handing_off"),
      queued: count("queued"),
      waiting: count("waiting"),
      completed: count("completed"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      timed_out: count("timed_out"),
      stalled: 0,
      degraded: false,
    },
    runs: runs.map((run, index) => ({
      run_id: run.run_id ?? `T0000000${index}-${run.agent}.a1`,
      task_id: `T0000000${index}-${run.agent}`,
      agent: run.agent,
      state: run.state,
      attempt: 1,
      elapsed_s: 5,
      state_elapsed_s: 5,
      since_activity_s: 1,
      stalled: false,
      activity: run.activity ?? null,
      tool_calls: 2,
      last_tool: run.last_tool ?? null,
      parent: null,
      handover_in: null,
      handover_out: null,
      error: run.error ?? null,
    })),
  }
}

export function writeLive(stateDir: string, content: unknown): string {
  const dir = path.join(stateDir, "swarm")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "live.json")
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}
