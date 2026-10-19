import { describe, expect, test } from "bun:test"
import type { BusEvent, CreateSession } from "../../../shared/engine"
import { EMPTY_SWARM_COUNTS } from "../../../shared/swarm"
import { createFakeEngine, type FakeEngine } from "./fake-engine"

/** What only the fake offers: the scripting the contract suite cannot ask of the real adapter, and the call record. */

const input = (node: string, runId = "run-1"): CreateSession => ({ runId, nodeId: node, card: { key: `card-${node}`, role: "Builder" }, model: "fake/model-0", permissions: "manual" })

function watch(engine: FakeEngine) {
  const events: BusEvent[] = []
  const stop = new AbortController()
  const stream = engine.subscribe((event) => events.push(event), stop.signal)
  return { events, stream, stop: () => stop.abort() }
}

describe("fake engine driver", () => {
  test("queued turns play in order per session, then the default answer", async () => {
    const engine = createFakeEngine({ answer: "default" })
    const a = (await engine.createSession(input("a"))).id
    const b = (await engine.createSession(input("b"))).id
    engine.driver.answer(a, "first")
    engine.driver.answer(a, "second")

    const answers: string[] = []
    for (const id of [a, a, a, b]) {
      await engine.prompt(id, "go")
      await engine.waitForIdle(id)
      answers.push((await engine.transcript(id)).text)
    }
    expect(answers).toEqual(["first", "second", "default", "default"])
  })

  test("callTool, askPermission and fail script one turn each", async () => {
    const engine = createFakeEngine()
    const id = (await engine.createSession(input("a"))).id
    const seen = watch(engine)

    engine.driver.callTool(id, { id: "t1", name: "bash", input: { command: "ls" }, output: "a.txt" }, "listed")
    await engine.prompt(id, "go")
    await engine.waitForIdle(id)
    expect(await engine.sessionCalls(id)).toEqual([{ id: "t1", name: "bash", input: { command: "ls" } }])
    expect(await engine.transcript(id)).toEqual({ text: "listed" })

    engine.driver.askPermission(id, { id: "p1", action: "edit", resource: "path: a.txt" }, "edited")
    await engine.prompt(id, "go")
    expect(engine.driver.open(id)).toEqual([{ kind: "permission", sessionID: id, id: "p1" }])
    await engine.replyPermission(id, "p1", "always")
    await engine.waitForIdle(id)
    expect(engine.driver.open(id)).toEqual([])
    expect(await engine.driver.decision("p1")).toEqual({ kind: "permission", reply: "always" })

    engine.driver.fail(id, "slow down", 429)
    await engine.prompt(id, "go")
    await expect(engine.waitForIdle(id)).rejects.toThrow(/HTTP 429.*slow down/)
    seen.stop()
    await seen.stream
  })

  test("a hung turn stays active until released, and then finishes normally", async () => {
    const engine = createFakeEngine()
    const id = (await engine.createSession(input("a"))).id
    engine.driver.hang(id)
    await engine.prompt(id, "go")
    expect(await engine.active()).toEqual([id])
    await expect(engine.waitForIdle(id, { timeout: 30 })).rejects.toThrow(/timed out/)

    engine.driver.release(id)
    await engine.waitForIdle(id)
    expect(await engine.active()).toEqual([])
  })

  test("notice, swarm and lose emit the events no turn produces, and a lost session reads as missing", async () => {
    const engine = createFakeEngine()
    const id = (await engine.createSession(input("a"))).id
    const seen = watch(engine)

    engine.driver.notice(undefined, "info", "host started")
    engine.driver.swarm(id, { mode: "auto", active: true, counts: { ...EMPTY_SWARM_COUNTS, running: 1 }, agents: [], updatedAt: 1 })
    engine.driver.lose(id, "the process exited")
    seen.stop()
    await seen.stream

    expect(seen.events.map((event) => event.type)).toEqual(["flow.notice", "flow.swarm.status", "flow.session.lost"])
    expect(seen.events[0]?.data).toEqual({ level: "info", message: "host started" })
    expect(seen.events[2]?.data).toEqual({ sessionID: id, reason: "the process exited" })
    await expect(engine.waitForIdle(id)).rejects.toThrow(id)
  })

  test("every call is recorded with its arguments, in order, even when it fails", async () => {
    const engine = createFakeEngine()
    const id = (await engine.createSession(input("a"))).id
    await engine.prompt(id, "build it", [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }])
    await engine.waitForIdle(id)
    await engine.replyPermission(id, "nope", "once").catch(() => undefined)
    await engine.release(id)

    expect(engine.recorded.map((entry) => entry.method)).toEqual(["createSession", "prompt", "waitForIdle", "replyPermission", "release"])
    expect(engine.recordedOf("prompt")).toEqual([{ method: "prompt", sessionID: id, args: ["build it", [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }]] }])
    expect(engine.recordedOf("replyPermission")[0]?.args).toEqual(["nope", "once"])
  })

  test("dropStreams rejects every subscription as a dropped connection does, and close ends the others", async () => {
    const engine = createFakeEngine()
    const dropped = engine.subscribe(() => undefined, new AbortController().signal).catch((error: unknown) => error)
    engine.driver.dropStreams(new Error("connection reset"))
    expect(await dropped).toEqual(new Error("connection reset"))

    const kept = engine.subscribe(() => undefined, new AbortController().signal)
    await engine.close()
    await expect(kept).resolves.toBeUndefined()
  })
})

test("two engines share nothing", async () => {
  const one = createFakeEngine()
  const two = createFakeEngine()
  const id = (await one.createSession(input("a"))).id
  expect((await two.health()).sessions.live).toBe(0)
  await expect(two.transcript(id)).rejects.toThrow(id)
})
