import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { SwarmMode, SwarmTracker } from "../../shared/swarm"
import { createTracker } from "./tracker"
import { assignmentText, frames, liveDocument, tmpdir, writeLive } from "./testing/fixtures"

let dir: string
const made: SwarmTracker[] = []

beforeEach(() => {
  dir = tmpdir()
})

afterEach(() => {
  for (const tracker of made.splice(0)) tracker.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

function track(options: { mode?: SwarmMode; roster?: ReadonlySet<string>; error?: string } = {}) {
  const tracker = createTracker({ mode: options.mode ?? "auto", stateDir: dir, roster: options.roster, error: options.error, now: () => 1_000 })
  made.push(tracker)
  return tracker
}

const states = (tracker: SwarmTracker) => tracker.snapshot().agents.map((agent) => [agent.agent, agent.state])

describe("tracker: frames", () => {
  test("starts empty and inactive", () => {
    expect(track().snapshot()).toEqual({
      mode: "auto",
      active: false,
      counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
      agents: [],
      updatedAt: 1_000,
    })
  })

  test("off ignores everything", async () => {
    const tracker = track({ mode: "off" })
    expect(tracker.observe(frames.taskStart("c1", { agent: "a01-orchestrator", task: "x" }))).toBeUndefined()
    writeLive(dir, liveDocument([{ agent: "a05-backend", state: "running" }]))
    expect(await tracker.poll?.()).toBeUndefined()
    expect(tracker.snapshot().active).toBe(false)
  })

  test("a task call to a swarm slug delegates: running, active, correlation id from the envelope", () => {
    const tracker = track()
    const status = tracker.observe(frames.taskStart("c1", { agent: "a01-orchestrator", task: assignmentText("corr-7") }))
    expect(status?.active).toBe(true)
    expect(status?.correlationId).toBe("corr-7")
    expect(status?.counts.running).toBe(1)
    expect(status?.agents).toEqual([{ agent: "a01-orchestrator", state: "running", activity: "delegated", at: 1_000 }])
  })

  test("a batched task call yields one row per swarm agent, and ignores the others", () => {
    const tracker = track()
    tracker.observe(
      frames.taskStart("c1", {
        tasks: [
          { agent: "a05-backend", task: "api" },
          { agent: "a08-qa", task: "tests" },
          { agent: "explore", task: "look" },
          { task: "no agent" },
        ],
      }),
    )
    expect(states(tracker)).toEqual([
      ["a05-backend", "running"],
      ["a08-qa", "running"],
    ])
  })

  test("noise changes nothing and returns nothing", () => {
    const tracker = track()
    expect(tracker.observe({ type: "message_update", message: {} })).toBeUndefined()
    expect(tracker.observe({ type: "totally_unknown", payload: 1 })).toBeUndefined()
    expect(tracker.observe(frames.toolStart("t1", "bash", { command: "ls" }))).toBeUndefined()
    expect(tracker.observe(frames.taskStart("c1", { agent: "explore", task: "x" }))).toBeUndefined()
    expect(tracker.observe(frames.taskStart("c2", "not an object"))).toBeUndefined()
    expect(tracker.observe({ type: "subagent_lifecycle", payload: "bad" })).toBeUndefined()
    expect(tracker.observe({ type: "subagent_event" })).toBeUndefined()
    expect(tracker.snapshot().active).toBe(false)
  })

  test("a repeated frame is not a change", () => {
    const tracker = track()
    expect(tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))).toBeDefined()
    expect(tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))).toBeUndefined()
  })

  test("delegate, progress, complete: lifecycle binds to the task call instead of adding a row", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    tracker.observe(frames.lifecycle("sub-1", "a05-backend", "started", "c1"))
    expect(states(tracker)).toEqual([["a05-backend", "running"]])

    const progress = tracker.observe(frames.progress("sub-1", "a05-backend", "running", { currentTool: "edit" }, "c1"))
    expect(progress?.agents[0]?.activity).toBe("edit")

    const done = tracker.observe(frames.lifecycle("sub-1", "a05-backend", "completed", "c1"))
    expect(done?.counts).toEqual({ queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 })

    // a straggler never reopens a finished agent
    tracker.observe(frames.progress("sub-1", "a05-backend", "running", { currentTool: "bash" }, "c1"))
    expect(states(tracker)).toEqual([["a05-backend", "completed"]])
  })

  test("pending progress is queued; the activity falls back to the last intent", () => {
    const tracker = track()
    const status = tracker.observe(frames.progress("sub-9", "a08-qa", "pending", { lastIntent: "Waiting for a slot" }))
    expect(status?.agents).toEqual([{ agent: "a08-qa", state: "queued", activity: "Waiting for a slot", at: 1_000 }])
    expect(status?.counts.queued).toBe(1)
  })

  test("failure: the lane is failed and the status carries an actionable error", () => {
    const tracker = track()
    tracker.observe(frames.lifecycle("sub-1", "a05-backend", "started"))
    const status = tracker.observe(frames.lifecycle("sub-1", "a05-backend", "failed"))
    expect(status?.counts.failed).toBe(1)
    expect(status?.error).toBe("a05-backend failed")
  })

  test("cancel: an aborted lifecycle is cancelled, not failed", () => {
    const tracker = track()
    tracker.observe(frames.lifecycle("sub-1", "a08-qa", "started"))
    const status = tracker.observe(frames.lifecycle("sub-1", "a08-qa", "aborted"))
    expect(status?.counts).toEqual({ queued: 0, running: 0, completed: 0, failed: 0, cancelled: 1 })
    expect(status?.error).toBeUndefined()
  })

  test("a lifecycle for a non-swarm agent is not a swarm agent", () => {
    const tracker = track()
    expect(tracker.observe(frames.lifecycle("sub-1", "explore", "started"))).toBeUndefined()
  })

  test("without a subscription the task call's end settles its agents", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    expect(tracker.observe(frames.taskEnd("c1", { details: { results: [] } }))?.counts.completed).toBe(1)

    tracker.observe(frames.taskStart("c2", { agent: "a08-qa", task: "x" }))
    expect(tracker.observe(frames.taskEnd("c2", {}, true))?.counts.failed).toBe(1)
  })

  test("task results decide each lane's outcome", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { tasks: [{ agent: "a05-backend", task: "a" }, { agent: "a08-qa", task: "b" }] }))
    tracker.observe(
      frames.taskEnd("c1", { details: { results: [{ agent: "a05-backend", exitCode: 0 }, { agent: "a08-qa", exitCode: 1 }] } }),
    )
    expect(states(tracker)).toEqual([
      ["a05-backend", "completed"],
      ["a08-qa", "failed"],
    ])
  })

  test("an aborted result is cancelled", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    tracker.observe(frames.taskEnd("c1", { details: { results: [{ agent: "a05-backend", exitCode: 1, aborted: true }] } }))
    expect(states(tracker)).toEqual([["a05-backend", "cancelled"]])
  })

  test("an async task call that returned at once does not settle its agents", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    expect(tracker.observe(frames.taskEnd("c1", { details: { async: { state: "running", jobId: "j1", type: "task" } } }))).toBeUndefined()
    expect(states(tracker)).toEqual([["a05-backend", "running"]])
  })

  test("events level: A01's own task calls and tool calls show as specialists and activity", () => {
    const tracker = track()
    tracker.observe(frames.lifecycle("sub-a01", "a01-orchestrator", "started"))
    tracker.observe(frames.subagentEvent("sub-a01", frames.taskStart("k1", { tasks: [{ agent: "a05-backend", task: "x" }, { agent: "a08-qa", task: "y" }] })))
    tracker.observe(frames.subagentEvent("sub-a01", frames.toolStart("k2", "swarm_status")))
    expect(tracker.snapshot().agents.map((agent) => [agent.agent, agent.state, agent.activity])).toEqual([
      ["a01-orchestrator", "running", "swarm_status"],
      ["a05-backend", "running", "delegated"],
      ["a08-qa", "running", "delegated"],
    ])

    tracker.observe(frames.subagentEvent("sub-a01", frames.taskEnd("k1", { details: { results: [] } })))
    expect(tracker.snapshot().counts).toEqual({ queued: 0, running: 1, completed: 2, failed: 0, cancelled: 0 })
  })

  test("A01's in-flight task details list its specialists one level down", () => {
    const tracker = track()
    const status = tracker.observe(
      frames.progress("sub-a01", "a01-orchestrator", "running", {
        currentTool: "task",
        inflightTaskDetails: {
          progress: [
            { id: "c-1", agent: "a05-backend", status: "running", currentTool: "write" },
            { id: "c-2", agent: "a08-qa", status: "pending" },
            { id: "c-3", agent: "explore", status: "running" },
          ],
          results: [{ id: "c-0", agent: "a03-architect", exitCode: 0 }],
        },
      }),
    )
    expect(status?.agents.map((agent) => [agent.agent, agent.state, agent.activity])).toEqual([
      ["a01-orchestrator", "running", "task"],
      ["a05-backend", "running", "write"],
      ["a08-qa", "queued", undefined],
      ["a03-architect", "completed", undefined],
    ])
  })

  test("a roster narrows what counts as a swarm agent", () => {
    const tracker = track({ roster: new Set(["a01-orchestrator"]) })
    expect(tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))).toBeUndefined()
    expect(tracker.observe(frames.taskStart("c2", { agent: "a01-orchestrator", task: "x" }))).toBeDefined()
  })

  test("a preflight degrade surfaces as the status error", () => {
    const tracker = track({ mode: "off", error: "Agent Swarm is off for this card: no signing" })
    expect(tracker.snapshot().error).toBe("Agent Swarm is off for this card: no signing")
  })

  test("memory is bounded: 64 agents, 200 characters of activity", () => {
    const tracker = track()
    for (let index = 0; index < 150; index++) tracker.observe(frames.taskStart(`c${index}`, { agent: "a05-backend", task: "x" }))
    expect(tracker.snapshot().agents).toHaveLength(64)

    tracker.observe(frames.progress("sub-long", "a08-qa", "running", { currentTool: `bash ${"x".repeat(5_000)}\n  and more` }))
    const long = tracker.snapshot().agents.find((agent) => agent.agent === "a08-qa")
    expect(long?.activity?.length).toBe(200)
    expect(long?.activity).not.toContain("\n")
  })

  test("a huge task text does not become a huge correlation id", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a01-orchestrator", task: `{"correlation_id":"${"z".repeat(500)}"}` }))
    expect(tracker.snapshot().correlationId).toBeUndefined()
  })

  test("dispose stops observing", () => {
    const tracker = track()
    tracker.dispose()
    expect(tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))).toBeUndefined()
  })

  test("dispose settles the swarm: open agents cancelled, finished ones kept, active false, counts recomputed", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a01-orchestrator", task: "x" }))
    tracker.observe(frames.lifecycle("w1", "a05-backend", "started"))
    tracker.observe(frames.lifecycle("w2", "a08-qa", "completed"))
    tracker.observe(frames.lifecycle("w3", "a03-architect", "failed"))
    tracker.observe(frames.taskStart("c2", { agent: "a06-frontend", task: "y" }))
    expect(tracker.snapshot().active).toBe(true)

    const final = tracker.dispose()
    expect(final?.active).toBe(false)
    expect(final?.agents.map((agent) => [agent.agent, agent.state])).toEqual([
      ["a01-orchestrator", "cancelled"],
      ["a05-backend", "cancelled"],
      ["a08-qa", "completed"],
      ["a03-architect", "failed"],
      ["a06-frontend", "cancelled"],
    ])
    expect(final?.counts).toEqual({ queued: 0, running: 0, completed: 1, failed: 1, cancelled: 3 })
    expect(final?.updatedAt).toBe(1_000)
  })

  test("the final status comes once; a swarm that never showed anything has none", () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    expect(tracker.dispose()).toBeDefined()
    expect(tracker.dispose()).toBeUndefined()
    expect(track().dispose()).toBeUndefined()
    expect(track({ mode: "off", error: "degraded" }).dispose()).toBeUndefined()
  })
})

describe("tracker: live.json", () => {
  test("a missing, empty, partial, corrupt or foreign file changes nothing", async () => {
    const tracker = track()
    expect(await tracker.poll?.()).toBeUndefined()

    writeLive(dir, "")
    expect(await tracker.poll?.()).toBeUndefined()
    writeLive(dir, '{"schema":"swarm.live.v1","runs":[{"agent":')
    expect(await tracker.poll?.()).toBeUndefined()
    writeLive(dir, "[1,2,3]")
    expect(await tracker.poll?.()).toBeUndefined()
    writeLive(dir, { schema: "something.else", runs: [{ agent: "a05-backend", state: "running", run_id: "r" }] })
    expect(await tracker.poll?.()).toBeUndefined()
    expect(tracker.snapshot().active).toBe(false)
  })

  test("runs merge into agents with their state, activity and the correlation id", async () => {
    const tracker = track()
    writeLive(
      dir,
      liveDocument(
        [
          { agent: "a05-backend", state: "running", activity: "writing handler", last_tool: "edit" },
          { agent: "a08-qa", state: "waiting" },
          { agent: "a09-reviewer", state: "timed_out", error: "deadline exceeded" },
          { agent: "a03-architect", state: "completed", last_tool: "read" },
          { agent: "a02-requirements", state: "cancelled" },
          { agent: "a04-ux-designer", state: "handing_off" },
          { agent: "explore", state: "running" },
          { agent: "a06-frontend", state: "mystery" },
        ],
        "corr-live",
      ),
    )
    const status = await tracker.poll?.()
    expect(status?.correlationId).toBe("corr-live")
    expect(status?.active).toBe(true)
    expect(status?.counts).toEqual({ queued: 1, running: 2, completed: 1, failed: 1, cancelled: 1 })
    expect(status?.agents.map((agent) => [agent.agent, agent.state, agent.activity])).toEqual([
      ["a05-backend", "running", "writing handler"],
      ["a08-qa", "queued", undefined],
      ["a09-reviewer", "failed", undefined],
      ["a03-architect", "completed", "read"],
      ["a02-requirements", "cancelled", undefined],
      ["a04-ux-designer", "running", undefined],
    ])
    expect(status?.error).toBe("a09-reviewer failed: deadline exceeded")
  })

  test("a polled run folds into the frame row of the same agent instead of duplicating it", async () => {
    const tracker = track()
    tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))
    writeLive(dir, liveDocument([{ agent: "a05-backend", state: "completed", run_id: "T1-a05-backend.a1" }]))
    const status = await tracker.poll?.()
    expect(status?.agents.map((agent) => [agent.agent, agent.state])).toEqual([["a05-backend", "completed"]])

    // the next poll of the same run id is stable
    expect(await tracker.poll?.()).toBeUndefined()
  })

  test("two runs of one slug stay two rows; a later poll updates them by run id", async () => {
    const tracker = track()
    writeLive(
      dir,
      liveDocument([
        { agent: "a05-backend", state: "running", run_id: "T1-a05-backend.a1" },
        { agent: "a05-backend", state: "queued", run_id: "T2-a05-backend.a1" },
      ]),
    )
    await tracker.poll?.()
    expect(tracker.snapshot().agents).toHaveLength(2)

    writeLive(
      dir,
      liveDocument([
        { agent: "a05-backend", state: "completed", run_id: "T1-a05-backend.a1" },
        { agent: "a05-backend", state: "running", run_id: "T2-a05-backend.a1" },
      ]),
    )
    const status = await tracker.poll?.()
    expect(status?.counts).toEqual({ queued: 0, running: 1, completed: 1, failed: 0, cancelled: 0 })
  })

  test("only the first 64 runs are read", async () => {
    const runs = Array.from({ length: 100 }, (_, index) => ({ agent: "a05-backend", state: "running", run_id: `T${index}-a05-backend.a1` }))
    const tracker = track()
    writeLive(dir, liveDocument(runs))
    await tracker.poll?.()
    expect(tracker.snapshot().agents.length).toBeLessThanOrEqual(64)
  })

  test("a file over the size cap is ignored", async () => {
    const tracker = track()
    writeLive(dir, `{"schema":"swarm.live.v1","pad":"${"x".repeat(1_100_000)}"}`)
    expect(await tracker.poll?.()).toBeUndefined()
  })

  test("polling never writes into the task store", async () => {
    const tracker = track()
    const file = writeLive(dir, liveDocument([{ agent: "a05-backend", state: "running" }]))
    const before = [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs, fs.readdirSync(path.dirname(file)), fs.readdirSync(dir)]
    await tracker.poll?.()
    await tracker.poll?.()
    expect([fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs, fs.readdirSync(path.dirname(file)), fs.readdirSync(dir)]).toEqual(before)
  })

  test("after dispose a poll does nothing", async () => {
    const tracker = track()
    writeLive(dir, liveDocument([{ agent: "a05-backend", state: "running" }]))
    tracker.dispose()
    expect(await tracker.poll?.()).toBeUndefined()
  })
})
