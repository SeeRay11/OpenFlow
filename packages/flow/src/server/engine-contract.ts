import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BusEvent, CreateSession, EngineApi, HealthInfo, ModelInfo, SessionRow, Turn } from "../../shared/engine"
import type { ContractDriver, TurnScript } from "./testing/engine-script"

/**
 * The behaviours every `EngineApi` implementation must show, written once and
 * run against each: `createFakeEngine` (`src/server/engine-contract.test.ts`)
 * and the browser client over real HTTP against the Omp host driving a stub
 * omp process (`lib/host/engine-contract.test.ts`). A fake that passes only
 * what its own author thought of proves nothing; this suite is what ties it to
 * the adapter, so a double that drifts from the real engine fails here first.
 *
 * Nothing here knows which implementation it runs against. What differs is
 * how a scripted turn is produced, and that is the `ContractDriver` the factory
 * supplies: the fake plays the script in memory, the host test turns it into
 * frames for the stub omp.
 *
 * Conventions every scenario relies on:
 *  - one run id per scenario, released at its end, so scenarios never see each
 *    other's sessions and the suite can share one engine;
 *  - a script is bound to a turn when the prompt is sent, so changing it
 *    between two prompts gives two sessions two different turns;
 *  - at most one ask (`StepScript.ask`, `testing/engine-script.ts`) per session: the stub omp pauses on
 *    "a response was received", not on "this response".
 */

/* ------------------------------------------------------------------ surface */

/**
 * `EngineApi` with its optional members, plus the rest of what the host
 * answers and `src/server/client.ts` exposes: the session list, the release
 * routes, the history read and the live set.
 */
export type EngineSurface = Omit<Required<EngineApi>, "waitForIdle"> & {
  /** `slice` is how long one request to the engine may be held open; the wait is re-issued until the turn settles. */
  waitForIdle(sessionID: string, options?: { signal?: AbortSignal; interval?: number; timeout?: number; slice?: number }): Promise<void>
  sessions(limit?: number): Promise<SessionRow[]>
  sessionTranscript(sessionID: string, limit?: number): Promise<Turn[]>
  health(): Promise<HealthInfo>
  /** Ids whose agent loop is executing right now. */
  active(): Promise<string[]>
}

export type ContractInstance = {
  api: EngineSurface
  driver: ContractDriver
  /** An absolute directory that exists; sessions are created in it. */
  directory: string
  /** Stops everything the instance started. Idempotent. */
  close(): Promise<void>
  /** What is still running once `close()` has returned: process ids, session ids. Empty when nothing is. */
  leftovers(): Promise<string[]>
}

export type ContractOptions = {
  /** Registers the suite as skipped, e.g. where the stub omp cannot run. */
  skip?: boolean
  /**
   * Whether this leg's driver can hold a session's startup (`ContractDriver.holdStartup`). The scenarios that need
   * it run only where it is true and are registered as skipped, named, where it is not: the fake leg declares it,
   * the host leg declares it once its stub omp can be held before `ready`.
   */
  holdsStartup?: boolean
}

/* ------------------------------------------------------------------ helpers */

const SCENARIO_MS = 30_000
const EVENT_MS = 10_000

const ANSWERED: TurnScript = { steps: [{ text: "ok" }] }

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(`not met in time: ${what}`)
}

/** The rejection of a call that must fail. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  const outcome = await work.then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  )
  if (!outcome.failed) throw new Error("expected the call to be rejected")
  return outcome.error
}

/** The HTTP-like status an error carries (`src/server/engine.ts` branches on `status === 404`). */
function statusOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error ? error.status : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Listener = {
  events: BusEvent[]
  /** Everything the stream carried for one session, in arrival order. */
  of(sessionID: string): BusEvent[]
  /** Resolves with the first `count` events matching, whether already seen or still to come. */
  waitFor(match: (event: BusEvent) => boolean, count?: number): Promise<BusEvent[]>
  stop(): Promise<void>
}

type Context = {
  api: EngineSurface
  driver: ContractDriver
  /** This scenario's run id. */
  run: string
  /** `provider/id` of the first model in the catalog. */
  model: string
  /** A run id of its own, released with the scenario. */
  newRun(): string
  input(node: string, overrides?: Partial<CreateSession>, run?: string): CreateSession
  open(node?: string, overrides?: Partial<CreateSession>, run?: string): Promise<string>
  /** Subscribes and returns once the stream is proven live: the bus has no replay, so events before that point are lost. */
  listen(): Promise<Listener>
}

/* ---------------------------------------------------------------- the suite */

export function defineEngineContract(label: string, factory: () => Promise<ContractInstance>, options: ContractOptions = {}) {
  describe.skipIf(options.skip === true)(`EngineApi contract: ${label}`, () => {
    const created = Promise.withResolvers<ContractInstance>()
    const sequence = { runs: 0, nodes: 0 }

    beforeAll(async () => {
      try {
        created.resolve(await factory())
      } catch (error) {
        created.reject(error)
        throw error
      }
    }, 60_000)

    afterAll(async () => {
      const instance = await created.promise.catch(() => undefined)
      await instance?.close()
    })

    function scenario(name: string, body: (ctx: Context) => Promise<void>) {
      test(
        name,
        async () => {
          const instance = await created.promise
          const api = instance.api
          const driver = instance.driver
          const runs: string[] = []
          const listeners: Listener[] = []
          const newRun = () => {
            const run = `contract-${++sequence.runs}`
            runs.push(run)
            return run
          }
          const run = newRun()
          const first = (await api.models())[0]
          if (!first) throw new Error("the catalog is empty")
          const model = `${first.providerID}/${first.id}`

          const input = (node: string, overrides: Partial<CreateSession> = {}, target = run): CreateSession => ({
            runId: target,
            nodeId: node,
            card: { key: `card-${node}`, role: "Builder" },
            model,
            directory: instance.directory,
            permissions: "auto",
            swarm: "off",
            ...overrides,
          })
          const open = async (node = `node-${++sequence.nodes}`, overrides: Partial<CreateSession> = {}, target = run) =>
            (await api.createSession(input(node, overrides, target))).id

          const ctx: Context = {
            api,
            driver,
            run,
            model,
            newRun,
            input,
            open,
            async listen() {
              const listener = await listenTo(ctx)
              listeners.push(listener)
              return listener
            },
          }

          await driver.script(ANSWERED)
          try {
            await body(ctx)
          } finally {
            await Promise.all(listeners.map((listener) => listener.stop()))
            await Promise.all(runs.map((target) => api.releaseRun(target)))
          }
        },
        SCENARIO_MS,
      )
    }

    /** A scenario that needs `driver.holdStartup`: registered as a named skip on a leg that cannot hold a start. */
    function heldScenario(name: string, body: (ctx: Context) => Promise<void>) {
      if (options.holdsStartup === true) return scenario(name, body)
      test.skip(`${name} [skipped: this leg declares no holdsStartup]`, () => undefined)
    }

    /* ------------------------------------------------------ catalog, health */

    scenario("health reports a reachable engine and counts the live sessions", async (ctx) => {
      const before = await ctx.api.health()
      expect(before.ok).toBe(true)
      expect(before.omp.available).toBe(true)
      const id = await ctx.open()
      expect((await ctx.api.health()).sessions.live).toBe(before.sessions.live + 1)
      await ctx.api.release(id)
      expect((await ctx.api.health()).sessions.live).toBe(before.sessions.live)
    })

    scenario("the catalog lists models, each addressed by provider and id, and a session can be created on one", async (ctx) => {
      const catalog = await ctx.api.models()
      expect(catalog.length).toBeGreaterThan(0)
      for (const model of catalog) {
        expect(model.providerID.length).toBeGreaterThan(0)
        expect(model.id.length).toBeGreaterThan(0)
      }
      const keys = catalog.map((model) => `${model.providerID}/${model.id}`)
      expect(new Set(keys).size).toBe(keys.length)
      const last = keys.at(-1) as string
      const id = await ctx.open("catalog", { model: last })
      expect((await ctx.api.sessions()).find((row) => row.id === id)?.model).toBe(last)
    })

    scenario("accepts follows the model's input modalities", async (ctx) => {
      const seeing: ModelInfo = { providerID: "p", id: "m", capabilities: { input: ["text", "image"] } }
      const blind: ModelInfo = { providerID: "p", id: "n", capabilities: { input: ["text"] } }
      expect(ctx.api.accepts(seeing, "image/png")).toBe(true)
      expect(ctx.api.accepts(blind, "image/png")).toBe(false)
      expect(ctx.api.accepts(seeing, "application/pdf")).toBe(false)
      expect(ctx.api.accepts(blind, "text/plain")).toBe(true)
      expect(ctx.api.accepts(undefined, "text/plain")).toBe(false)
    })

    scenario("describe gives one readable line for an error, with the response status when there is one", async (ctx) => {
      expect(ctx.api.describe(new Error("boom"))).toContain("boom")
      const line = ctx.api.describe({ error: "rate limited" }, new Response("{}", { status: 429 }))
      expect(line).toContain("rate limited")
      expect(line).toContain("429")
      expect(ctx.api.describe(undefined).length).toBeGreaterThan(0)
    })

    /* ---------------------------------------------------------- one turn */

    scenario("a session that was never prompted is idle", async (ctx) => {
      const id = await ctx.open()
      expect(await ctx.api.waitForIdle(id)).toBeUndefined()
      expect(await ctx.api.transcript(id)).toEqual({ text: "" })
      expect(await ctx.api.sessionSteps(id)).toEqual([])
      expect(await ctx.api.sessionCalls(id)).toEqual([])
    })

    scenario("a prompted turn settles idle and the final transcript is the answer", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "The answer is 42" }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "what is the answer?")
      await ctx.api.waitForIdle(id)
      expect(await ctx.api.transcript(id)).toEqual({ text: "The answer is 42" })
      expect(await ctx.api.active()).not.toContain(id)
      const turns = await ctx.api.sessionTranscript(id)
      expect(turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text)).toEqual(["The answer is 42"])
    })

    scenario("a follow-up turn on the same session reads back the newest answer and keeps the earlier steps", async (ctx) => {
      const id = await ctx.open()
      await ctx.driver.script({ steps: [{ text: "first" }] })
      await ctx.api.prompt(id, "one")
      await ctx.api.waitForIdle(id)
      await ctx.driver.script({ steps: [{ text: "second" }] })
      await ctx.api.prompt(id, "two")
      await ctx.api.waitForIdle(id)
      expect(await ctx.api.transcript(id)).toEqual({ text: "second" })
      expect(await ctx.api.sessionSteps(id)).toHaveLength(2)
      const turns = await ctx.api.sessionTranscript(id)
      expect(turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text)).toEqual(["first", "second"])
    })

    scenario("steps report the tokens of each assistant step under the ids the step.ended events carry", async (ctx) => {
      const events = await ctx.listen()
      await ctx.driver.script({
        steps: [
          { text: "one", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 } },
          { text: "two", usage: { input: 300, output: 40, cacheRead: 0, cacheWrite: 2 } },
        ],
      })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      await ctx.api.waitForIdle(id)

      const steps = await ctx.api.sessionSteps(id)
      expect(steps.map((step) => step.tokens)).toEqual([
        { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 7 },
        { input: 300, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 2 },
      ])
      const ids = steps.map((step) => step.messageID)
      expect(new Set(ids).size).toBe(2)
      for (const step of steps) expect(step.model.length).toBeGreaterThan(0)

      // The engine prices from the events while the run is live and again from `sessionSteps` afterwards: one id per step, in both.
      const ended = await events.waitFor((event) => event.type === "session.next.step.ended" && event.data?.sessionID === id, 2)
      expect(ended.map((event) => event.data?.assistantMessageID)).toEqual(ids)
      expect(ended.map((event) => event.data?.tokens)).toEqual([
        { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 7 } },
        { input: 300, output: 40, reasoning: 0, cache: { read: 0, write: 2 } },
      ])
    })

    scenario("calls lists the tool calls newest first and honours the limit", async (ctx) => {
      await ctx.driver.script({
        steps: [
          {
            text: "looking",
            tools: [
              { id: "c1", name: "bash", input: { command: "ls" }, output: "a.txt" },
              { id: "c2", name: "read", input: { path: "a.txt" }, output: "hello" },
            ],
          },
          { text: "patching", tools: [{ id: "c3", name: "edit", input: { path: "a.txt", edit: "x" }, output: "ok" }] },
          { text: "done" },
        ],
      })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      await ctx.api.waitForIdle(id)
      expect(await ctx.api.sessionCalls(id)).toEqual([
        { id: "c3", name: "edit", input: { path: "a.txt", edit: "x" } },
        { id: "c2", name: "read", input: { path: "a.txt" } },
        { id: "c1", name: "bash", input: { command: "ls" } },
      ])
      expect((await ctx.api.sessionCalls(id, 2)).map((call) => call.id)).toEqual(["c3", "c2"])
    })

    scenario("a turn's events name their session and come in order: step, text, tool", async (ctx) => {
      const events = await ctx.listen()
      await ctx.driver.script({ steps: [{ text: "Hello", tools: [{ id: "call-1", name: "bash", input: { command: "ls" }, output: "a.txt" }] }] })
      const id = await ctx.open("ordered")
      await ctx.api.prompt(id, "go")
      await events.waitFor((event) => event.type === "session.next.tool.success" && event.data?.sessionID === id)
      await ctx.api.waitForIdle(id)

      const seen = events.of(id)
      const at = (type: string) => seen.findIndex((event) => event.type === type)
      for (const type of [
        "session.next.step.started",
        "session.next.text.started",
        "session.next.text.delta",
        "session.next.text.ended",
        "session.next.tool.input.started",
        "session.next.step.ended",
        "session.next.tool.called",
        "session.next.tool.success",
      ]) {
        expect(at(type), type).toBeGreaterThanOrEqual(0)
      }
      expect(at("session.next.step.started")).toBeLessThan(at("session.next.text.started"))
      expect(at("session.next.text.started")).toBeLessThan(at("session.next.text.delta"))
      expect(at("session.next.text.delta")).toBeLessThan(at("session.next.text.ended"))
      expect(at("session.next.text.ended")).toBeLessThan(at("session.next.step.ended"))
      expect(at("session.next.step.ended")).toBeLessThan(at("session.next.tool.called"))
      expect(at("session.next.tool.called")).toBeLessThan(at("session.next.tool.success"))

      const get = (type: string) => seen.find((event) => event.type === type)?.data
      expect(get("session.next.step.started")).toMatchObject({ agent: "card-ordered" })
      expect(get("session.next.text.delta")?.delta).toBe("Hello")
      expect(get("session.next.text.ended")?.text).toBe("Hello")
      expect(get("session.next.tool.called")).toMatchObject({ callID: "call-1", tool: "bash", input: { command: "ls" } })
      expect(get("session.next.tool.success")).toMatchObject({ callID: "call-1" })
    })

    scenario("a notice reaches the stream as flow.notice with its session and level", async (ctx) => {
      const events = await ctx.listen()
      await ctx.driver.script({ steps: [{ text: "ok", notice: { level: "error", message: "extension broke" } }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const [notice] = await events.waitFor((event) => event.type === "flow.notice" && event.data?.sessionID === id)
      expect(notice?.data?.level).toBe("error")
      expect(String(notice?.data?.message)).toContain("extension broke")
      await ctx.api.waitForIdle(id)
    })

    /**
     * The id an ask is published under. It is opaque: an implementation may put a per-process prefix in front of the
     * id the agent asked with, so replies go back under what the event carried and the agent's own id keys the driver.
     */
    async function publicId(events: Listener, type: string, sessionID: string, request: string) {
      const [asked] = await events.waitFor((event) => event.type === type && event.data?.sessionID === sessionID)
      const published = String(asked?.data?.id)
      expect(published === request || published.endsWith(`.${request}`)).toBe(true)
      return published
    }

    /* ------------------------------------------- permissions and questions */

    for (const reply of ["once", "always", "reject"] as const) {
      scenario(`a permission ask surfaces as an event, and a reply of ${reply} lets the turn finish`, async (ctx) => {
        const events = await ctx.listen()
        const request = `${ctx.run}-perm`
        await ctx.driver.script({ steps: [{ text: "ran it", ask: { kind: "permission", id: request, action: "bash", resource: "command: rm -rf build" } }] })
        const id = await ctx.open("approval", { permissions: "manual" })
        await ctx.api.prompt(id, "go")
        const [asked] = await events.waitFor((event) => event.type === "permission.v2.asked" && event.data?.sessionID === id)
        const published = String(asked?.data?.id)
        expect(published === request || published.endsWith(`.${request}`)).toBe(true)
        expect(asked?.data).toMatchObject({ sessionID: id, action: "bash", resources: ["command: rm -rf build"] })
        expect(await ctx.driver.decision(request)).toBeUndefined()

        await ctx.api.replyPermission(id, published, reply)
        await ctx.api.waitForIdle(id)
        expect(await ctx.driver.decision(request)).toEqual({ kind: "permission", reply })
        expect(await ctx.api.transcript(id)).toEqual({ text: "ran it" })

        // Answered once: the request is gone, which the engine reads as "nothing is waiting any more".
        expect(statusOf(await rejection(ctx.api.replyPermission(id, published, "once")))).toBe(404)
      })
    }

    scenario("a reply to a permission request nobody asked is a 404", async (ctx) => {
      const id = await ctx.open()
      expect(statusOf(await rejection(ctx.api.replyPermission(id, "no-such-request", "once")))).toBe(404)
      expect(statusOf(await rejection(ctx.api.replyPermission("no-such-session", "no-such-request", "once")))).toBe(404)
    })

    scenario("a question surfaces with its options and the answer reaches the agent", async (ctx) => {
      const events = await ctx.listen()
      const request = `${ctx.run}-ask`
      await ctx.driver.script({
        steps: [{ text: "thanks", ask: { kind: "question", id: request, question: "Which database?", header: "Storage", options: ["sqlite", "postgres"] } }],
      })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const [asked] = await events.waitFor((event) => event.type === "question.v2.asked" && event.data?.sessionID === id)
      const published = String(asked?.data?.id)
      expect(published === request || published.endsWith(`.${request}`)).toBe(true)
      expect(asked?.data).toMatchObject({
        sessionID: id,
        questions: [{ question: "Which database?", header: "Storage", options: [{ label: "sqlite" }, { label: "postgres" }] }],
      })

      await ctx.api.replyQuestion(id, published, [["sqlite"]])
      await ctx.api.waitForIdle(id)
      expect(await ctx.driver.decision(request)).toEqual({ kind: "question", answers: [["sqlite"]] })
      expect(await ctx.api.transcript(id)).toEqual({ text: "thanks" })
      expect(statusOf(await rejection(ctx.api.replyQuestion(id, published, [["sqlite"]])))).toBe(404)
    })

    scenario("a request still waiting is shown again to a stream that attaches later, and not once it is answered", async (ctx) => {
      // A stream that dropped and re-attached missed the ask; the engine's only way to learn of it is the replay.
      const first = await ctx.listen()
      const request = `${ctx.run}-replay`
      await ctx.driver.script({ steps: [{ text: "done", ask: { kind: "permission", id: request, action: "bash", resource: "command: ls" } }] })
      const id = await ctx.open("replay", { permissions: "manual" })
      await ctx.api.prompt(id, "go")
      const [shown] = await first.waitFor((event) => event.type === "permission.v2.asked" && String(event.data?.id).endsWith(request))
      const published = String(shown?.data?.id)

      const second = await ctx.listen()
      const [replayed] = await second.waitFor((event) => event.type === "permission.v2.asked" && event.data?.id === published)
      expect(replayed?.data).toMatchObject({ sessionID: id, id: published, action: "bash" })

      await ctx.api.replyPermission(id, published, "once")
      await ctx.api.waitForIdle(id)
      const third = await ctx.listen()
      expect(third.events.filter((event) => event.data?.id === published)).toEqual([])
    })

    scenario("a stream that attaches after events went to nobody is told so, before the requests it is shown again", async (ctx) => {
      // Events published while nobody is attached are a gap: the next stream hears `flow.stream.reset`, and only then the asks still waiting.
      const request = `${ctx.run}-gap`
      await ctx.driver.script({ steps: [{ text: "done", ask: { kind: "permission", id: request, action: "bash", resource: "command: ls" } }] })
      const id = await ctx.open("gap", { permissions: "manual" })
      await ctx.api.prompt(id, "go")
      await eventually(async () => (await ctx.api.active()).includes(id), "the turn is running with nobody listening")

      const late = await ctx.listen()
      const [replayed] = await late.waitFor((event) => event.type === "permission.v2.asked" && String(event.data?.id).endsWith(request))
      const published = String(replayed?.data?.id)
      const kinds = late.events.map((event) => event.type)
      expect(kinds).toContain("flow.stream.reset")
      expect(kinds.indexOf("flow.stream.reset")).toBeLessThan(kinds.indexOf("permission.v2.asked"))

      await ctx.api.replyPermission(id, published, "once")
      await ctx.api.waitForIdle(id)
    })

    scenario("a free-text answer to a question is carried back as typed", async (ctx) => {
      const events = await ctx.listen()
      const request = `${ctx.run}-ask`
      await ctx.driver.script({ steps: [{ text: "noted", ask: { kind: "question", id: request, question: "Which database?", header: "Storage", options: ["sqlite"] } }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const published = await publicId(events, "question.v2.asked", id, request)
      await ctx.api.replyQuestion(id, published, [["use duckdb"]])
      await ctx.api.waitForIdle(id)
      expect(await ctx.driver.decision(request)).toEqual({ kind: "question", answers: [["use duckdb"]] })
    })

    scenario("a rejected question lets the agent carry on, and cannot be answered afterwards", async (ctx) => {
      const events = await ctx.listen()
      const request = `${ctx.run}-ask`
      await ctx.driver.script({ steps: [{ text: "on my own", ask: { kind: "question", id: request, question: "Which database?", header: "Storage", options: ["sqlite"] } }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const published = await publicId(events, "question.v2.asked", id, request)
      await ctx.api.rejectQuestion(id, published)
      await ctx.api.waitForIdle(id)
      expect(await ctx.driver.decision(request)).toEqual({ kind: "cancelled" })
      expect(await ctx.api.transcript(id)).toEqual({ text: "on my own" })
      expect(statusOf(await rejection(ctx.api.rejectQuestion(id, published)))).toBe(404)
      expect(statusOf(await rejection(ctx.api.replyQuestion(id, published, [["sqlite"]])))).toBe(404)
    })

    scenario("answers must match the questions one for one, and a refused reply leaves the question open", async (ctx) => {
      const events = await ctx.listen()
      const request = `${ctx.run}-ask`
      await ctx.driver.script({ steps: [{ text: "ok", ask: { kind: "question", id: request, question: "Which database?", header: "Storage", options: ["sqlite"] } }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const published = await publicId(events, "question.v2.asked", id, request)
      expect(statusOf(await rejection(ctx.api.replyQuestion(id, published, [["sqlite"], ["extra"]])))).toBe(400)
      await ctx.api.replyQuestion(id, published, [["sqlite"]])
      await ctx.api.waitForIdle(id)
      expect(await ctx.driver.decision(request)).toEqual({ kind: "question", answers: [["sqlite"]] })
    })

    scenario("a reply to a question nobody asked is a 404", async (ctx) => {
      const id = await ctx.open()
      expect(statusOf(await rejection(ctx.api.replyQuestion(id, "no-such-request", [["x"]])))).toBe(404)
      expect(statusOf(await rejection(ctx.api.rejectQuestion(id, "no-such-request")))).toBe(404)
    })

    /* -------------------------------------------------- interrupt and waiting */

    scenario("an interrupt nobody asked for makes waitForIdle throw: aborted is not an answer", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "working", hang: true }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      expect(await ctx.api.active()).toContain(id)

      const waiting = rejection(ctx.api.waitForIdle(id))
      await ctx.api.interrupt(id)
      expect(await waiting).toBeInstanceOf(Error)
      await eventually(async () => !(await ctx.api.active()).includes(id), "the interrupted session leaves the active set")
    })

    scenario("an interrupt the caller asked for, by aborting its own signal, ends the wait silently", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "working", hang: true }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")

      const stop = new AbortController()
      const waiting = ctx.api.waitForIdle(id, { signal: stop.signal })
      stop.abort()
      await ctx.api.interrupt(id)
      expect(await waiting).toBeUndefined()
    })

    scenario("an interrupt withdraws the requests that were open: they cannot be answered and the agent was told so", async (ctx) => {
      const events = await ctx.listen()
      const request = `${ctx.run}-perm`
      await ctx.driver.script({ steps: [{ text: "x", ask: { kind: "permission", id: request, action: "bash", resource: "command: ls" } }] })
      const id = await ctx.open("held", { permissions: "manual" })
      await ctx.api.prompt(id, "go")
      const published = await publicId(events, "permission.v2.asked", id, request)

      await ctx.api.interrupt(id)
      expect(statusOf(await rejection(ctx.api.replyPermission(id, published, "once")))).toBe(404)
      await eventually(async () => (await ctx.driver.decision(request))?.kind === "cancelled", "the agent is told the request was cancelled")
    })

    scenario("interrupt, release and releaseRun never throw for what is already gone", async (ctx) => {
      expect(await ctx.api.interrupt("no-such-session")).toBeUndefined()
      expect(await ctx.api.release("no-such-session")).toBeUndefined()
      expect(await ctx.api.releaseRun("no-such-run")).toBeUndefined()
    })

    scenario("aborting the wait's own signal ends the wait without stopping the turn", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "working", hang: true }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")

      const stop = new AbortController()
      const waiting = ctx.api.waitForIdle(id, { signal: stop.signal })
      stop.abort()
      expect(await waiting).toBeUndefined()
      expect(await ctx.api.active()).toContain(id)

      // A signal that is already aborted returns at once, with the turn still running.
      expect(await ctx.api.waitForIdle(id, { signal: AbortSignal.abort() })).toBeUndefined()
      expect(await ctx.api.active()).toContain(id)
      await ctx.api.interrupt(id)
    })

    scenario("waitForIdle re-polls in slices and returns only when the turn has really finished", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "slow answer", delayMs: 500 }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      // A slice a fraction of the turn: every request but the last comes back "still running".
      await ctx.api.waitForIdle(id, { slice: 80 })
      expect(await ctx.api.transcript(id)).toEqual({ text: "slow answer" })
      expect(await ctx.api.active()).not.toContain(id)
    })

    scenario("waitForIdle throws when its own timeout passes first, and the turn goes on", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "slow answer", delayMs: 800 }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const error = await rejection(ctx.api.waitForIdle(id, { timeout: 150, slice: 60 }))
      expect(messageOf(error)).toMatch(/timed out/i)
      expect(await ctx.api.active()).toContain(id)

      await ctx.api.waitForIdle(id)
      expect(await ctx.api.transcript(id)).toEqual({ text: "slow answer" })
    })

    /* ------------------------------------------------------------- failures */

    scenario("a provider error settles as an error result carrying the text and the HTTP status", async (ctx) => {
      const events = await ctx.listen()
      await ctx.driver.script({ steps: [], error: { message: "overloaded", status: 429 } })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")

      const thrown = await rejection(ctx.api.waitForIdle(id))
      // The engine classifies rate limits and transient failures by regex on this text.
      expect(messageOf(thrown)).toContain("overloaded")
      expect(messageOf(thrown)).toMatch(/HTTP 429/)

      const final = await ctx.api.transcript(id)
      expect(final.error).toContain("overloaded")
      expect(final.error).toMatch(/HTTP 429/)

      const [failed] = await events.waitFor((event) => event.type === "session.next.step.failed" && event.data?.sessionID === id)
      expect(String(failed?.data?.error)).toContain("overloaded")
    })

    scenario("a provider error without a status still carries its text", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "partial" }], error: { message: "model not found" } })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      expect(messageOf(await rejection(ctx.api.waitForIdle(id)))).toContain("model not found")
      expect((await ctx.api.transcript(id)).error).toContain("model not found")
    })

    /* ------------------------------------------------------------- sessions */

    scenario("an unknown session reports missing: waiting throws naming it, reads and prompts are 404", async (ctx) => {
      const id = "s_no_such_session"
      expect(messageOf(await rejection(ctx.api.waitForIdle(id)))).toContain(id)
      for (const call of [
        () => ctx.api.prompt(id, "hello"),
        () => ctx.api.transcript(id),
        () => ctx.api.sessionTranscript(id),
        () => ctx.api.sessionSteps(id),
        () => ctx.api.sessionCalls(id),
      ]) {
        expect(statusOf(await rejection(call()))).toBe(404)
      }
    })

    scenario("release disposes one session: it leaves the live and active sets and every read of it is a 404", async (ctx) => {
      const before = (await ctx.api.health()).sessions.live
      await ctx.driver.script({ steps: [{ text: "working", hang: true }] })
      const doomed = await ctx.open()
      const kept = await ctx.open()
      await ctx.api.prompt(doomed, "go")
      expect(await ctx.api.active()).toContain(doomed)
      expect((await ctx.api.health()).sessions.live).toBe(before + 2)

      await ctx.api.release(doomed)
      expect(await ctx.api.active()).not.toContain(doomed)
      expect((await ctx.api.health()).sessions.live).toBe(before + 1)
      expect(messageOf(await rejection(ctx.api.waitForIdle(doomed)))).toContain(doomed)
      expect(statusOf(await rejection(ctx.api.transcript(doomed)))).toBe(404)

      // The others are untouched, and what is active is something the engine can list.
      expect(await ctx.api.waitForIdle(kept)).toBeUndefined()
      const listed = (await ctx.api.sessions()).map((row) => row.id)
      expect(listed).toContain(kept)
      for (const id of await ctx.api.active()) expect(listed).toContain(id)
    })

    scenario("a wait parked on a session that is released ends in an error, not in a result", async (ctx) => {
      await ctx.driver.script({ steps: [{ text: "working", hang: true }] })
      const id = await ctx.open()
      await ctx.api.prompt(id, "go")
      const waiting = rejection(ctx.api.waitForIdle(id))
      await ctx.api.release(id)
      expect(messageOf(await waiting)).toContain(id)
    })

    scenario("releaseRun disposes every session of the run and none of another", async (ctx) => {
      const other = ctx.newRun()
      const before = (await ctx.api.health()).sessions.live
      const a = await ctx.open("a")
      const b = await ctx.open("b")
      const c = await ctx.open("c", {}, other)
      expect((await ctx.api.health()).sessions.live).toBe(before + 3)

      await ctx.api.releaseRun(ctx.run)
      expect((await ctx.api.health()).sessions.live).toBe(before + 1)
      for (const gone of [a, b]) expect(statusOf(await rejection(ctx.api.transcript(gone)))).toBe(404)
      expect(await ctx.api.transcript(c)).toEqual({ text: "" })
      expect(await ctx.api.waitForIdle(c)).toBeUndefined()
    })

    scenario("opening a card's session again replaces the earlier one", async (ctx) => {
      const before = (await ctx.api.health()).sessions.live
      const first = await ctx.open("critic")
      const second = await ctx.open("critic")
      expect(second).not.toBe(first)
      expect(statusOf(await rejection(ctx.api.transcript(first)))).toBe(404)
      expect(await ctx.api.transcript(second)).toEqual({ text: "" })
      expect((await ctx.api.health()).sessions.live).toBe(before + 1)
    })

    scenario("reuse re-attaches to the open session: same id, no second session, still promptable", async (ctx) => {
      const id = await ctx.open("resumed")
      const before = (await ctx.api.health()).sessions.live
      const again = await ctx.api.createSession(ctx.input("resumed", { reuse: id }))
      expect(again.id).toBe(id)
      expect((await ctx.api.health()).sessions.live).toBe(before)

      await ctx.driver.script({ steps: [{ text: "still here" }] })
      await ctx.api.prompt(again.id, "go")
      await ctx.api.waitForIdle(again.id)
      expect(await ctx.api.transcript(id)).toEqual({ text: "still here" })
    })

    scenario("reusing a session that does not exist is a 404, not a fresh session", async (ctx) => {
      const before = (await ctx.api.health()).sessions.live
      expect(statusOf(await rejection(ctx.api.createSession(ctx.input("ghost", { reuse: "s_no_such_session" }))))).toBe(404)
      expect((await ctx.api.health()).sessions.live).toBe(before)
    })

    scenario("a malformed create is refused with a 400 and starts nothing", async (ctx) => {
      const before = (await ctx.api.health()).sessions.live
      const bad = [
        ctx.input("m1", { model: "no-slash" }),
        ctx.input("m2", { card: { key: "", role: "Builder" } }),
        ctx.input("m3", { runId: "" }),
        ctx.input("", {}),
      ]
      for (const request of bad) expect(statusOf(await rejection(ctx.api.createSession(request)))).toBe(400)
      expect((await ctx.api.health()).sessions.live).toBe(before)
    })

    heldScenario("a create abandoned while its session is still starting rejects with the abort and leaves nothing behind", async (ctx) => {
      const hold = ctx.driver.holdStartup?.()
      if (!hold) throw new Error("the leg declared holdsStartup but its driver cannot hold a startup")
      const before = (await ctx.api.health()).sessions.live
      try {
        const controller = new AbortController()
        const pending = rejection(ctx.api.createSession(ctx.input("abandoned"), controller.signal))
        await hold.reached()
        controller.abort()
        const error = await pending
        // The abort itself, not a failure the engine could mistake for a down host or a refused create.
        expect((error as Error).name).toBe("AbortError")
        expect(statusOf(error)).toBeUndefined()
      } finally {
        hold.release()
      }
      await eventually(async () => (await ctx.api.health()).sessions.live === before, "the abandoned start is not live")
      expect((await ctx.api.sessions()).filter((row) => row.agent === "card-abandoned")).toEqual([])

      // Nothing is wedged: the same card opens a session normally afterwards.
      const id = await ctx.open("abandoned")
      expect((await ctx.api.health()).sessions.live).toBe(before + 1)
      expect(await ctx.api.transcript(id)).toEqual({ text: "" })
    })

    scenario("a create signal that is already aborted never starts a session", async (ctx) => {
      const before = (await ctx.api.health()).sessions.live
      const controller = new AbortController()
      controller.abort()
      const error = await rejection(ctx.api.createSession(ctx.input("never"), controller.signal))
      expect((error as Error).name).toBe("AbortError")
      expect((await ctx.api.health()).sessions.live).toBe(before)
    })

    scenario("the title given at create is the one the session list shows, before and after the first prompt", async (ctx) => {
      const title = "Builder · wire the parser"
      const id = await ctx.open("titled", { title })
      const listed = async () => (await ctx.api.sessions()).find((row) => row.id === id)?.title
      expect(await listed()).toBe(title)
      await ctx.api.prompt(id, "an unrelated first prompt")
      await ctx.api.waitForIdle(id)
      expect(await listed()).toBe(title)
    })

    scenario("a transient session is never listed and leaves no readable history once released", async (ctx) => {
      const id = await ctx.open("probe", { transient: true })
      await ctx.api.prompt(id, "Reply with the single word ok.")
      await ctx.api.waitForIdle(id)
      expect((await ctx.api.transcript(id)).text).toBeTruthy()
      expect((await ctx.api.sessions()).map((row) => row.id)).not.toContain(id)

      await ctx.api.release(id)
      expect(statusOf(await rejection(ctx.api.transcript(id)))).toBe(404)
      expect((await ctx.api.sessions()).map((row) => row.id)).not.toContain(id)
    })

    scenario("the session list is newest first, carries card and model, and honours the limit", async (ctx) => {
      const a = await ctx.open("listed-a")
      const b = await ctx.open("listed-b")
      await Bun.sleep(5)
      await ctx.api.prompt(a, "build the thing")
      await ctx.api.waitForIdle(a)

      const rows = await ctx.api.sessions()
      const ours = rows.filter((row) => row.id === a || row.id === b)
      expect(ours.map((row) => row.id)).toEqual([a, b])
      const row = ours[0] as SessionRow
      expect(row.agent).toBe("card-listed-a")
      expect(row.model).toBe(ctx.model)
      expect(row.title.length).toBeGreaterThan(0)
      expect(row.created).toBeLessThanOrEqual(row.updated)
      expect(await ctx.api.sessions(1)).toHaveLength(1)
    })

    scenario("events of one session never reach another session's filter", async (ctx) => {
      const events = await ctx.listen()
      const alpha: TurnScript = {
        steps: [{ text: "alpha-answer", delayMs: 100, tools: [{ id: "call-alpha", name: "bash", input: { command: "echo alpha" }, output: "alpha-out" }] }, { text: "alpha-done" }],
      }
      const beta: TurnScript = {
        steps: [{ text: "beta-answer", delayMs: 100, tools: [{ id: "call-beta", name: "read", input: { path: "beta.txt" }, output: "beta-out" }] }, { text: "beta-done" }],
      }
      const a = await ctx.open("alpha")
      const b = await ctx.open("beta")
      // Both turns are in flight together.
      await ctx.driver.script(alpha)
      await ctx.api.prompt(a, "go")
      await ctx.driver.script(beta)
      await ctx.api.prompt(b, "go")
      await Promise.all([ctx.api.waitForIdle(a), ctx.api.waitForIdle(b)])
      await events.waitFor((event) => event.type === "session.next.tool.success" && event.data?.sessionID === a)
      await events.waitFor((event) => event.type === "session.next.tool.success" && event.data?.sessionID === b)

      const mine = events.of(a)
      const theirs = events.of(b)
      expect(mine.length).toBeGreaterThan(0)
      expect(theirs.length).toBeGreaterThan(0)
      expect(JSON.stringify(mine)).not.toContain("beta")
      expect(JSON.stringify(theirs)).not.toContain("alpha")
      // An event with no session cannot be attributed to a card at all.
      expect(events.events.filter((event) => event.type.startsWith("session.next.") && typeof event.data?.sessionID !== "string")).toEqual([])

      expect(await ctx.api.transcript(a)).toEqual({ text: "alpha-done" })
      expect(await ctx.api.transcript(b)).toEqual({ text: "beta-done" })
      expect((await ctx.api.sessionCalls(a)).map((call) => call.id)).toEqual(["call-alpha"])
      expect((await ctx.api.sessionCalls(b)).map((call) => call.id)).toEqual(["call-beta"])
      expect(await ctx.api.sessionSteps(a)).toHaveLength(2)
      expect(await ctx.api.sessionSteps(b)).toHaveLength(2)
    })

    /* ---------------------------------------------------------------- close */

    test(
      "closing the engine leaves nothing running",
      async () => {
        const instance = await created.promise
        await instance.close()
        expect(await instance.leftovers()).toEqual([])
      },
      SCENARIO_MS,
    )
  })
}

/* ----------------------------------------------------------------- listener */

async function listenTo(ctx: Context): Promise<Listener> {
  const events: BusEvent[] = []
  const waiters: Array<{ match: (event: BusEvent) => boolean; count: number; resolve: (found: BusEvent[]) => void }> = []
  const abort = new AbortController()
  const stream = ctx.api
    .subscribe((event) => {
      events.push(event)
      for (const waiter of [...waiters]) {
        const found = events.filter(waiter.match)
        if (found.length < waiter.count) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(found.slice(0, waiter.count))
      }
    }, abort.signal)
    .catch(() => undefined)

  const listener: Listener = {
    events,
    of: (sessionID) => events.filter((event) => event.data?.sessionID === sessionID),
    waitFor(match, count = 1) {
      const found = events.filter(match)
      if (found.length >= count) return Promise.resolve(found.slice(0, count))
      const box = Promise.withResolvers<BusEvent[]>()
      const timer = setTimeout(() => box.reject(new Error("the expected event never arrived")), EVENT_MS)
      waiters.push({
        match,
        count,
        resolve(result) {
          clearTimeout(timer)
          box.resolve(result)
        },
      })
      return box.promise
    },
    async stop() {
      abort.abort()
      await stream
    },
  }

  // The stream has no replay and `subscribe` does not say when it is attached: turns of a throwaway session
  // are run until one of its events shows up, which proves the stream is live.
  const probe = await ctx.open("probe")
  await ctx.driver.script({ steps: [{ text: "probe" }] })
  const deadline = Date.now() + EVENT_MS
  while (listener.of(probe).length === 0) {
    if (Date.now() > deadline) throw new Error("the event stream never delivered a probe event")
    await ctx.api.prompt(probe, "probe")
    await ctx.api.waitForIdle(probe)
    await Bun.sleep(25)
  }
  await ctx.api.release(probe)
  await ctx.driver.script(ANSWERED)
  return listener
}
