import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PTY_CLOSE, PTY_LIMITS } from "../../shared/terminal"
import { HttpError } from "../host/respond"
import { TerminalHost } from "./host"
import type { HostTuning } from "./host"
import { defaultSpawn } from "./index"
import { alive, cleanScratch, collector, firstCursor, goneWithin, scratch, stub } from "./test-harness"

/**
 * Real PTYs: every test runs a stub script under a real `/bin/sh` on a real
 * pseudo-terminal through `@lydell/node-pty`. The parts that break are process
 * groups, hangups and cursors, and none of them show up against a fake.
 */

const hosts: TerminalHost[] = []

function host(tuning: Partial<HostTuning> = {}) {
  const made = new TerminalHost(defaultSpawn, tuning)
  hosts.push(made)
  return made
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((made) => made.dispose()))
  await cleanScratch()
})

const SIZE = { cols: 100, rows: 30 }

describe("sessions", () => {
  test("create, echo, and the exit code arrives as a control frame", async () => {
    const dir = await scratch()
    const terminals = host()
    const info = await terminals.create("shell", await stub(dir, "read x; echo got:$x; stty size; exit 3"), SIZE)
    expect(info).toMatchObject({ kind: "shell", state: "running", cols: 100, rows: 30 })
    expect(info.pid).toBeGreaterThan(1)

    const sink = collector()
    const connection = terminals.attach(info.id, sink)!
    expect(sink.controls[0]).toEqual({ cursor: 0 })
    connection.message("hello\n")
    const done = await terminals.whenExited(info.id)!

    expect(done).toMatchObject({ state: "exited", exit: { code: 3, signal: null } })
    expect(sink.output).toContain("got:hello")
    expect(sink.output).toContain("30 100")
    expect(sink.controls.at(-1)).toEqual({ exit: { code: 3, signal: null } })
    expect(sink.closed).toEqual({ code: PTY_CLOSE.normal, reason: "exited" })
    expect(await goneWithin(info.pid!)).toBe(true)
  })

  test("an exited session still replays its output and reports its exit", async () => {
    const dir = await scratch()
    const terminals = host()
    const info = await terminals.create("shell", await stub(dir, "echo final-words; exit 1"), SIZE)
    await terminals.whenExited(info.id)

    const sink = collector()
    terminals.attach(info.id, sink)
    expect(sink.output).toContain("final-words")
    expect(sink.controls.at(-1)).toEqual({ exit: { code: 1, signal: null } })
    expect(sink.closed?.code).toBe(PTY_CLOSE.normal)
    expect(terminals.list()).toHaveLength(1)
    expect(terminals.list()[0]).toMatchObject({ state: "exited", exit: { code: 1 } })
  })

  test("a resize control frame reaches the pty, clamped", async () => {
    const dir = await scratch()
    const terminals = host()
    const info = await terminals.create("shell", await stub(dir, "stty size; read x; stty size; read y; stty size; exit 0"), SIZE)
    const sink = collector()
    const connection = terminals.attach(info.id, sink)!
    await sink.until(() => sink.output.includes("30 100"), "initial size")

    const resize = (cols: number, rows: number) =>
      connection.message(Uint8Array.from([0, ...Buffer.from(JSON.stringify({ t: "resize", cols, rows }))]))
    resize(120, 40)
    connection.message("\n")
    await sink.until(() => sink.output.includes("40 120"), "resized to 40 120")

    resize(9999, 1)
    connection.message("\n")
    await terminals.whenExited(info.id)
    expect(sink.output).toContain(`${PTY_LIMITS.minRows} ${PTY_LIMITS.maxCols}`)
    expect(terminals.list()[0]).toMatchObject({ cols: PTY_LIMITS.maxCols, rows: PTY_LIMITS.minRows })
  })

  test("restart is a new create: new id, new pid", async () => {
    const dir = await scratch()
    const terminals = host()
    const plan = await stub(dir, "exit 0")
    const first = await terminals.create("shell", plan, SIZE)
    await terminals.whenExited(first.id)
    const second = await terminals.create("shell", plan, SIZE)
    expect(second.id).not.toBe(first.id)
    expect(second.pid).not.toBe(first.pid)
    await terminals.whenExited(second.id)
  })

  test("ignores malformed, oversize and wrong-kind client frames and keeps the session", async () => {
    const dir = await scratch()
    const terminals = host()
    const info = await terminals.create("shell", await stub(dir, "read x; echo got:$x; exit 0"), SIZE)
    const sink = collector()
    const connection = terminals.attach(info.id, sink)!
    connection.message("a".repeat(PTY_LIMITS.inputFrameBytes + 1))
    connection.message(Uint8Array.from([1, 2, 3]))
    connection.message(Uint8Array.from([0, ...Buffer.from("not json")]))
    connection.message(Uint8Array.from([0, ...Buffer.from(JSON.stringify({ t: "kill" }))]))
    connection.message("ok\n")
    await terminals.whenExited(info.id)
    expect(sink.output).toContain("got:ok")
    expect(sink.output).not.toContain("got:aaa")
  })
})

describe("scrollback", () => {
  test("a ring of 2 MiB keeps the tail of 3 MB of output, with a monotonic cursor", async () => {
    const dir = await scratch()
    const terminals = host()
    const info = await terminals.create(
      "shell",
      await stub(dir, "head -c 3000000 /dev/zero | tr '\\000' 'a'; echo; echo THE-END; exit 0"),
      SIZE,
    )
    await terminals.whenExited(info.id)

    const first = collector()
    terminals.attach(info.id, first)
    const total = firstCursor(first)
    expect(total).toBeGreaterThan(3_000_000)
    expect(first.output.length).toBe(PTY_LIMITS.ringBytes)
    expect(first.output.endsWith("THE-END\r\n")).toBe(true)

    // Resuming from the end replays nothing; from ten units back replays exactly those.
    const tail = collector()
    terminals.attach(info.id, tail, total - 10)
    expect(tail.output).toBe(first.output.slice(-10))
    expect(tail.controls[0]).toEqual({ cursor: total })

    const none = collector()
    terminals.attach(info.id, none, -1)
    expect(none.output).toBe("")

    const cursors = [first, tail, none].map(firstCursor)
    expect(cursors).toEqual([total, total, total])
  })

  test("reconnecting from a cursor receives exactly what was produced while away", async () => {
    const dir = await scratch()
    const terminals = host()
    const go = path.join(dir, "go")
    const info = await terminals.create(
      "shell",
      await stub(dir, `echo part-one; while [ ! -e ${go} ]; do sleep 0.02; done; echo part-two; exit 0`),
      SIZE,
    )
    const before = collector()
    const connection = terminals.attach(info.id, before)!
    await before.until(() => before.output.includes("part-one"), "part-one")
    const cursor = before.resume()
    connection.detach()

    await fs.writeFile(go, "")
    await terminals.whenExited(info.id)

    const after = collector()
    terminals.attach(info.id, after, cursor)
    expect(before.output + after.output).toBe("part-one\r\npart-two\r\n")
    expect(after.output).toBe("part-two\r\n")
  })

  test("a client that cannot keep up is closed and resumes from its cursor", async () => {
    const dir = await scratch()
    const terminals = host()
    const go = path.join(dir, "go")
    const info = await terminals.create(
      "shell",
      await stub(dir, `echo part-one; while [ ! -e ${go} ]; do sleep 0.02; done; echo part-two; exit 0`),
      SIZE,
    )
    const slow = collector()
    terminals.attach(info.id, slow)
    await slow.until(() => slow.output.includes("part-one"), "part-one")
    const cursor = slow.resume()
    slow.queued = 5 * 1024 * 1024

    await fs.writeFile(go, "")
    await slow.until(() => slow.closed !== undefined, "slow sink closed")
    expect(slow.closed?.code).toBe(1013)
    expect(slow.output).not.toContain("part-two")

    await terminals.whenExited(info.id)
    const resumed = collector()
    terminals.attach(info.id, resumed, cursor)
    expect(resumed.output).toBe("part-two\r\n")
  })
})

describe("no orphans", () => {
  /** A backgrounded grandchild whose pid the stub prints; `body` decides what the leader does next. */
  async function withGrandchild(terminals: TerminalHost, body: string) {
    const dir = await scratch()
    const info = await terminals.create("shell", await stub(dir, `${body}`), SIZE)
    const sink = collector()
    terminals.attach(info.id, sink)
    await sink.until(() => /CHILD:\d+/.test(sink.output), "grandchild pid")
    return { info, grandchild: Number(/CHILD:(\d+)/.exec(sink.output)![1]) }
  }

  test("kill takes the shell and the process it backgrounded", async () => {
    const terminals = host()
    const { info, grandchild } = await withGrandchild(terminals, "sleep 300 & echo CHILD:$!; wait")
    expect(alive(grandchild)).toBe(true)

    const exited = terminals.whenExited(info.id)!
    expect(terminals.kill(info.id)).toBe(true)
    await exited
    expect(await goneWithin(grandchild)).toBe(true)
    expect(await goneWithin(info.pid!)).toBe(true)
    expect(terminals.info(info.id)).toBeUndefined()
    expect(terminals.kill(info.id)).toBe(false)
  })

  test("a leader that ignores the hangup is killed after the grace period, with its group", async () => {
    const terminals = host({ killGraceMs: 200 })
    const { info, grandchild } = await withGrandchild(
      terminals,
      "trap '' HUP; (trap '' HUP; exec sleep 300) & echo CHILD:$!; while :; do sleep 0.1; done",
    )
    const exited = terminals.whenExited(info.id)!
    terminals.kill(info.id)
    const done = await exited
    expect(done.exit?.signal === "SIGKILL" || done.exit?.code !== 0).toBe(true)
    expect(await goneWithin(grandchild)).toBe(true)
    expect(await goneWithin(info.pid!)).toBe(true)
  })

  test("dispose kills every session, refuses new ones, and is idempotent", async () => {
    const terminals = host()
    const a = await withGrandchild(terminals, "sleep 300 & echo CHILD:$!; wait")
    const b = await withGrandchild(terminals, "sleep 300 & echo CHILD:$!; wait")

    await terminals.dispose()
    for (const pid of [a.grandchild, a.info.pid!, b.grandchild, b.info.pid!]) expect(await goneWithin(pid)).toBe(true)

    const dir = await scratch()
    await expect(terminals.create("shell", await stub(dir, "exit 0"), SIZE)).rejects.toThrow(HttpError)
    await terminals.dispose()
  })

  test("host-exit hooks are installed with the first session and removed by dispose", async () => {
    const before = process.listenerCount("exit")
    const terminals = host()
    expect(process.listenerCount("exit")).toBe(before)
    const dir = await scratch()
    await terminals.create("shell", await stub(dir, "exit 0"), SIZE)
    expect(process.listenerCount("exit")).toBe(before + 1)
    await terminals.dispose()
    expect(process.listenerCount("exit")).toBe(before)
  })
})

describe("limits", () => {
  test("the fifth live session is refused; an exited one does not count", async () => {
    const dir = await scratch()
    const terminals = host()
    const plan = await stub(dir, "read x")
    const live = []
    for (let i = 0; i < PTY_LIMITS.maxSessions; i++) live.push(await terminals.create("shell", plan, SIZE))
    const refused = await terminals.create("shell", plan, SIZE).catch((error) => error)
    expect(refused).toBeInstanceOf(HttpError)
    expect(refused).toMatchObject({ status: 429, code: "limit" })

    const exited = terminals.whenExited(live[0]!.id)!
    const connection = terminals.attach(live[0]!.id, collector())!
    connection.message("\n")
    await exited
    const replacement = await terminals.create("shell", plan, SIZE)
    expect(replacement.state).toBe("running")
  })

  test("concurrent creates cannot overshoot the limit", async () => {
    const dir = await scratch()
    const terminals = host({ maxSessions: 2 })
    const plan = await stub(dir, "read x")
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => terminals.create("shell", plan, SIZE)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2)
  })

  test("only the newest exited sessions are kept", async () => {
    const dir = await scratch()
    const terminals = host({ exitedKept: 2 })
    const plan = await stub(dir, "exit 0")
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const info = await terminals.create("shell", plan, SIZE)
      ids.push(info.id)
      await terminals.whenExited(info.id)
    }
    expect(terminals.list().map((session) => session.id)).toEqual(ids.slice(-2))
  })

  test("spawn failure is an HttpError that names the problem and no environment", async () => {
    const dir = await scratch()
    const failing = new TerminalHost(async () => {
      throw new Error("File not found: nope")
    })
    hosts.push(failing)
    const plan = { ...(await stub(dir, "")), env: { SECRET_VALUE: "dummy-secret" } }
    const error = await failing.create("shell", plan, SIZE).catch((caught) => caught)
    expect(error).toMatchObject({ status: 500, code: "spawn-failed" })
    expect(String(error.message)).toContain("File not found")
    expect(String(error.message)).not.toContain("dummy-secret")
  })
})

describe("idle reaper", () => {
  test("a running session nobody is attached to is killed", async () => {
    const dir = await scratch()
    const terminals = host({ idleReapMs: 50 })
    const info = await terminals.create("shell", await stub(dir, "read x"), SIZE)
    const exited = terminals.whenExited(info.id)!
    const done = await exited
    expect(done.state).toBe("exited")
    expect(terminals.info(info.id)).toBeUndefined()
    expect(await goneWithin(info.pid!)).toBe(true)
  })

  test("detaching starts the clock again; attached sessions are left alone", async () => {
    const dir = await scratch()
    const terminals = host({ idleReapMs: 150 })
    const info = await terminals.create("shell", await stub(dir, "read x"), SIZE)
    const connection = terminals.attach(info.id, collector())!
    // Absence of a kill cannot be awaited: wait out three idle periods, then look.
    await Bun.sleep(450)
    expect(terminals.info(info.id)?.state).toBe("running")

    const exited = terminals.whenExited(info.id)!
    connection.detach()
    await exited
    expect(terminals.info(info.id)).toBeUndefined()
  })
})
