import { describe, expect, test } from "bun:test"
import { pipeline } from "../graph/test-support"
import type { Attachment, NodeEvent, Pipeline, RunLog, StepUsage } from "../graph/types"
import type { BusEvent, PermissionReply, QuestionInfo } from "./client"
import {
  DEFAULT_NODE_TIMEOUT,
  start,
  type EngineDeps,
  type EngineHooks,
  type PermissionRequest,
  type QuestionRequest,
  type RunOptions,
} from "./engine"

/**
 * The engine is exercised against a fake server client. Everything the real one
 * does over HTTP — sessions, prompts, the idle wait, the event bus, permission
 * replies — is stubbed here, so these tests cover layering, context piping,
 * failure containment, stop and the permission policy without a running
 * `opencode serve`.
 */

type Behavior = {
  /** Text the node's session reports back. Defaults to "<id> output". */
  output?: string
  /**
   * One text per turn, for a card that says something different the second
   * time — an orchestrator that dispatches and then answers. The last entry
   * repeats once the list runs out, so a loop cannot run off the end.
   */
  outputs?: string[]
  /** Makes the node fail: the transcript comes back carrying this error. */
  error?: string
  /**
   * One error per turn, for a card that fails and then recovers — a provider
   * that refuses a turn for rate limiting and answers the re-send. An empty
   * string is a turn that succeeds; past the end of the list, nothing fails.
   */
  errors?: string[]
  /** Keeps the node running until the test calls `release(id)`. */
  hold?: boolean
  /**
   * Tool calls the node's session made, newest first — what an orchestrator
   * that used the MCP tools looks like from the message history.
   */
  calls?: { id?: string; name: string; input: unknown }[]
}

type HarnessOptions = {
  behavior?: Record<string, Behavior>
  /** "providerID/id" strings the server admits. Empty = no model check runs. */
  models?: string[]
  /**
   * What the second catalog read returns, when set — a restarted engine answers
   * `/api/health` before its catalog has filled, so the first read can be short.
   */
  modelsRefilled?: string[]
  /** Agent ids the server knows about. */
  agents?: string[]
  /** Subset of `models` that accepts image input. */
  vision?: string[]
  /** Price rows per "providerID/id", as the catalog would report them. */
  prices?: Record<string, Array<{ input: number; output: number; cache: { read: number; write: number } }>>
  /** What `sessionSteps` reports per node. Omitted = the engine keeps bus data. */
  steps?: Record<string, StepUsage[]>
  /**
   * What `sessionSteps` reports per *session*, for a card that holds more than
   * one across a run — a gauntlet's critic is given a new session every verdict.
   */
  stepsOf?: (sessionID: string, nodeID: string) => StepUsage[]
  onPermission?: (request: PermissionRequest) => Promise<PermissionReply>
  onQuestion?: (request: QuestionRequest) => Promise<string[][] | undefined>
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Lets queued promises and timers settle before the test looks at anything. */
function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 5))
}

function harness(options: HarnessOptions = {}) {
  const behavior = options.behavior ?? {}
  const nodeOf = new Map<string, string>() // sessionID -> nodeID
  const sessionOf = new Map<string, string>() // nodeID -> sessionID
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const dispatched: string[] = []
  /** How many transcripts each node has produced, for per-turn `outputs`. */
  const turns = new Map<string, number>()
  const prompts = new Map<string, string>()
  /** Every prompt in dispatch order — a card is prompted more than once in swarm mode. */
  const promptLog: { node: string; text: string }[] = []
  const interrupted: string[] = []
  const replies: { sessionID: string; requestID: string; reply: PermissionReply }[] = []
  const sent = new Map<string, Attachment[]>()
  const questionReplies: { sessionID: string; requestID: string; answers: string[][] }[] = []
  const questionRejects: { sessionID: string; requestID: string }[] = []
  const closed: string[] = []
  const waits: { node: string; timeout?: number }[] = []
  const notices: { kind: string; text: string }[] = []
  const saved: RunLog[] = []
  let deliver: (event: BusEvent) => void = () => {}
  let catalogReads = 0
  let created = 0
  let inflight = 0
  let peak = 0

  for (const [id, spec] of Object.entries(behavior)) if (spec.hold) gates.set(id, deferred())

  const api: EngineDeps["api"] = {
    async subscribe(onEvent, signal) {
      deliver = onEvent
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
    async createSession() {
      return { id: `s${++created}` }
    },
    async prompt(sessionID: string, text: string, files: Attachment[] = []) {
      const node = nodeOf.get(sessionID)!
      dispatched.push(node)
      prompts.set(node, text)
      promptLog.push({ node, text })
      sent.set(node, files)
      inflight++
      peak = Math.max(peak, inflight)
      return {}
    },
    accepts(model, mime) {
      if (!model) return false
      return !mime.startsWith("image/") || (model.capabilities?.input ?? []).includes("image")
    },
    async replyQuestion(sessionID: string, requestID: string, answers: string[][]) {
      questionReplies.push({ sessionID, requestID, answers })
      return {}
    },
    async rejectQuestion(sessionID: string, requestID: string) {
      questionRejects.push({ sessionID, requestID })
      return {}
    },
    async waitForIdle(sessionID: string, waitOptions: { signal?: AbortSignal; timeout?: number } = {}) {
      const node = nodeOf.get(sessionID)!
      waits.push({ node, timeout: waitOptions.timeout })
      const gate = gates.get(node)
      if (gate) {
        await Promise.race([
          gate.promise,
          new Promise<void>((resolve) => {
            const signal = waitOptions.signal
            if (!signal) return
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          }),
        ])
      }
      inflight--
    },
    async transcript(sessionID: string) {
      const node = nodeOf.get(sessionID)!
      const spec = behavior[node] ?? {}
      const turn = turns.get(node) ?? 0
      turns.set(node, turn + 1)
      const failure = spec.errors?.[turn] || spec.error
      if (failure) return { text: "", error: failure }
      if (spec.outputs?.length) return { text: spec.outputs[Math.min(turn, spec.outputs.length - 1)] }
      return { text: spec.output ?? `${node} output` }
    },
    async interrupt(sessionID: string) {
      interrupted.push(sessionID)
    },
    async replyPermission(sessionID: string, requestID: string, reply: PermissionReply) {
      replies.push({ sessionID, requestID, reply })
      return {}
    },
    async models() {
      const list = catalogReads++ && options.modelsRefilled ? options.modelsRefilled : (options.models ?? [])
      return list.map((value) => {
        const index = value.indexOf("/")
        return {
          providerID: value.slice(0, index),
          id: value.slice(index + 1),
          capabilities: { input: options.vision?.includes(value) ? ["text", "image"] : ["text"] },
          cost: options.prices?.[value] ?? [],
        }
      }) as any
    },
    async agents() {
      return (options.agents ?? []).map((id) => ({ id })) as any
    },
    async sessionCalls(sessionID: string) {
      const rows = behavior[nodeOf.get(sessionID)!]?.calls ?? []
      // Ids default to position, which is enough for the engine's
      // already-consumed check as long as they are stable per node.
      return rows.map((row, index) => ({ id: row.id ?? `call-${index}`, name: row.name, input: row.input }))
    },
    describe(error: unknown) {
      return error instanceof Error ? error.message : String(error)
    },
    ...(options.steps || options.stepsOf
      ? {
          async sessionSteps(sessionID: string) {
            const node = nodeOf.get(sessionID)!
            if (options.stepsOf) return options.stepsOf(sessionID, node)
            return options.steps![node] ?? []
          },
        }
      : {}),
  }

  const activity: { node: string; event: NodeEvent }[] = []

  const hooks: EngineHooks = {
    onNodeEvent(id, event) {
      activity.push({ node: id, event })
    },
    onNode(id, patch) {
      if (patch.sessionID) {
        nodeOf.set(patch.sessionID, id)
        sessionOf.set(id, patch.sessionID)
      }
    },
    onNotice(kind, text) {
      notices.push({ kind, text })
    },
    onPermission: options.onPermission,
    onQuestion: options.onQuestion,
    onQuestionClosed: (requestID) => closed.push(requestID),
  }

  const deps: EngineDeps = {
    api,
    async saveRun(log) {
      saved.push(structuredClone(log))
      return {}
    },
  }

  return {
    deps,
    hooks,
    dispatched,
    prompts,
    promptLog,
    interrupted,
    replies,
    waits,
    notices,
    saved,
    activity,
    sessionOf,
    peak: () => peak,
    /** How many sessions this run opened — 0 proves a carried one was continued. */
    created: () => created,
    release(id: string) {
      gates.get(id)?.resolve()
    },
    /** Pushes an event onto the bus the engine subscribed to. */
    emit(event: BusEvent) {
      deliver(event)
    },
    /** Replays what a provider step looks like on the bus: started, then ended. */
    spend(
      nodeID: string,
      input: { messageID: string; model: string; tokens: Partial<StepUsage["tokens"]>; skipStart?: boolean },
    ) {
      const sessionID = sessionOf.get(nodeID)
      const [providerID, ...rest] = input.model.split("/")
      if (!input.skipStart)
        deliver({
          type: "session.next.step.started",
          data: {
            sessionID,
            assistantMessageID: input.messageID,
            model: { providerID, id: rest.join("/") },
          },
        })
      deliver({
        type: "session.next.step.ended",
        data: {
          sessionID,
          assistantMessageID: input.messageID,
          finish: "stop",
          tokens: {
            input: input.tokens.input ?? 0,
            output: input.tokens.output ?? 0,
            reasoning: input.tokens.reasoning ?? 0,
            cache: { read: input.tokens.cacheRead ?? 0, write: input.tokens.cacheWrite ?? 0 },
          },
        },
      })
    },
    ask(nodeID: string, request: { id: string; action: string; resources?: string[] }) {
      deliver({ type: "permission.v2.asked", data: { sessionID: sessionOf.get(nodeID), ...request } })
    },
    question(nodeID: string, request: { id: string; questions: QuestionInfo[] }) {
      deliver({ type: "question.v2.asked", data: { sessionID: sessionOf.get(nodeID), ...request } })
    },
    sent,
    questionReplies,
    questionRejects,
    closed,
    run(graph: Pipeline, input = "do the thing", runOptions: RunOptions = {}) {
      return start(graph, input, hooks, runOptions, deps)
    },
  }
}

function statuses(log: RunLog) {
  return Object.fromEntries(log.nodes.map((node) => [node.id, node.status]))
}

describe("validation", () => {
  test("refuses a cyclic graph before anything is dispatched", () => {
    const h = harness()
    expect(() => h.run(pipeline("a->b", "b->a"))).toThrow()
    expect(h.dispatched).toEqual([])
  })

  test("refuses a mode this build has no scheduler for", () => {
    // Preflight says the same thing in the UI, but the engine is callable
    // without it, and dispatching a swarm through the pipeline scheduler would
    // spend real money producing an answer nobody designed.
    const h = harness()
    expect(() => h.run({ ...pipeline("a", "b"), mode: "swarm" })).toThrow("swarm")
    expect(h.dispatched).toEqual([])
  })

  test("fails every node when a model is not one the server offers", async () => {
    const graph = pipeline("a->b")
    graph.nodes[0].agent.model = "opencode/ghost-model"
    const h = harness({ models: ["opencode/real-model"] })

    // This model is missing on purpose, so skip the re-read that exists for a
    // catalog still filling after a restart — there is nothing to wait for.
    const log = await h.run(graph, "do the thing", { catalogRetry: 0 }).done

    expect(h.dispatched).toEqual([])
    expect(log.status).toBe("error")
    expect(log.nodes[0].error).toContain("unknown model")
  })

  test("re-reads a catalog that was still filling instead of calling the model unknown", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "opencode/real-model"
    // A restarted engine answers /api/health before its catalog is complete, so
    // the first read is short and the model looks like it does not exist.
    const h = harness({ models: [], modelsRefilled: ["opencode/real-model"] })

    const log = await h.run(graph, "do the thing", { catalogRetry: 1 }).done

    expect(log.nodes[0].error).toBeUndefined()
    expect(log.status).toBe("done")
    expect(h.dispatched).toEqual(["a"])
  })

  test("accepts a model the server does offer", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "opencode/real-model"
    const h = harness({ models: ["opencode/real-model"] })

    const log = await h.run(graph).done

    expect(log.status).toBe("done")
  })

  test("names the server restart when a node points at an agent the server has not loaded", async () => {
    // The server reads opencode.json once. Running anyway gives the session an
    // empty permission ruleset, which fails every tool and reads like a broken
    // model — so this has to be caught before dispatch.
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "test-a"
    const h = harness({ agents: ["build"] })

    const log = await h.run(graph).done

    expect(h.dispatched).toEqual([])
    expect(log.status).toBe("error")
    expect(log.nodes[0].error).toContain("restart")
    expect(h.notices.some((notice) => notice.text.includes("restart"))).toBe(true)
  })
})

describe("layering", () => {
  test("runs a chain in topological order", async () => {
    const h = harness()
    const log = await h.run(pipeline("a->b", "b->c")).done

    expect(h.dispatched).toEqual(["a", "b", "c"])
    expect(log.status).toBe("done")
    expect(h.peak()).toBe(1)
  })

  test("dispatches independent nodes concurrently", async () => {
    const h = harness({ behavior: { b: { hold: true }, c: { hold: true } } })
    const run = h.run(pipeline("a->b", "a->c", "b->d", "c->d"))

    await flush()
    expect(h.dispatched).toEqual(["a", "b", "c"])
    expect(h.peak()).toBe(2)

    h.release("b")
    h.release("c")
    const log = await run.done
    expect(h.dispatched).toEqual(["a", "b", "c", "d"])
    expect(log.status).toBe("done")
  })

  test("never runs more than maxParallel nodes at once", async () => {
    // Every concurrent node is another live session against the provider.
    const graph = pipeline("a->w", "a->x", "a->y", "a->z")
    const h = harness({ behavior: { w: { hold: true }, x: { hold: true }, y: { hold: true }, z: { hold: true } } })
    const run = h.run(graph, "do the thing", { maxParallel: 2 })

    await flush()
    expect(h.dispatched).toEqual(["a", "w", "x"])
    expect(h.peak()).toBe(2)

    h.release("w")
    await flush()
    expect(h.dispatched).toEqual(["a", "w", "x", "y"])

    h.release("x")
    h.release("y")
    h.release("z")
    const log = await run.done
    expect(h.peak()).toBe(2)
    expect(log.status).toBe("done")
  })

  test("defaults to four at a time", async () => {
    const spec = ["v", "w", "x", "y", "z"]
    const h = harness({ behavior: Object.fromEntries(spec.map((id) => [id, { hold: true }])) })
    const run = h.run(pipeline(...spec.map((id) => `a->${id}`)))

    await flush()
    expect(h.peak()).toBe(4)

    for (const id of spec) h.release(id)
    await run.done
    expect(h.peak()).toBe(4)
  })

  test("dispatches nothing further once a stop lands mid-layer", async () => {
    const spec = ["w", "x", "y", "z"]
    const h = harness({ behavior: Object.fromEntries(spec.map((id) => [id, { hold: true }])) })
    const run = h.run(pipeline(...spec.map((id) => `a->${id}`)), "do the thing", { maxParallel: 2 })

    await flush()
    expect(h.dispatched).toEqual(["a", "w", "x"])

    await run.stop()
    const log = await run.done

    expect(h.dispatched).toEqual(["a", "w", "x"])
    expect(statuses(log)).toMatchObject({ a: "done", w: "stopped", x: "stopped", y: "stopped", z: "stopped" })
  })

  test("waits for the whole layer before starting the next", async () => {
    const h = harness({ behavior: { b: { hold: true } } })
    const run = h.run(pipeline("a->c", "b->c", "a", "b"))

    await flush()
    expect([...h.dispatched].sort()).toEqual(["a", "b"])
    expect(h.dispatched).not.toContain("c")

    h.release("b")
    await run.done
    expect(h.dispatched).toContain("c")
  })
})

describe("node timeout", () => {
  test("gives every node the run's timeout", async () => {
    const h = harness()
    await h.run(pipeline("a->b"), "do the thing", { nodeTimeout: 90_000 }).done

    expect(h.waits).toEqual([
      { node: "a", timeout: 90_000 },
      { node: "b", timeout: 90_000 },
    ])
  })

  test("defaults to thirty minutes", async () => {
    const h = harness()
    await h.run(pipeline("a")).done

    expect(h.waits[0].timeout).toBe(DEFAULT_NODE_TIMEOUT)
    expect(DEFAULT_NODE_TIMEOUT).toBe(30 * 60_000)
  })

  test("refuses a timeout too short to be meant", async () => {
    const h = harness()
    await h.run(pipeline("a"), "do the thing", { nodeTimeout: 0 }).done

    expect(h.waits[0].timeout).toBe(1_000)
  })

  test("surfaces the timeout as a node error", async () => {
    // The client throws when the wait expires; the node has to carry that,
    // not sit in "running" forever.
    const h = harness()
    h.deps.api.waitForIdle = async () => {
      throw new Error("timed out waiting for the session to finish")
    }

    const log = await h.run(pipeline("a->b")).done

    expect(statuses(log)).toEqual({ a: "error", b: "skipped" })
    expect(log.nodes[0].error).toContain("timed out")
  })
})

describe("context piping", () => {
  test("gives a node every ancestor's output in execution order", async () => {
    const h = harness()
    await h.run(pipeline("a->b", "b->c")).done

    const prompt = h.prompts.get("c")!
    expect(prompt).toContain("a output")
    expect(prompt).toContain("b output")
    expect(prompt.indexOf("a output")).toBeLessThan(prompt.indexOf("b output"))
  })

  test("direct mode gives only the nodes wired straight in", async () => {
    const h = harness()
    await h.run(pipeline("a->b", "b->c"), "do the thing", { pipe: "direct" }).done

    const prompt = h.prompts.get("c")!
    expect(prompt).toContain("b output")
    expect(prompt).not.toContain("a output")
  })

  test("carries the run task into every node", async () => {
    const h = harness()
    await h.run(pipeline("a->b"), "ship the parser").done

    expect(h.prompts.get("a")).toContain("ship the parser")
    expect(h.prompts.get("b")).toContain("ship the parser")
  })

  test("records the prompt it sent on the run log", async () => {
    const h = harness()
    const log = await h.run(pipeline("a")).done

    expect(log.nodes[0].prompt).toBe(h.prompts.get("a"))
    expect(log.nodes[0].output).toBe("a output")
    expect(log.nodes[0].sessionID).toBe(h.sessionOf.get("a"))
  })
})

describe("failure containment", () => {
  test("stops the downstream branch and lets siblings finish", async () => {
    const graph = pipeline("a->b", "a->c", "b->d", "c->e")
    const h = harness({ behavior: { b: { error: "model exploded" } } })

    const log = await h.run(graph).done

    expect(statuses(log)).toEqual({ a: "done", b: "error", c: "done", d: "skipped", e: "done" })
    expect(log.nodes.find((node) => node.id === "b")!.error).toBe("model exploded")
    expect(log.nodes.find((node) => node.id === "d")!.error).toBe("upstream failed")
    expect(h.dispatched).not.toContain("d")
    expect(log.status).toBe("error")
  })

  test("a skip travels the whole branch", async () => {
    const h = harness({ behavior: { a: { error: "boom" } } })
    const log = await h.run(pipeline("a->b", "b->c")).done

    expect(statuses(log)).toEqual({ a: "error", b: "skipped", c: "skipped" })
  })
})

describe("stop", () => {
  test("interrupts what is running and dispatches nothing further", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a->b"))
    await flush()

    await run.stop()
    const log = await run.done

    expect(h.interrupted).toEqual([h.sessionOf.get("a")!])
    expect(h.dispatched).toEqual(["a"])
    expect(statuses(log)).toEqual({ a: "stopped", b: "stopped" })
    expect(log.status).toBe("stopped")
  })

  test("still writes the run log", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()
    await run.stop()
    await run.done

    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].status).toBe("stopped")
  })
})

describe("activity", () => {
  test("streams a node's tool calls to the UI and saves them on the run log", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()
    const sessionID = h.sessionOf.get("a")!

    h.emit({ type: "session.next.tool.input.started", data: { sessionID, callID: "c1", name: "grep" } })
    h.emit({
      type: "session.next.tool.called",
      data: { sessionID, callID: "c1", tool: "grep", input: { pattern: "handler" } },
    })
    h.emit({
      type: "session.next.tool.success",
      data: { sessionID, callID: "c1", content: [{ type: "text", text: "2 matches" }] },
    })
    await flush()

    expect(h.activity.map((entry) => entry.node)).toEqual(["a", "a", "a"])
    expect(h.activity.at(-1)!.event).toMatchObject({ id: "tool:c1", status: "done", body: "2 matches" })

    h.release("a")
    const log = await run.done
    // One row, not three: the call is upserted as it progresses.
    expect(log.nodes[0].events).toHaveLength(1)
    expect(log.nodes[0].events![0]).toMatchObject({ id: "tool:c1", title: "grep pattern=handler" })
  })

  test("a subagent's work is attributed to the node that spawned it", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()
    const sessionID = h.sessionOf.get("a")!

    h.emit({ type: "session.next.tool.input.started", data: { sessionID, callID: "t1", name: "task" } })
    h.emit({ type: "session.created", data: { sessionID: "child", info: { parentID: sessionID } } })
    h.emit({ type: "session.next.text.delta", data: { sessionID: "child", textID: "x1", delta: "looking" } })
    await flush()

    expect(h.activity.at(-1)!.node).toBe("a")
    expect(h.activity.at(-1)!.event).toMatchObject({ depth: 1, parentCallID: "t1", body: "looking" })

    h.release("a")
    await run.done
  })

  test("records the permission decision on the stream as well as the log", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()

    h.ask("a", { id: "req-1", action: "read", resources: [".env"] })
    await flush()

    const note = h.activity.find((entry) => entry.event.id === "note:permission:req-1")
    expect(note?.event).toMatchObject({ kind: "note", title: "permission read: once", body: ".env" })

    h.release("a")
    await run.done
  })
})

describe("permissions", () => {
  test("auto policy approves the single call and records the decision", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()

    h.ask("a", { id: "req-1", action: "read", resources: [".env"] })
    await flush()

    // "once", never "always": always writes into the project's saved
    // permissions and outlives the run.
    expect(h.replies).toEqual([{ sessionID: h.sessionOf.get("a")!, requestID: "req-1", reply: "once" }])

    h.release("a")
    const log = await run.done
    expect(log.nodes[0].permissions).toHaveLength(1)
    expect(log.nodes[0].permissions![0]).toMatchObject({
      requestID: "req-1",
      action: "read",
      resources: [".env"],
      reply: "once",
      policy: "auto",
    })
  })

  test("answers a repeated request only once", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()

    h.ask("a", { id: "req-1", action: "read" })
    h.ask("a", { id: "req-1", action: "read" })
    await flush()

    expect(h.replies).toHaveLength(1)
    h.release("a")
    await run.done
  })

  test("ignores requests for sessions it does not own", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()

    h.emit({ type: "permission.v2.asked", data: { sessionID: "someone-else", id: "req-1", action: "read" } })
    await flush()

    expect(h.replies).toEqual([])
    h.release("a")
    await run.done
  })

  test("manual policy hands the request to the UI and sends its answer", async () => {
    const asked: PermissionRequest[] = []
    const h = harness({
      behavior: { a: { hold: true } },
      onPermission: async (request) => {
        asked.push(request)
        return "always"
      },
    })
    const run = h.run(pipeline("a"), "do the thing", { permissions: "manual" })
    await flush()

    h.ask("a", { id: "req-1", action: "bash", resources: ["rm -rf /"] })
    await flush()

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ nodeID: "a", role: "a", action: "bash", resources: ["rm -rf /"] })
    expect(h.replies[0].reply).toBe("always")

    h.release("a")
    const log = await run.done
    expect(log.nodes[0].permissions![0]).toMatchObject({ reply: "always", policy: "manual" })
  })

  test("manual policy rejects when there is nobody to ask", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"), "do the thing", { permissions: "manual" })
    await flush()

    h.ask("a", { id: "req-1", action: "bash" })
    await flush()

    expect(h.replies[0].reply).toBe("reject")
    h.release("a")
    await run.done
  })

  test("rejects anything still pending once the run is stopped", async () => {
    // Leaving a request unanswered would strand the node until the idle wait
    // gives up half an hour later.
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()
    await run.stop()

    h.ask("a", { id: "req-1", action: "edit" })
    await flush()

    expect(h.replies[0].reply).toBe("reject")
    await run.done
  })
})

describe("run log", () => {
  test("is saved once, with timings and the run status", async () => {
    // A run this short finishes well inside the checkpoint interval, so the
    // pending checkpoint is cancelled and the final write is the only one.
    const h = harness()
    const log = await h.run(pipeline("a->b"), "ship it").done

    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].id).toBe(log.id)
    expect(h.saved[0].status).toBe("done")
    expect(h.saved[0].input).toBe("ship it")
    expect(h.saved[0].pipelineID).toBe("test-pipeline")
    expect(log.finished).toBeGreaterThanOrEqual(log.started)
    for (const node of log.nodes) expect(node.finished).toBeGreaterThanOrEqual(node.started!)
  })

  test("reports a store failure instead of throwing", async () => {
    const h = harness()
    h.deps.saveRun = async () => {
      throw new Error("disk full")
    }

    const log = await h.run(pipeline("a")).done

    expect(log.status).toBe("done")
    expect(h.notices.some((notice) => notice.text.includes("disk full"))).toBe(true)
  })

  test("checkpoints what has finished while the run is still going", async () => {
    // The failure this covers: a long run, the tab closed at minute 25, and
    // nothing on disk because the only write happened after the last node.
    const h = harness({ behavior: { b: { hold: true } } })
    const run = h.run(pipeline("a->b"), "ship it", { checkpointEvery: 1 })
    await flush()
    await flush()

    expect(h.saved.length).toBeGreaterThan(0)
    const partial = h.saved.at(-1)!
    expect(partial.id).toBe(run.log.id)
    expect(partial.status).toBe("running")
    expect(partial.input).toBe("ship it")
    expect(partial.nodes.find((node) => node.id === "a")!.status).toBe("done")
    expect(partial.nodes.find((node) => node.id === "a")!.output).toBe("a output")
    expect(partial.nodes.find((node) => node.id === "b")!.status).toBe("running")

    h.release("b")
    await run.done
  })

  test("carries the activity tail into a checkpoint", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"), "do the thing", { checkpointEvery: 1 })
    await flush()
    const sessionID = h.sessionOf.get("a")!

    h.emit({ type: "session.next.tool.input.started", data: { sessionID, callID: "c1", name: "grep" } })
    h.emit({ type: "session.next.tool.called", data: { sessionID, callID: "c1", tool: "grep" } })
    await flush()
    await flush()

    expect(h.saved.at(-1)!.nodes[0].events?.some((event) => event.title.includes("grep"))).toBe(true)

    h.release("a")
    await run.done
  })

  test("the final write wins over a pending checkpoint", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"), "do the thing", { checkpointEvery: 1 })
    await flush()
    await flush()

    h.release("a")
    const log = await run.done

    const last = h.saved.at(-1)!
    expect(last.status).toBe("done")
    expect(last.finished).toBe(log.finished)
    expect(last.nodes[0].output).toBe("a output")
  })

  test("never has two log writes in flight at once", async () => {
    // Checkpoints and the final write share one file; overlapping them would
    // let a stale snapshot land last.
    const h = harness({ behavior: { b: { hold: true } } })
    let writing = 0
    let overlapped = false
    h.deps.saveRun = async () => {
      writing += 1
      overlapped = overlapped || writing > 1
      await new Promise((resolve) => setTimeout(resolve, 3))
      writing -= 1
      return {}
    }

    const run = h.run(pipeline("a->b"), "ship it", { checkpointEvery: 1 })
    await flush()
    await flush()
    h.release("b")
    await run.done

    expect(overlapped).toBe(false)
  })
})

describe("questions", () => {
  const ask = { question: "Which database?", header: "db", options: [{ label: "postgres", description: "" }] }

  test("hands the question to the UI and replies with what was chosen", async () => {
    const h = harness({
      behavior: { a: { hold: true } },
      onQuestion: async () => [["postgres"]],
    })
    const run = h.run(pipeline("a"))
    await flush()

    h.question("a", { id: "que-1", questions: [ask] })
    await flush()

    expect(h.questionReplies).toEqual([
      { sessionID: h.sessionOf.get("a")!, requestID: "que-1", answers: [["postgres"]] },
    ])
    expect(h.questionRejects).toEqual([])

    h.release("a")
    const log = await run.done
    expect(log.nodes[0].questions![0]).toMatchObject({ requestID: "que-1", headers: ["db"], answers: [["postgres"]] })
  })

  test("rejects rather than inventing an answer when nobody is listening", async () => {
    const h = harness({ behavior: { a: { hold: true } } })
    const run = h.run(pipeline("a"))
    await flush()

    h.question("a", { id: "que-1", questions: [ask] })
    await flush()

    expect(h.questionRejects).toEqual([{ sessionID: h.sessionOf.get("a")!, requestID: "que-1" }])
    expect(h.questionReplies).toEqual([])

    h.release("a")
    const log = await run.done
    expect(log.nodes[0].questions![0]).toMatchObject({ rejected: true })
  })

  test("gives up on an unanswered question so the run cannot hang on it", async () => {
    const h = harness({
      behavior: { a: { hold: true } },
      // Never resolves: a person who walked away.
      onQuestion: () => new Promise<string[][]>(() => {}),
    })
    const run = h.run(pipeline("a"), "do the thing", { questionTimeout: 100 })
    await flush()

    h.question("a", { id: "que-1", questions: [ask] })
    await new Promise((resolve) => setTimeout(resolve, 160))

    expect(h.questionRejects).toEqual([{ sessionID: h.sessionOf.get("a")!, requestID: "que-1" }])
    // The dialog must come down too, or it keeps offering buttons that answer
    // a request the server has already been told to drop.
    expect(h.closed).toEqual(["que-1"])

    h.release("a")
    await run.done
  })

  test("answers a repeated question only once", async () => {
    const h = harness({ behavior: { a: { hold: true } }, onQuestion: async () => [["postgres"]] })
    const run = h.run(pipeline("a"))
    await flush()

    h.question("a", { id: "que-1", questions: [ask] })
    h.question("a", { id: "que-1", questions: [ask] })
    await flush()

    expect(h.questionReplies).toHaveLength(1)
    h.release("a")
    await run.done
  })
})

describe("attachments", () => {
  const png = { id: "f1", name: "shot.png", mime: "image/png", url: "data:image/png;base64,AA", size: 2 }
  const note = { id: "f2", name: "notes.md", mime: "text/markdown", url: "data:text/markdown;base64,AA", size: 2 }

  test("sends run files to a model that reads them", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "opencode/sees"
    const h = harness({ models: ["opencode/sees"], vision: ["opencode/sees"] })

    const log = await h.run(graph, "look", { attachments: [png] }).done

    expect(h.sent.get("a")).toEqual([png])
    expect(log.nodes[0].attachments).toEqual({ sent: ["shot.png"], skipped: [] })
    expect(log.attachments).toEqual(["shot.png"])
  })

  test("withholds an image from a blind model and names it in the prompt instead", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "opencode/blind"
    const h = harness({ models: ["opencode/blind"] })

    const log = await h.run(graph, "look", { attachments: [png, note] }).done

    // The text file still rides along — only the modality it lacks is dropped.
    expect(h.sent.get("a")).toEqual([note])
    expect(log.nodes[0].attachments).toEqual({ sent: ["notes.md"], skipped: ["shot.png"] })
    expect(h.prompts.get("a")).toContain("shot.png")
    expect(log.nodes[0].status).toBe("done")
  })

  test("one blind node does not stop the nodes behind it", async () => {
    const graph = pipeline("a->b")
    graph.nodes[0].agent.model = "opencode/blind"
    graph.nodes[1].agent.model = "opencode/sees"
    const h = harness({ models: ["opencode/blind", "opencode/sees"], vision: ["opencode/sees"] })

    const log = await h.run(graph, "look", { attachments: [png] }).done

    expect(h.sent.get("a")).toEqual([])
    expect(h.sent.get("b")).toEqual([png])
    expect(statuses(log)).toEqual({ a: "done", b: "done" })
  })

  test("a card's own files are sent on top of the run's", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "opencode/sees"
    graph.nodes[0].agent.attachments = [note]
    const h = harness({ models: ["opencode/sees"], vision: ["opencode/sees"] })

    await h.run(graph, "look", { attachments: [png] }).done

    expect(h.sent.get("a")).toEqual([png, note])
  })
})

describe("usage", () => {
  const priced = { "openai/gpt-x": [{ input: 2, output: 10, cache: { read: 0.5, write: 4 } }] }

  test("prices what the provider reported, per node and per run", async () => {
    const graph = pipeline("a->b")
    for (const node of graph.nodes) node.agent.model = "openai/gpt-x"
    const h = harness({ models: ["openai/gpt-x"], prices: priced, behavior: { a: { hold: true } } })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000, output: 200 } })
    h.release("a")
    await flush()
    h.spend("b", { messageID: "m2", model: "openai/gpt-x", tokens: { input: 500, cacheRead: 10_000 } })
    const log = await run.done

    // a: 1000*2 + 200*10 = 4000 -> $0.004    b: 500*2 + 10000*0.5 = 6000 -> $0.006
    expect(log.nodes[0].usage?.cost).toBeCloseTo(0.004, 12)
    expect(log.nodes[1].usage?.cost).toBeCloseTo(0.006, 12)
    expect(log.usage?.cost).toBeCloseTo(0.01, 12)
    expect(log.usage?.steps).toBe(2)
    expect(log.usage?.unpriced).toEqual([])
  })

  test("a step reported twice on the bus is charged once", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/gpt-x"
    const h = harness({ models: ["openai/gpt-x"], prices: priced, behavior: { a: { hold: true } } })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000 } })
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000 } })
    h.release("a")
    const log = await run.done

    expect(log.usage?.steps).toBe(1)
    expect(log.usage?.cost).toBeCloseTo(0.002, 12)
  })

  test("the server's own record replaces what the bus saw", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/gpt-x"
    const h = harness({
      models: ["openai/gpt-x"],
      prices: priced,
      behavior: { a: { hold: true } },
      // The bus missed a step; the message history has both.
      steps: {
        a: [
          { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
          { messageID: "m2", model: "openai/gpt-x", tokens: { input: 3_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000 } })
    h.release("a")
    const log = await run.done

    expect(log.usage?.steps).toBe(2)
    expect(log.usage?.cost).toBeCloseTo(0.008, 12)
    expect(log.nodes[0].steps).toHaveLength(2)
  })

  test("a model with no published price is reported unpriced, never as free", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "mystery/x"
    const h = harness({ models: ["mystery/x"], behavior: { a: { hold: true } } })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "mystery/x", tokens: { input: 9_000, output: 100 } })
    h.release("a")
    const log = await run.done

    expect(log.usage?.unpriced).toEqual(["mystery/x"])
    expect(log.usage?.models[0].cost).toBeUndefined()
    expect(log.usage?.tokens.input).toBe(9_000)
  })

  test("tokens spent by a failed node are still counted", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/gpt-x"
    const h = harness({ models: ["openai/gpt-x"], prices: priced, behavior: { a: { hold: true, error: "boom" } } })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000 } })
    h.release("a")
    const log = await run.done

    expect(log.nodes[0].status).toBe("error")
    expect(log.usage?.cost).toBeCloseTo(0.002, 12)
  })

  test("a step the bus never announced is attributed to the node's own model", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/gpt-x"
    const h = harness({ models: ["openai/gpt-x"], prices: priced, behavior: { a: { hold: true } } })

    const run = h.run(graph)
    await flush()
    h.spend("a", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000 }, skipStart: true })
    h.release("a")
    const log = await run.done

    expect(log.usage?.models[0].model).toBe("openai/gpt-x")
    expect(log.usage?.cost).toBeCloseTo(0.002, 12)
  })
})

describe("stale engine", () => {
  test("names the exact command for this host, and flags the run", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "untitled-mcp-server-adder"
    const h = harness({ agents: ["some-other-agent"] })
    let stale = 0
    h.hooks.onEngineStale = () => {
      stale += 1
    }
    h.deps.serveStatus = async () => ({
      managed: false,
      running: true,
      url: "http://127.0.0.1:4096",
      command: "bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096",
      reason: "it was started outside OpenFlow",
    })

    const log = await h.run(graph).done

    expect(log.status).toBe("error")
    expect(stale).toBe(1)
    // The command, and where to run it — not a bare binary name that may not
    // be on PATH or may be a different version than this checkout.
    expect(log.nodes[0].error).toContain("bun run --cwd packages/opencode")
    expect(log.nodes[0].error).toContain("Ctrl+C")
  })

  test("points at the button when this host owns the engine", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "missing-agent"
    const h = harness({ agents: [] })
    h.deps.serveStatus = async () => ({
      managed: true,
      running: true,
      url: "http://127.0.0.1:4096",
      command: "bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096",
    })

    const log = await h.run(graph).done

    expect(log.nodes[0].error).toContain("restart button")
  })

  test("still says something useful when the host cannot report the engine", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "missing-agent"
    const h = harness({ agents: [] })

    const log = await h.run(graph).done

    expect(log.nodes[0].error).toContain("opencode serve")
  })
})

describe("resume", () => {
  test("a seeded node is satisfied without a session", async () => {
    const h = harness()

    const log = await h.run(pipeline("a->b"), "do the thing", { resume: { a: "a from last time" } }).done

    expect(h.dispatched).toEqual(["b"])
    expect(log.status).toBe("done")
    expect(statuses(log)).toEqual({ a: "done", b: "done" })
    expect(log.nodes[0].output).toBe("a from last time")
    // No session was created for it, and no prompt was built.
    expect(log.nodes[0].sessionID).toBeUndefined()
    expect(log.nodes[0].prompt).toBeUndefined()
  })

  test("marks a reused node as reused on the run log", async () => {
    const h = harness()

    const log = await h.run(pipeline("a"), "do the thing", { resume: { a: "a from last time" } }).done

    expect(log.nodes[0].events?.map((event) => event.title)).toContain("reused from a previous run")
    expect(h.activity.map((row) => `${row.node}:${row.event.title}`)).toContain("a:reused from a previous run")
  })

  test("downstream reads a seeded output exactly as a fresh one", async () => {
    const h = harness()

    await h.run(pipeline("a->b", "b->c"), "do the thing", { resume: { a: "a from last time" } }).done

    expect(h.prompts.get("b")).toContain("a from last time")
    // `ancestors` walks the same outputs map, so c sees it too, in order.
    const prompt = h.prompts.get("c")!
    expect(prompt).toContain("a from last time")
    expect(prompt.indexOf("a from last time")).toBeLessThan(prompt.indexOf("b output"))
  })

  test("direct piping sees a seeded output too", async () => {
    const h = harness()

    await h
      .run(pipeline("a->b", "b->c"), "do the thing", { pipe: "direct", resume: { a: "a from last time" } })
      .done

    expect(h.prompts.get("b")).toContain("a from last time")
    expect(h.prompts.get("c")).not.toContain("a from last time")
  })

  test("re-runs only the tail a previous run failed on", async () => {
    const h = harness()

    const log = await h.run(pipeline("a->b", "b->c", "c->d", "d->e"), "do the thing", {
      resume: { a: "a from last time", b: "b from last time", c: "c from last time" },
    }).done

    expect(h.dispatched).toEqual(["d", "e"])
    expect(log.status).toBe("done")
    expect(h.prompts.get("d")).toContain("c from last time")
  })

  test("a carried session is continued rather than opened again", async () => {
    // The engine runs in the page, so a reload ends a run while its sessions are
    // still live on the server. Continuing means prompting back into the one the
    // card was working in — an orchestrator seven rounds into a gauntlet has read
    // every verdict, and a fresh session throws exactly that away.
    const h = harness()

    const log = await h.run(pipeline("a"), "do the thing", { sessions: { a: "s-from-before" } }).done

    expect(log.nodes[0].sessionID).toBe("s-from-before")
    expect(h.created()).toBe(0)
    expect(h.prompts.get("a")).toContain("The run was interrupted, and is being continued")
    expect(log.status).toBe("done")
  })

  test("a card is told it was interrupted once, not on every later turn", async () => {
    const fence = (body: string) => ["```openflow", body, "```"].join(String.fromCharCode(10))
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: {
          outputs: [
            fence(JSON.stringify({ dispatch: [{ card: "a", task: "do a" }] })),
            fence(JSON.stringify({ final: "done here" })),
          ],
        },
        a: { output: "built it" },
      },
    })
    const graph = { ...pipeline("root->a"), mode: "orchestration" as const }
    for (const node of graph.nodes) node.agent.model = "openai/gpt-x"

    await h.run(graph, "do the thing", { sessions: { root: "s-root" } }).done

    const rootPrompts = h.promptLog.filter((entry) => entry.node === "root")
    expect(rootPrompts.length).toBeGreaterThan(1)
    expect(rootPrompts[0].text).toContain("The run was interrupted")
    // The second turn is an ordinary reused session; saying it again would read
    // as a second interruption that never happened.
    expect(rootPrompts.slice(1).every((entry) => !entry.text.includes("The run was interrupted"))).toBe(true)
  })

  test("a finished card keeps its output instead of reopening its session", async () => {
    const h = harness()

    // Both offered, and they disagree on purpose: `resume` wins, because a card
    // that already answered has nothing to continue and reopening it only bills.
    const log = await h.run(pipeline("a->b"), "do the thing", {
      resume: { a: "a from last time" },
      sessions: { a: "s-finished", b: "s-working" },
    }).done

    expect(h.dispatched).toEqual(["b"])
    expect(log.nodes[0].sessionID).toBeUndefined()
    expect(log.nodes[0].output).toBe("a from last time")
    expect(log.nodes[1].sessionID).toBe("s-working")
  })

  test("a node left out of the seed runs again even though it has an output", async () => {
    const h = harness()

    await h.run(pipeline("a->b"), "do the thing", { resume: { b: "b from last time" } }).done

    // Seeding is per node and the caller decides: b was reused, a was not.
    expect(h.dispatched).toEqual(["a"])
  })

  test("a reused node costs nothing this run", async () => {
    const graph = pipeline("a->b")
    for (const node of graph.nodes) node.agent.model = "openai/gpt-x"
    const h = harness({
      models: ["openai/gpt-x"],
      prices: { "openai/gpt-x": [{ input: 2, output: 10, cache: { read: 0.5, write: 4 } }] },
      behavior: { b: { hold: true } },
    })

    const run = h.run(graph, "do the thing", { resume: { a: "a from last time" } })
    await flush()
    h.spend("b", { messageID: "m1", model: "openai/gpt-x", tokens: { input: 1_000, output: 200 } })
    h.release("b")
    const log = await run.done

    expect(log.nodes[0].usage).toBeUndefined()
    expect(log.nodes[0].steps).toBeUndefined()
    expect(log.usage?.steps).toBe(1)
    expect(log.usage?.cost).toBeCloseTo(0.004, 12)
  })

  test("a reused node's model no longer being offered does not fail the run", async () => {
    const graph = pipeline("a->b")
    graph.nodes[0].agent.model = "opencode/retired-model"
    graph.nodes[1].agent.model = "opencode/real-model"
    const h = harness({ models: ["opencode/real-model"] })

    const log = await h.run(graph, "do the thing", { catalogRetry: 0, resume: { a: "a from last time" } }).done

    expect(log.status).toBe("done")
    expect(h.dispatched).toEqual(["b"])
  })
})

describe("reused nodes are legible in the run log", () => {
  test("a carried-over node is flagged, not merely missing a sessionID", async () => {
    const h = harness()
    const log = await h.run(pipeline("a->b"), "do the thing", { resume: { a: "an answer from last time" } }).done

    const carried = log.nodes.find((node) => node.id === "a")!
    expect(carried.reused).toBe(true)
    expect(carried.output).toBe("an answer from last time")
    // The node this run actually executed must not be mistaken for a reused one.
    expect(log.nodes.find((node) => node.id === "b")!.reused).toBeUndefined()
  })
})

describe("swarm mode", () => {
  /** A swarm of `agents` peers plus the synthesizer card that decides. */
  function swarm(agents: string[], rounds?: number): Pipeline {
    const graph = pipeline(...agents, "verdict")
    graph.nodes[graph.nodes.length - 1].role = "synthesizer"
    return { ...graph, mode: "swarm", ...(rounds === undefined ? {} : { rounds }) }
  }

  test("every peer runs every round, then the synthesizer runs once", async () => {
    const h = harness()
    await h.run(swarm(["a", "b", "c"], 2)).done

    expect(h.dispatched).toEqual(["a", "b", "c", "a", "b", "c", "verdict"])
  })

  test("a peer keeps one session across rounds, so it remembers its own reasoning", async () => {
    const h = harness()
    await h.run(swarm(["a", "b"], 3)).done

    // Four cards' worth of turns (2 peers x 3 rounds + 1 verdict) over three
    // sessions: reuse is the difference between remembering round 1 and not.
    expect(h.promptLog).toHaveLength(7)
    expect(new Set(h.sessionOf.values()).size).toBe(3)
  })

  test("round 1 carries the briefing and the task; round 2 carries the peers", async () => {
    const h = harness({ behavior: { a: { output: "A says so" }, b: { output: "B disagrees" } } })
    await h.run(swarm(["a", "b"], 2), "settle this").done

    const first = h.promptLog.find((turn) => turn.node === "a")!.text
    expect(first).toContain("You are one agent in an OpenFlow swarm")
    expect(first).toContain("settle this")
    // Round 1 is answered alone — quoting a peer there would be a lie about
    // what the agent had in front of it.
    expect(first).not.toContain("B disagrees")

    const second = h.promptLog.filter((turn) => turn.node === "a")[1].text
    expect(second).toContain("Round 2 of 2")
    expect(second).toContain("B disagrees")
    expect(second).not.toContain("A says so")
  })

  test("a round reads the round before it, not whatever a peer has already overwritten", async () => {
    const h = harness({ behavior: { a: { output: "A" }, b: { output: "B" }, c: { output: "C" } } })
    await h.run(swarm(["a", "b", "c"], 3)).done

    // Every peer in round 3 sees both other peers. If the snapshot were taken
    // per-card instead of on the boundary, a card late in the pool would be
    // reading answers from the round it is itself in.
    for (const node of ["a", "b", "c"]) {
      const third = h.promptLog.filter((turn) => turn.node === node)[2].text
      expect(third).toContain("Round 3 of 3")
      for (const peer of ["a", "b", "c"].filter((id) => id !== node)) expect(third).toContain(`(${peer})`)
    }
  })

  test("the synthesizer is handed every peer's final position and nothing of its own", async () => {
    const h = harness({ behavior: { a: { output: "A final" }, b: { output: "B final" } } })
    await h.run(swarm(["a", "b"], 2), "settle this").done

    const verdict = h.prompts.get("verdict")!
    expect(verdict).toContain("You are the synthesizer of an OpenFlow swarm")
    expect(verdict).toContain("settle this")
    expect(verdict).toContain("A final")
    expect(verdict).toContain("B final")
  })

  test("a failed peer drops out of later rounds and is named to the synthesizer", async () => {
    const h = harness({ behavior: { b: { error: "provider said no" } } })
    const log = await h.run(swarm(["a", "b"], 3)).done

    // b fails in round 1 and is never prompted again — reopening a session for
    // it in round 2 would answer with no memory of the round every peer has.
    expect(h.promptLog.filter((turn) => turn.node === "b")).toHaveLength(1)
    expect(h.promptLog.filter((turn) => turn.node === "a")).toHaveLength(3)
    expect(h.prompts.get("verdict")).toContain("Agents that produced nothing")
    expect(log.nodes.find((node) => node.id === "b")!.status).toBe("error")
    expect(log.nodes.find((node) => node.id === "verdict")!.status).toBe("done")
  })

  test("a one-round swarm answers once and goes straight to the verdict", async () => {
    const h = harness()
    await h.run(swarm(["a", "b"], 1)).done

    expect(h.dispatched).toEqual(["a", "b", "verdict"])
    // The briefing still names round 1; what must not exist is a second turn.
    expect(h.prompts.get("a")).toContain("There are no further rounds")
    expect(h.promptLog.filter((turn) => turn.node === "a")).toHaveLength(1)
  })

  test("peers in a round run concurrently — they are answering the same question at once", async () => {
    const h = harness({ behavior: { a: { hold: true }, b: { hold: true } } })
    const run = h.run(swarm(["a", "b"], 1))
    await flush()

    expect(h.peak()).toBe(2)
    h.release("a")
    h.release("b")
    await run.done
  })

  test("a swarm with no synthesizer refuses before anything is dispatched", () => {
    const h = harness()
    const graph = { ...pipeline("a", "b"), mode: "swarm" as const }
    expect(() => h.run(graph)).toThrow("synthesizer")
    expect(h.dispatched).toEqual([])
  })

  test("a cycle left over from a pipeline does not stop a swarm — swarm reads no edges", async () => {
    const h = harness()
    const graph = pipeline("a->b", "b->a")
    graph.nodes.push({ id: "verdict", role: "synthesizer", agent: { prompt: "" }, position: { x: 0, y: 0 } })
    const log = await h.run({ ...graph, mode: "swarm", rounds: 1 }).done

    expect(log.status).toBe("done")
    expect(h.dispatched).toEqual(["a", "b", "verdict"])
  })
})

describe("orchestration mode", () => {
  const block = (body: string) => "```openflow\n" + body + "\n```"
  const dispatch = (...cards: string[]) =>
    block(JSON.stringify({ dispatch: cards.map((card) => ({ card, task: `do ${card}` })) }))
  const final = (answer: string) => block(JSON.stringify({ final: answer }))

  /** A tree, with `mode` and the caps a run reads. */
  function tree(spec: string[], options: { depth?: number; dispatches?: number } = {}): Pipeline {
    return { ...pipeline(...spec), mode: "orchestration", ...options }
  }

  test("dispatches, reads what came back, then answers", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("a", "b") },
        a: { output: "a found this" },
        b: { output: "b found that" },
      },
    })
    // The root's second turn answers; the fake returns one fixed text per node,
    // so the answer arrives by re-behaving the root mid-run is not possible —
    // instead the budget is 1, which forces the answer on the last turn.
    const log = await h.run(tree(["root->a", "root->b"], { dispatches: 1 })).done

    expect(h.dispatched.slice(0, 3)).toEqual(["root", "a", "b"])
    expect(h.prompts.get("a")).toContain("do a")
    expect(h.prompts.get("b")).toContain("do b")
    expect(log.nodes.find((node) => node.id === "a")!.status).toBe("done")
  })

  test("an orchestrator that answers straight away spends nothing on its cards", async () => {
    const h = harness({ behavior: { root: { output: final("the answer") } } })
    const log = await h.run(tree(["root->a", "root->b"])).done

    expect(h.dispatched).toEqual(["root"])
    expect(log.status).toBe("done")
    // The parsed answer replaces the raw block — the run's result is the answer,
    // not the control instruction that carried it.
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("the answer")
    // Cards nobody dispatched did not fail; they were not needed.
    expect(log.nodes.find((node) => node.id === "a")!.status).toBe("skipped")
  })

  test("a subagent with cards of its own orchestrates its subtree one level down", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("mid") },
        mid: { output: dispatch("leaf") },
        leaf: { output: "leaf did the work" },
      },
    })
    await h.run(tree(["root->mid", "mid->leaf"], { depth: 2, dispatches: 1 })).done

    expect(h.dispatched.slice(0, 3)).toEqual(["root", "mid", "leaf"])
    // The leaf is briefed as a card, not as an orchestrator: it has nobody to
    // dispatch to and is never shown the protocol.
    expect(h.prompts.get("leaf")).toContain("Your assignment")
    expect(h.prompts.get("leaf")).not.toContain("Cards you can dispatch to")

    // mid gets the orchestrator briefing on its first turn, naming its own one
    // card — and is told it is a subagent, not the run's orchestrator.
    const opening = h.promptLog.find((entry) => entry.node === "mid")!.text
    expect(opening).toContain("Cards you can dispatch to — 1")
    expect(opening).toContain("`leaf`")
    expect(opening).toContain("You are a subagent of an OpenFlow run")
  })

  test("cards in one dispatch run at the same time", async () => {
    const h = harness({
      behavior: { root: { output: dispatch("a", "b") }, a: { hold: true }, b: { hold: true } },
    })
    const run = h.run(tree(["root->a", "root->b"], { dispatches: 1 }))
    await flush()

    expect(h.peak()).toBe(2)
    h.release("a")
    h.release("b")
    await run.done
  })

  test("a malformed block is handed back, with the reason, and the ask gets terser", async () => {
    const h = harness({ behavior: { root: { output: "I will just answer in prose." } } })
    const log = await h.run(tree(["root->a"])).done

    // The original turn and three re-asks. One re-ask was the old rule and it
    // threw away real runs: measured, a card was a single stray character from
    // a correct dispatch it had spent twelve minutes reasoning towards.
    const asks = h.promptLog.filter((turn) => turn.node === "root")
    expect(asks).toHaveLength(4)
    expect(asks[1].text).toContain("no ```openflow block")
    expect(asks[1].text).toContain("`a`")
    // Each ask is shorter than the last: a long explanation of why a card is
    // writing prose is more prose.
    expect(asks[2].text.length).toBeLessThan(asks[1].text.length)
    expect(asks[3].text.length).toBeLessThan(asks[2].text.length)
    expect(asks[3].text).toContain("and nothing else")
    expect(log.nodes.find((node) => node.id === "root")!.status).toBe("error")
    expect(log.nodes.find((node) => node.id === "root")!.error).toContain("control block")
    expect(log.status).toBe("error")
  })

  test("a turn that said nothing at all is told that, not that its block was malformed", async () => {
    // Measured: a card that ends its turn on a tool call leaves no text, and
    // being told its block was invalid when it sent no message reads as
    // nonsense — it repeats the same empty turn.
    const h = harness({ behavior: { root: { output: "" } } })
    await h.run(tree(["root->a"])).done

    expect(h.promptLog[1].text).toContain("no message at all")
    expect(h.promptLog[1].text).toContain("ended it on a tool call")
  })

  test("dispatching a card that is not below you is refused before a session opens", async () => {
    const h = harness({
      behavior: { root: { output: block(JSON.stringify({ dispatch: [{ card: "ghost", task: "x" }] })) } },
    })
    await h.run(tree(["root->a"])).done

    expect(h.dispatched.filter((node) => node !== "root")).toEqual([])
    expect(h.promptLog[1].text).toContain("not a card you can dispatch to")
  })

  test("the dispatch budget is a cap on turns, and the last one demands an answer", async () => {
    const h = harness({ behavior: { root: { output: dispatch("a") }, a: { output: "a says so" } } })
    const log = await h.run(tree(["root->a"], { dispatches: 2 })).done

    // Turn 1 and 2 dispatch; turn 3 is the forced answer. This root dispatches
    // again instead, which is where the loop is stopped rather than spun.
    const turns = h.promptLog.filter((entry) => entry.node === "root")
    expect(turns).toHaveLength(3)
    expect(turns[2].text).toContain("no dispatches left")
    expect(turns[2].text).toContain("Answer now")
    expect(log.nodes.find((node) => node.id === "root")!.error).toContain("kept dispatching")
    // a is dispatched twice and keeps its one session across both.
    expect(h.promptLog.filter((entry) => entry.node === "a")).toHaveLength(2)
    expect(new Set(h.sessionOf.values()).size).toBe(2)
    expect(log.nodes.find((node) => node.id === "root")!.status).toBe("error")
  })

  test("a card dispatched again is told the old assignment is over", async () => {
    const h = harness({ behavior: { root: { output: dispatch("a") }, a: { output: "a says so" } } })
    await h.run(tree(["root->a"], { dispatches: 2 })).done

    const turns = h.promptLog.filter((entry) => entry.node === "a")
    expect(turns[0].text).toContain("# Your assignment")
    expect(turns[1].text).toContain("A new assignment")
    expect(turns[1].text).not.toContain("# OpenFlow")
  })

  test("a failed card is named to its orchestrator rather than ending the run", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("a", "b") },
        a: { error: "provider said no" },
        b: { output: "b managed it" },
      },
    })
    await h.run(tree(["root->a", "root->b"], { dispatches: 1 })).done

    const second = h.promptLog.filter((entry) => entry.node === "root")[1].text
    expect(second).toContain("failed")
    expect(second).toContain("provider said no")
    expect(second).toContain("b managed it")
  })

  test("results are ordered the way the orchestrator asked for them", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("b", "a") },
        a: { hold: true, output: "a text" },
        b: { output: "b text" },
      },
    })
    const run = h.run(tree(["root->a", "root->b"], { dispatches: 1 }))
    await flush()
    // a settles last, so completion order and dispatch order disagree.
    h.release("a")
    await run.done

    const second = h.promptLog.filter((entry) => entry.node === "root")[1].text
    expect(second.indexOf("(b)")).toBeLessThan(second.indexOf("(a)"))
  })

  /** A card's session reporting a write, the way the bus reports one. */
  function wrote(h: ReturnType<typeof harness>, node: string, path: string) {
    h.emit({
      type: "session.next.tool.called",
      data: { sessionID: h.sessionOf.get(node), callID: `${node}-${path}`, tool: "write", input: { path, content: "x" } },
    } as any)
  }

  test("two cards writing one file in a batch is reported to the orchestrator", async () => {
    // Nothing locks a file and the pool ran both at once, so the later write
    // won and the earlier card still reported success. The orchestrator is the
    // only card that can act on that, and only before it decides what to do next.
    const h = harness({
      behavior: {
        root: { outputs: [dispatch("a", "b"), final("shipped")] },
        a: { hold: true, output: "a rewrote the loop" },
        b: { hold: true, output: "b tuned the physics" },
      },
    })
    const run = h.run(tree(["root->a", "root->b"], { dispatches: 2 }))
    await flush()
    wrote(h, "a", "src/game.ts")
    wrote(h, "b", "src/game.ts")
    wrote(h, "b", "src/only-b.ts")
    h.release("a")
    h.release("b")
    await run.done

    const second = h.promptLog.filter((entry) => entry.node === "root")[1].text
    expect(second).toContain("wrote over each other")
    expect(second).toContain("`src/game.ts` — a, b")
    // The file only one card touched is not a finding.
    expect(second).not.toContain("only-b.ts")
    // Reported after what the cards returned, so the orchestrator reads the
    // answers and then what is wrong with them.
    expect(second.indexOf("a rewrote the loop")).toBeLessThan(second.indexOf("wrote over each other"))
  })

  test("cards that stayed in their own files are told nothing", async () => {
    const h = harness({
      behavior: {
        root: { outputs: [dispatch("a", "b"), final("shipped")] },
        a: { hold: true, output: "a text" },
        b: { hold: true, output: "b text" },
      },
    })
    const run = h.run(tree(["root->a", "root->b"], { dispatches: 2 }))
    await flush()
    wrote(h, "a", "src/a.ts")
    wrote(h, "b", "src/b.ts")
    h.release("a")
    h.release("b")
    await run.done

    expect(h.promptLog.filter((entry) => entry.node === "root")[1].text).not.toContain("wrote over each other")
  })

  test("the same file in two different batches is iteration, not a collision", async () => {
    // The orchestrator dispatched these in sequence and knows which came
    // second. Only a batch leaves writes unordered.
    const h = harness({
      behavior: {
        root: { outputs: [dispatch("a"), dispatch("b"), final("shipped")] },
        a: { hold: true, output: "a text" },
        b: { hold: true, output: "b text" },
      },
    })
    const run = h.run(tree(["root->a", "root->b"], { dispatches: 3 }))
    await flush()
    wrote(h, "a", "src/game.ts")
    h.release("a")
    await flush()
    wrote(h, "b", "src/game.ts")
    h.release("b")
    await run.done

    for (const entry of h.promptLog.filter((entry) => entry.node === "root"))
      expect(entry.text).not.toContain("wrote over each other")
  })

  test("a graph deeper than its cap refuses before anything is dispatched", () => {
    const h = harness()
    expect(() => h.run(tree(["root->a", "a->b", "b->c"], { depth: 2 }))).toThrow("deep")
    expect(h.dispatched).toEqual([])
  })

  test("a card two orchestrators both dispatch refuses before anything runs", () => {
    const h = harness()
    expect(() => h.run(tree(["root->a", "root->b", "a->shared", "b->shared"]))).toThrow("more than one")
    expect(h.dispatched).toEqual([])
  })

  test("two cards with nothing pointing at them refuse — a run has one result", () => {
    const h = harness()
    expect(() => h.run(tree(["root->a", "other->b"]))).toThrow("exactly one")
    expect(h.dispatched).toEqual([])
  })
})

describe("orchestration over the MCP tools", () => {
  const call = (name: string, input: unknown) => [{ name, input }]

  function tree(spec: string[], options: { depth?: number; dispatches?: number } = {}): Pipeline {
    return { ...pipeline(...spec), mode: "orchestration", ...options }
  }

  /**
   * The channel is parked — no MCP tool reaches a v2 session in this fork — so
   * every test here turns it on explicitly. That is also what pins the code as
   * working for the day upstream wires MCP into v2; the default is covered by
   * its own test below.
   */
  const on = { toolChannel: true } as const

  test("a dispatch tool call is read, and the text is never consulted", async () => {
    const h = harness({
      behavior: {
        // Prose only — under the text protocol this turn would have failed.
        root: {
          output: "Right, I will split this between the two of them.",
          calls: call("openflow_dispatch", {
            assignments: [
              { card: "a", task: "take the first half" },
              { card: "b", task: "take the second" },
            ],
          }),
        },
      },
    })
    await h.run(tree(["root->a", "root->b"], { dispatches: 1 }), "do the thing", on).done

    expect(h.dispatched.slice(0, 3)).toEqual(["root", "a", "b"])
    expect(h.prompts.get("a")).toContain("take the first half")
    expect(h.prompts.get("b")).toContain("take the second")
  })

  test("a finish tool call ends the run, and its answer is the result", async () => {
    const h = harness({
      behavior: { root: { output: "thinking out loud", calls: call("openflow_finish", { answer: "the answer" }) } },
    })
    const log = await h.run(tree(["root->a"]), "do the thing", on).done

    expect(h.dispatched).toEqual(["root"])
    expect(log.status).toBe("done")
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("the answer")
  })

  test("the call survives the card carrying on afterwards", async () => {
    // The failure the tool channel exists to fix: a model emitted a valid
    // decision and then kept working, so the decision was no longer in the
    // message OpenFlow read. Newest-first means the to-do list written after
    // is skipped and the dispatch under it still counts.
    const h = harness({
      behavior: {
        root: {
          output: "and then I wrote a to-do list",
          calls: [
            { name: "todowrite", input: { todos: [] } },
            { name: "openflow_dispatch", input: { assignments: [{ card: "a", task: "do it" }] } },
          ],
        },
      },
    })
    await h.run(tree(["root->a"], { dispatches: 1 }), "do the thing", on).done

    expect(h.dispatched.slice(0, 2)).toEqual(["root", "a"])
    expect(h.prompts.get("a")).toContain("do it")
  })

  test("the newest of our calls wins over an older one", async () => {
    const h = harness({
      behavior: {
        root: {
          output: "",
          calls: [
            { name: "openflow_finish", input: { answer: "changed my mind" } },
            { name: "openflow_dispatch", input: { assignments: [{ card: "a", task: "stale" }] } },
          ],
        },
      },
    })
    const log = await h.run(tree(["root->a"]), "do the thing", on).done

    expect(h.dispatched).toEqual(["root"])
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("changed my mind")
  })

  test("a bad tool call is refused the same way a bad block is", async () => {
    const h = harness({
      behavior: { root: { output: "", calls: call("openflow_dispatch", { assignments: [{ card: "ghost", task: "x" }] }) } },
    })
    await h.run(tree(["root->a"]), "do the thing", on).done

    expect(h.dispatched.filter((node) => node !== "root")).toEqual([])
    expect(h.promptLog[1].text).toContain("not a card you can dispatch to")
  })

  test("with no tool calls at all, the fenced block still decides", async () => {
    // A host without the MCP server installed, or a card whose allowlist does
    // not include it, keeps working.
    const h = harness({
      behavior: { root: { output: "```openflow\n" + JSON.stringify({ final: "text still works" }) + "\n```" } },
    })
    const log = await h.run(tree(["root->a"]), "do the thing", on).done

    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("text still works")
  })
})

describe("a tool call belongs to the turn that made it", () => {
  test("a rejected call is not read again on the re-ask", async () => {
    // Measured: the re-ask answered correctly and was then overruled by the
    // very call that had just been rejected, because the history read was not
    // bounded to the current turn. The harness models the fix by clearing the
    // calls once they have been consumed, which is what the user-message bound
    // does against a real server.
    const h = harness({
      behavior: {
        root: {
          output: "```openflow\n" + JSON.stringify({ final: "answered on the re-ask" }) + "\n```",
          // The same call, still in the history on the re-ask — which is what a
          // real session looks like, since the orchestrator is re-prompted into
          // the one it already holds. Its id has been consumed, so the second
          // turn falls through to the text instead of acting on it again.
          calls: [{ id: "call-1", name: "openflow_dispatch", input: { assignments: [{ card: "ghost", task: "x" }] } }],
        },
      },
    })
    const log = await h.run({ ...pipeline("root->a"), mode: "orchestration" }, "do the thing", { toolChannel: true }).done

    expect(h.promptLog.filter((entry) => entry.node === "root")).toHaveLength(2)
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("answered on the re-ask")
    expect(log.status).toBe("done")
  })
})

describe("the tool channel is parked", () => {
  test("by default a run never asks for tool calls at all", async () => {
    // No MCP tool can reach a v2 session in this fork, so scanning for one
    // would be a request per orchestrator turn that cannot find anything.
    let asked = 0
    const h = harness({
      behavior: {
        root: {
          output: "```openflow\n" + JSON.stringify({ final: "the block decided" }) + "\n```",
          calls: [{ id: "call-1", name: "openflow_finish", input: { answer: "the tool decided" } }],
        },
      },
    })
    const counting = { ...h.deps, api: { ...h.deps.api, sessionCalls: async (id: string) => (asked++, []) } }
    const log = await start({ ...pipeline("root->a"), mode: "orchestration" }, "do the thing", h.hooks, {}, counting)
      .done

    expect(asked).toBe(0)
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("the block decided")
  })
})

describe("gauntlet mode", () => {
  const block = (body: string) => "```openflow\n" + body + "\n```"
  const dispatch = (...cards: string[]) =>
    block(JSON.stringify({ dispatch: cards.map((card) => ({ card, task: `do ${card}` })) }))
  const final = (answer: string) => block(JSON.stringify({ final: answer }))

  /** An orchestration running as a gauntlet, with a model on every card. */
  function gauntlet(spec: string[], settings: Pipeline["gauntlet"] = { bar: "the reference build" }): Pipeline {
    const graph = pipeline(...spec)
    for (const node of graph.nodes) node.agent.model = "openai/gpt-x"
    return { ...graph, mode: "orchestration", gauntlet: settings }
  }

  test("refuses a canvas with nothing to judge the work", () => {
    const h = harness()
    expect(() => h.run(gauntlet(["root->builder"]))).toThrow(/reviewer card/)
    expect(h.dispatched).toEqual([])
  })

  test("the critic judges from a new session every time; the builder keeps its own", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("builder", "reviewer") },
        builder: { output: "built it" },
        reviewer: { output: "the bar still wins: the lighting is flat" },
      },
      models: ["openai/gpt-x"],
      prices: { "openai/gpt-x": [{ input: 2, output: 10, cache: { read: 0.5, write: 4 } }] },
    })
    // Two rounds: the same batch twice trips the stall bound, which is the
    // cheapest way to get a second verdict out of a fake with fixed output.
    await h.run(gauntlet(["root->builder", "root->reviewer"], { bar: "the reference build", stall: 1 })).done

    const verdicts = h.promptLog.filter((entry) => entry.node === "reviewer")
    expect(verdicts.length).toBeGreaterThan(1)
    // Every verdict is a fresh session, so every one carries the full critic
    // briefing rather than "your earlier assignment is finished with".
    for (const verdict of verdicts) {
      expect(verdict.text).toContain("You are the critic of an OpenFlow gauntlet")
      expect(verdict.text).toContain("the reference build")
    }
    // The builder is the opposite: it remembers what it built.
    const builds = h.promptLog.filter((entry) => entry.node === "builder")
    expect(builds[0].text).toContain("You are one card in an OpenFlow run")
    expect(builds[1].text).toContain("A new assignment")
  })

  test("the same batch handed out again and again stops the run", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("builder", "reviewer") },
        builder: { output: "built it" },
        reviewer: { output: "same gap as last time" },
      },
      models: ["openai/gpt-x"],
      prices: { "openai/gpt-x": [{ input: 2, output: 10, cache: { read: 0.5, write: 4 } }] },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"], { bar: "b", stall: 2 })).done

    const root = log.nodes.find((node) => node.id === "root")!
    expect(root.error).toContain("kept dispatching")
    // Three identical batches, a turn to be told to answer, and it dispatched
    // again — nowhere near the 500-dispatch ceiling.
    expect(h.dispatched.filter((id) => id === "root").length).toBeLessThan(8)
    expect(h.prompts.get("root")).toContain("same work")
  })

  test("the spend cap is what actually ends an hours-long run", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("builder", "reviewer") },
        builder: { output: "built it" },
        reviewer: { output: "not there yet" },
      },
      models: ["openai/gpt-x"],
      prices: { "openai/gpt-x": [{ input: 2, output: 10, cache: { read: 0.5, write: 4 } }] },
      steps: {
        builder: [
          {
            messageID: "m1",
            model: "openai/gpt-x",
            tokens: { input: 4_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    })
    // $8 of input against a $3 cap, spent on the first round.
    await h.run(gauntlet(["root->builder", "root->reviewer"], { bar: "b", maxSpend: 3 })).done

    expect(h.prompts.get("root")).toContain("$3 budget")
    expect(h.prompts.get("root")).toContain("Answer now")
    expect(h.dispatched.filter((id) => id === "builder").length).toBe(1)
  })

  test("a model the catalog cannot price stops the run rather than running uncapped", async () => {
    const h = harness({
      behavior: {
        root: { output: dispatch("builder", "reviewer") },
        builder: { output: "built it" },
        reviewer: { output: "not there yet" },
      },
      models: ["openai/gpt-x"],
      steps: {
        builder: [
          {
            messageID: "m1",
            model: "openai/gpt-x",
            tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"], { bar: "b", maxSpend: 3 })).done

    expect(h.prompts.get("root")).toContain("cannot be priced")
    expect(log.nodes.find((node) => node.id === "root")!.error).toContain("unpriced")
  })

  test("an orchestrator cannot end a gauntlet on its own say-so", async () => {
    // Measured against a real run: the orchestrator repaired a broken build
    // itself, then wrote a `final` certifying its own repair against every line
    // of the bar, three minutes in, having dispatched nobody.
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: { root: { output: final("it beats the reference now") } },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"])).done

    // The first answer is sent back with the reason; the fake repeats itself,
    // and the second one fails the card rather than looping forever — an
    // unjudged pass is the one output a gauntlet must never write.
    expect(h.dispatched).toEqual(["root", "root"])
    expect(h.prompts.get("root")).toContain("Not yet — nobody has judged this")
    expect(h.prompts.get("root")).toContain("`reviewer`")
    const root = log.nodes.find((node) => node.id === "root")!
    expect(root.status).toBe("error")
    expect(root.error).toContain("without sending the work to a critic")
    expect(log.status).toBe("error")
  })

  test("a run whose critics all failed ends unjudged rather than certified", async () => {
    // Measured 2026-09-01: the critic was rate limited on every dispatch, so
    // the orchestrator nominated a *builder* as the independent inspector and
    // wrote a PASS on all seven bar lines. `judged` ignored that opinion, but
    // the one-refusal rule then let the answer through, and the run reported
    // work as certified that nobody qualified had judged.
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("reviewer"), final("builder checked it, PASS"), final("PASS")] },
        reviewer: { error: "Provider request failed with HTTP 429" },
      },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"]), "do the thing", {
      rateLimitBackoff: 0,
    }).done

    const root = log.nodes.find((node) => node.id === "root")!
    expect(root.status).toBe("error")
    // The reason separates "would not" from "could not" — different problems
    // for whoever reads the log.
    expect(root.error).toContain("every critic dispatched failed")
    expect(root.error).toContain("429")
    expect(log.status).toBe("error")
  })

  test("a critic refused for rate limiting is retried, not written off", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("reviewer"), final("shipped")] },
        // Refused twice, answers on the third ask — a card that would have been
        // dead on the first 429 before.
        reviewer: {
          errors: ["Provider request failed with HTTP 429", "Provider request failed with HTTP 429"],
          output: "ours wins",
        },
      },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"]), "do the thing", {
      rateLimitBackoff: 1,
    }).done

    const reviewer = log.nodes.find((node) => node.id === "reviewer")!
    expect(reviewer.status).toBe("done")
    expect(reviewer.output).toBe("ours wins")
    // The waits are on the stream, so a run that looks stalled says why.
    expect(
      h.activity.some((row) => row.node === "reviewer" && row.event.title.includes("rate limited")),
    ).toBe(true)
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("shipped")
    expect(log.status).toBe("done")
  })

  test("a card's spend adds up across the sessions it holds", async () => {
    // Measured 2026-09-01: the critic's own cost fell from $0.0204 to $0.0023
    // across a re-dispatch and the run total fell with it, because a node's
    // usage was replaced by the newest session's rather than added to it. A
    // gauntlet is bounded by spend, so the cap was being compared against a
    // number well below what had been spent.
    const seen: string[] = []
    const h = harness({
      models: ["openai/gpt-x"],
      prices: { "openai/gpt-x": [{ input: 3, output: 0, cache: { read: 0, write: 0 } }] },
      behavior: {
        // Two different tasks, so the second round is not the same batch again
        // (that is the stall bound, and it would end the run before the second
        // verdict this test is about).
        root: {
          outputs: [
            block(JSON.stringify({ dispatch: [{ card: "reviewer", task: "judge round one" }] })),
            block(JSON.stringify({ dispatch: [{ card: "reviewer", task: "judge round two" }] })),
            final("shipped"),
          ],
        },
        reviewer: { output: "ours wins" },
      },
      // Each session bills one step of its own, keyed by a message id unique to
      // it — which is what a real server reports for a card given a new session.
      stepsOf: (sessionID, nodeID) => {
        if (nodeID === "reviewer" && !seen.includes(sessionID)) seen.push(sessionID)
        return [
          {
            messageID: `${sessionID}-m1`,
            model: "openai/gpt-x",
            tokens: { input: 1_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ]
      },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"])).done

    const reviewer = log.nodes.find((node) => node.id === "reviewer")!
    // Two verdicts, two sessions (a critic never reuses one), one billed step
    // each — so the card's cost is the sum of both, not the newest one.
    expect(h.dispatched.filter((id) => id === "reviewer").length).toBe(2)
    expect(seen.length).toBe(2)
    expect(reviewer.usage!.cost).toBeCloseTo(0.006, 6)
  })

  test("a verdict from a critic lets the answer through", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { output: dispatch("reviewer") },
        reviewer: { output: "ours wins: nothing left worth fixing" },
      },
    })
    // Round 1 dispatches the critic; the fake repeats the dispatch block, which
    // trips the stall bound, and the forced answer is accepted with no refusal
    // because a critic has judged this state.
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"], { bar: 'b', stall: 1 })).done

    expect(h.dispatched).toContain("reviewer")
    expect(h.prompts.get("root")).not.toContain("Not yet — nobody has judged this")
    expect(log.nodes.find((node) => node.id === "reviewer")!.status).toBe("done")
  })

  test("a critic dispatched alongside a builder has judged nothing", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        // Both in one batch, then an answer on the strength of that verdict.
        root: { outputs: [dispatch("builder", "reviewer"), final("shipped"), final("shipped")] },
        builder: { output: "built it" },
        reviewer: { output: "looks fine to me" },
      },
    })
    // The critic read a folder the builder was writing to in the same batch, so
    // its verdict does not count and the answer is still sent back.
    await h.run(gauntlet(["root->builder", "root->reviewer"])).done

    expect(h.promptLog.some((entry) => entry.node === "root" && entry.text.includes("Not yet"))).toBe(true)
    expect(h.prompts.get("root")).toContain("no builder in the same batch")
  })

  test("a critic dispatched on its own does judge", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("builder"), dispatch("reviewer"), final("shipped")] },
        builder: { output: "built it" },
        reviewer: { output: "ours wins" },
      },
    })
    const log = await h.run(gauntlet(["root->builder", "root->reviewer"])).done

    // Built, then judged on its own, then answered — no refusal anywhere.
    expect(h.dispatched.filter((id) => id !== "root")).toEqual(["builder", "reviewer"])
    expect(h.promptLog.some((entry) => entry.node === "root" && entry.text.includes("Not yet"))).toBe(false)
    expect(log.nodes.find((node) => node.id === "root")!.output).toBe("shipped")
    expect(log.status).toBe("done")
  })

  test("two critics in one batch judge one after the other, not at once", async () => {
    // Both run the build and the tests in the one working directory; at the
    // same time they would grade each other's half-built output.
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("reviewer", "second"), final("shipped")] },
        reviewer: { hold: true, output: "ours wins" },
        second: { hold: true, output: "ours wins too" },
      },
    })
    const graph = gauntlet(["root->reviewer", "root->second"])
    graph.nodes.find((node) => node.id === "second")!.role = "reviewer"
    const run = h.run(graph)
    await flush()
    await flush()

    // Only one critic has been prompted; the other waits for it to finish.
    expect(h.dispatched.filter((id) => id !== "root")).toEqual(["reviewer"])
    h.release("reviewer")
    await flush()
    await flush()
    expect(h.dispatched.filter((id) => id !== "root")).toEqual(["reviewer", "second"])
    h.release("second")
    const log = await run.done
    expect(log.status).toBe("done")
  })

  test("a builder and a critic in one batch still run together — that batch judges nothing anyway", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("builder", "reviewer"), dispatch("reviewer"), final("shipped")] },
        builder: { hold: true, output: "built it" },
        reviewer: { hold: true, output: "ours wins" },
      },
    })
    const run = h.run(gauntlet(["root->builder", "root->reviewer"]))
    await flush()
    await flush()
    expect(h.dispatched.filter((id) => id !== "root").sort()).toEqual(["builder", "reviewer"])
    h.release("builder")
    h.release("reviewer")
    await flush()
    await flush()
    h.release("reviewer")
    await run.done
  })

  test("a critic that changed the work has its verdict thrown away", async () => {
    // Its write tools are refused, so the only way left is a shell line. A
    // verdict written over a tree the critic itself altered grades its own
    // repair, which is the failure a separate critic exists to prevent.
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("builder"), dispatch("reviewer"), final("shipped"), final("shipped")] },
        builder: { output: "built it" },
        reviewer: { hold: true, output: "ours wins, once I fixed the import" },
      },
    })
    const run = h.run(gauntlet(["root->builder", "root->reviewer"]))
    await flush()
    await flush()
    h.emit({
      type: "session.next.tool.called",
      data: {
        sessionID: h.sessionOf.get("reviewer"),
        callID: "reviewer-sed",
        tool: "bash",
        input: { command: "sed -i 's/foo/bar/' src/game.ts" },
      },
    } as any)
    h.release("reviewer")
    const log = await run.done

    const reviewer = log.nodes.find((node) => node.id === "reviewer")!
    expect(reviewer.status).toBe("error")
    expect(reviewer.error).toContain("src/game.ts (probable)")
    // The orchestrator is told, and its verdict-less answer is refused as unjudged.
    expect(h.promptLog.some((entry) => entry.node === "root" && entry.text.includes("verdict is discarded"))).toBe(true)
    expect(h.promptLog.some((entry) => entry.node === "root" && entry.text.includes("Not yet"))).toBe(true)
  })

  test("the card that assigns the work may not change it", async () => {
    const h = harness({
      models: ["openai/gpt-x"],
      behavior: {
        root: { outputs: [dispatch("builder"), dispatch("reviewer"), final("shipped")] },
        builder: { hold: true },
        reviewer: { output: "ours wins" },
      },
    })
    const run = h.run(gauntlet(["root->builder", "root->reviewer"]))
    await flush()
    // `auto` answers "once" to everything, which is how a card configured with
    // `edit: deny` still gets the tool. In a gauntlet the orchestrator is not
    // allowed to fix the thing it will later be asked to judge the fixing of.
    h.ask("root", { id: "p1", action: "edit", resources: ["game.js"] })
    h.ask("builder", { id: "p2", action: "edit", resources: ["game.js"] })
    // Looking is not changing. Measured: refusing this left an orchestrator
    // unable to run `dir`, and it produced no control block at all.
    h.ask("root", { id: "p3", action: "bash", resources: ['dir "."'] })
    await flush()
    h.release("builder")
    await run.done

    expect(h.replies.find((reply) => reply.requestID === "p1")?.reply).toBe("reject")
    expect(h.replies.find((reply) => reply.requestID === "p2")?.reply).toBe("once")
    expect(h.replies.find((reply) => reply.requestID === "p3")?.reply).toBe("once")
  })
})

describe("a card whose tools were rejected", () => {
  test("says so in its answer instead of reporting a clean success", async () => {
    // Measured: a card burned 1.36M tokens with every `write` bounced as
    // "Invalid JSON input for openai-chat tool call write", settled `done`, and
    // the orchestrator re-dispatched on the strength of a success that never
    // happened. A rejected tool call is not a failed turn — the assistant
    // message completes cleanly — so nothing else catches this.
    const h = harness({ behavior: { a: { hold: true, output: "all done, file written" } } })
    const graph = pipeline("a")
    const run = h.run(graph)
    await flush()

    h.emit({
      type: "session.next.tool.called",
      data: { sessionID: h.sessionOf.get("a"), callID: "call-1", tool: "write", input: { path: "game.js" } },
    } as any)
    h.emit({
      type: "session.next.tool.failed",
      data: {
        sessionID: h.sessionOf.get("a"),
        callID: "call-1",
        error: { message: "Invalid JSON input for openai-chat tool call write" },
      },
    } as any)
    await flush()
    h.release("a")
    const log = await run.done

    const node = log.nodes.find((entry) => entry.id === "a")!
    expect(node.toolFailures).toBe(1)
    expect(node.output).toContain("all done, file written")
    expect(node.output).toContain("rejected by the provider")
    // It is surfaced, not treated as a failure: one call can fail and the next succeed.
    expect(node.status).toBe("done")
  })

  test("a clean turn carries no note and no count", async () => {
    const h = harness({ behavior: { a: { output: "wrote it" } } })
    const log = await h.run(pipeline("a")).done

    const node = log.nodes.find((entry) => entry.id === "a")!
    expect(node.toolFailures).toBeUndefined()
    expect(node.output).toBe("wrote it")
  })
})

describe("a card whose model cannot read images", () => {
  const vision = ["openai/sees"]

  test("is told so, because it can reach an image without anyone attaching one", async () => {
    // Measured: a card screenshotted the running game, the orchestrator opened
    // the capture, and the provider answered the whole request with
    // "HTTP 404: No endpoints found that support image input". The attachment
    // filter never sees a file a card opens with `read`.
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/blind"
    const h = harness({ models: ["openai/blind", ...vision], vision })
    await h.run(graph).done

    expect(h.prompts.get("a")).toContain("You cannot read images")
    expect(h.prompts.get("a")).toContain("fails your entire turn")
  })

  test("a model with vision is not lectured about it", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/sees"
    const h = harness({ models: ["openai/blind", ...vision], vision })
    await h.run(graph).done

    expect(h.prompts.get("a")).not.toContain("You cannot read images")
  })

  test("a model the catalog does not know is left alone rather than guessed at", async () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.model = "openai/unknown"
    const h = harness({ models: [], catalogRetry: 0 } as any)
    await h.run(graph, "do the thing", { catalogRetry: 0 }).done

    expect(h.prompts.get("a") ?? "").not.toContain("You cannot read images")
  })
})
