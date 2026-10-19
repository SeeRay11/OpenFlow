import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import type { UpliftRequest } from "../../shared/uplift"
import { plannerEnv } from "./planner"
import { alive, createHarness, until, type Harness } from "./testing/stub-planner"

/**
 * The planner pool runs real child processes (the stub planner), because the
 * parts that break are process-group kills, pipe handling and queueing, and
 * none of them shows up against a fake.
 */

const harnesses: Harness[] = []
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

function request(original: string, nodeId = "n1", extra: Partial<UpliftRequest> = {}): UpliftRequest {
  return { runId: "run1", nodeId, original, ...extra }
}

/** A loopback server the stub planners check in with; each stays blocked until the test releases it. */
function gate() {
  const arrivals: string[] = []
  const waiting = new Map<string, () => void>()
  const arrived = new Map<string, PromiseWithResolvers<void>>()
  const counting: Array<{ n: number; resolve: () => void }> = []
  let active = 0
  let peak = 0
  const server = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const sid = new URL(incoming.url).pathname.split("/").pop()!
      const release = Promise.withResolvers<void>()
      waiting.set(sid, release.resolve)
      arrivals.push(sid)
      active++
      peak = Math.max(peak, active)
      arrived.get(sid)?.resolve()
      for (const waiter of counting) if (arrivals.length >= waiter.n) waiter.resolve()
      await release.promise
      active--
      return new Response("go")
    },
  })
  servers.push(server)
  return {
    port: server.port,
    arrivals,
    peak: () => peak,
    arrival(sid: string) {
      const existing = arrived.get(sid) ?? Promise.withResolvers<void>()
      arrived.set(sid, existing)
      if (arrivals.includes(sid)) existing.resolve()
      return existing.promise
    },
    /** Resolves once `n` planners have checked in, whichever they are: start order is not arrival order. */
    count(n: number) {
      const counted = Promise.withResolvers<void>()
      counting.push({ n, resolve: counted.resolve })
      if (arrivals.length >= n) counted.resolve()
      return counted.promise
    },
    release(sid: string) {
      waiting.get(sid)?.()
    },
  }
}

describe("plannerEnv", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/u",
    LC_ALL: "C",
    XDG_CONFIG_HOME: "/cfg",
    CLAUDE_CONFIG_DIR: "/claude",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    OPENROUTER_API_KEY: "dummy-openrouter",
    AI_GATEWAY_API_KEY: "dummy-gateway",
    HTTPS_PROXY: "http://proxy",
    SUBSTRATE_URL: "http://127.0.0.1:7410",
    SUBSTRATE_TOKEN: "dummy-substrate",
    SWARM_ED25519_KEY: "dummy-swarm",
    GITHUB_TOKEN: "dummy-github",
    ULTRATHINK_DEBUG: "1",
    ULTRATHINK_UPLIFT: "0",
    ULTRATHINK_CHILD: "1",
    ULTRATHINK_HOST: "omp",
    UNRELATED: "x",
  }

  test("passes the allowlist and nothing else", () => {
    const env = plannerEnv(base, DEFAULT_OMP_SETTINGS, "/state/uplift")
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/cfg",
      CLAUDE_CONFIG_DIR: "/claude",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      OPENROUTER_API_KEY: "dummy-openrouter",
      AI_GATEWAY_API_KEY: "dummy-gateway",
      HTTPS_PROXY: "http://proxy",
    })
    for (const name of ["SWARM_ED25519_KEY", "GITHUB_TOKEN", "ULTRATHINK_DEBUG", "ULTRATHINK_UPLIFT", "ULTRATHINK_CHILD", "ULTRATHINK_HOST", "UNRELATED"]) {
      expect(env[name]).toBeUndefined()
    }
  })

  test("turns off everything that writes elsewhere and points the planner at its own state", () => {
    const env = plannerEnv(base, DEFAULT_OMP_SETTINGS, "/state/uplift")
    expect(env).toMatchObject({
      ULTRATHINK_STATE_DIR: "/state/uplift",
      ULTRATHINK_TRACK: "0",
      ULTRATHINK_SHIP: "0",
      ULTRATHINK_HINDSIGHT: "0",
      ULTRATHINK_RAGFLOW: "0",
      ULTRATHINK_TEACH: "0",
    })
  })

  test("memory on: the substrate brief is reachable; the settings URL wins", () => {
    const env = plannerEnv(base, DEFAULT_OMP_SETTINGS, "/s")
    expect(env.SUBSTRATE_URL).toBe("http://127.0.0.1:7410")
    expect(env.SUBSTRATE_TOKEN).toBe("dummy-substrate")
    expect(env.SUBSTRATE_DISABLED).toBeUndefined()

    const overridden = plannerEnv(base, { ...DEFAULT_OMP_SETTINGS, substrate: { url: "http://127.0.0.1:9" } }, "/s")
    expect(overridden.SUBSTRATE_URL).toBe("http://127.0.0.1:9")
  })

  test("memory off: no substrate variable survives, and the planner is told", () => {
    const env = plannerEnv(base, { ...DEFAULT_OMP_SETTINGS, memory: { ...DEFAULT_OMP_SETTINGS.memory, enabled: false } }, "/s")
    expect(env.SUBSTRATE_DISABLED).toBe("1")
    expect(Object.keys(env).filter((name) => name.startsWith("SUBSTRATE_"))).toEqual(["SUBSTRATE_DISABLED"])
  })
})

// Process groups, signals and `#!/bin/sh` scripts: POSIX only.
describe.skipIf(process.platform === "win32")("the planner process", () => {
  test("gets control.json before it plans, with hitl from settings and tracking off", async () => {
    const harness = await setup()
    const uplift = harness.create()
    await uplift.run(request("@ok one"))
    expect((await harness.dump("openflow-run1-n1-1")).control).toEqual({ enabled: true, thinkEnabled: true, hitlEnabled: false, trackEnabled: false })

    harness.settings.uplift.hitl = true
    await uplift.run(request("@ok two", "n2"))
    expect((await harness.dump("openflow-run1-n2-1")).control).toEqual({ enabled: true, thinkEnabled: true, hitlEnabled: true, trackEnabled: false })
  })

  test("sees the filtered environment, with memory on", async () => {
    const harness = await setup()
    Object.assign(harness.env, {
      OPENROUTER_API_KEY: "dummy-openrouter",
      SUBSTRATE_URL: "http://127.0.0.1:7410",
      SUBSTRATE_TOKEN: "dummy-substrate",
      SWARM_ED25519_KEY: "dummy-swarm",
      GITHUB_TOKEN: "dummy-github",
      ULTRATHINK_DEBUG: "1",
    })
    await harness.create().run(request("@ok x"))
    const { env } = await harness.dump("openflow-run1-n1-1")

    expect(env.OPENROUTER_API_KEY).toBe("dummy-openrouter")
    expect(env.SUBSTRATE_TOKEN).toBe("dummy-substrate")
    expect(env.ULTRATHINK_STATE_DIR).toBe(harness.stateDir)
    expect(env.SWARM_ED25519_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.ULTRATHINK_DEBUG).toBeUndefined()
  })

  test("sees no substrate token when memory is off", async () => {
    const harness = await setup()
    harness.settings.memory.enabled = false
    Object.assign(harness.env, { SUBSTRATE_URL: "http://127.0.0.1:7410", SUBSTRATE_TOKEN: "dummy-substrate-value" })
    await harness.create().run(request("@ok x"))
    const { env } = await harness.dump("openflow-run1-n1-1")

    expect(env.SUBSTRATE_DISABLED).toBe("1")
    expect(JSON.stringify(env)).not.toContain("dummy-substrate-value")
    expect(env.SUBSTRATE_URL).toBeUndefined()
  })

  test("two cards at once share one state directory and never each other's session", async () => {
    const harness = await setup()
    const hold = gate()
    const uplift = harness.create()
    const first = uplift.run(request(`@gate:${hold.port} alpha`, "a"))
    const second = uplift.run(request(`@gate:${hold.port} beta`, "b"))
    await Promise.all([hold.arrival("openflow-run1-a-1"), hold.arrival("openflow-run1-b-1")])
    hold.release("openflow-run1-b-1")
    hold.release("openflow-run1-a-1")
    const [a, b] = await Promise.all([first, second])

    expect(a.status).toBe("ok")
    expect(b.status).toBe("ok")
    expect(a.uplifted).toContain("alpha")
    expect(a.uplifted).not.toContain("beta")
    expect(b.uplifted).toContain("beta")
    expect(b.uplifted).not.toContain("alpha")
    expect(a.specPath).not.toBe(b.specPath)
    expect(path.dirname(a.specPath!)).toBe(path.dirname(b.specPath!))
  })

  test("at most maxConcurrent planners run; the next starts when one finishes", async () => {
    const harness = await setup()
    const hold = gate()
    const uplift = harness.create({ maxConcurrent: 2 })
    const runs = ["a", "b", "c"].map((node) => uplift.run(request(`@gate:${hold.port} ${node}`, node)))

    await hold.count(2)
    const [first, second] = hold.arrivals.slice()
    const queued = ["a", "b", "c"].map((node) => `openflow-run1-${node}-1`).find((sid) => sid !== first && sid !== second)!
    // The third has not been started: it waits for a slot.
    await expect(harness.dump(queued)).rejects.toThrow()

    hold.release(first!)
    await hold.arrival(queued)
    hold.release(second!)
    hold.release(queued)
    const results = await Promise.all(runs)

    expect(results.map((result) => result.status)).toEqual(["ok", "ok", "ok"])
    expect(hold.peak()).toBe(2)
  })

  test("a planner past its wall clock is failed and its whole process group is gone", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@hang x", "n1", { timeoutMs: 400 }))

    expect(result.status).toBe("failed")
    expect(result.reason).toBe("planner timed out after 0.4 s")
    const pids = await harness.pids("openflow-run1-n1-1")
    await until(async () => !(await alive(pids.leader)) && !(await alive(pids.helper)))
  })

  test("queue wait does not count against the wall clock", async () => {
    const harness = await setup()
    const hold = gate()
    const uplift = harness.create({ maxConcurrent: 1 })
    const first = uplift.run(request(`@gate:${hold.port} a`, "a"))
    await hold.arrival("openflow-run1-a-1")
    const second = uplift.run(request(`@gate:${hold.port} b`, "b", { timeoutMs: 1_500 }))
    // Wall time has to pass here: the point is that 1.7 s in the queue does not spend a 1.5 s clock.
    await Bun.sleep(1_700)
    const started = hold.arrival("openflow-run1-b-1")
    hold.release("openflow-run1-a-1")
    await started
    hold.release("openflow-run1-b-1")
    expect((await first).status).toBe("ok")
    expect((await second).status).toBe("ok")
  })

  test("a planner that ignores SIGTERM is killed after the grace period", async () => {
    const harness = await setup()
    const result = await harness.create({ killGraceMs: 100 }).run(request("@stubborn x", "n1", { timeoutMs: 300 }))

    expect(result.reason).toBe("planner timed out after 0.3 s")
    const pids = await harness.pids("openflow-run1-n1-1")
    await until(async () => !(await alive(pids.leader)) && !(await alive(pids.helper)))
  })

  test("the caller's signal cancels a running planner and a queued one", async () => {
    const harness = await setup()
    const uplift = harness.create({ maxConcurrent: 1 })
    const running = new AbortController()
    const queued = new AbortController()
    const first = uplift.run(request("@hang a", "a"), running.signal)
    await until(async () => harness.pids("openflow-run1-a-1").then(() => true, () => false))
    const pids = await harness.pids("openflow-run1-a-1")
    const second = uplift.run(request("@hang b", "b"), queued.signal)

    queued.abort()
    expect((await second).reason).toContain("cancelled")
    await expect(harness.dump("openflow-run1-b-1")).rejects.toThrow()

    running.abort()
    expect((await first).reason).toContain("cancelled")
    await until(async () => !(await alive(pids.leader)) && !(await alive(pids.helper)))
  })

  test("dispose kills what is running, cancels what is queued, and leaves no orphan", async () => {
    const harness = await setup()
    const uplift = harness.create({ maxConcurrent: 1 })
    const first = uplift.run(request("@hang a", "a"))
    await until(async () => harness.pids("openflow-run1-a-1").then(() => true, () => false))
    const pids = await harness.pids("openflow-run1-a-1")
    const second = uplift.run(request("@hang b", "b"))

    await uplift.dispose()
    expect((await first).status).toBe("failed")
    expect((await second).reason).toContain("cancelled")
    expect(await alive(pids.leader)).toBe(false)
    await until(async () => !(await alive(pids.helper)))
    await expect(harness.dump("openflow-run1-b-1")).rejects.toThrow()
    // Nothing starts after dispose.
    expect((await uplift.run(request("@ok c", "c"))).reason).toContain("cancelled")
  })

  test("a command that cannot be started is failed, naming the cause", async () => {
    const harness = await setup()
    const result = await harness.create({ command: () => ({ argv: [path.join(harness.root, "no-such-binary")], cwd: harness.root }) }).run(request("@ok x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("could not be started")
  })

  test("the default command is bin/run-bun hooks/engine.ts run from the root", async () => {
    const harness = await setup()
    const script = path.join(harness.root, "bin", "run-bun")
    const marker = path.join(harness.root, "argv.txt")
    await fs.writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\npwd >> "${marker}"\ncat > /dev/null\nprintf '{"context":"","skipped":"jev-skip"}\\n'\n`)
    await fs.chmod(script, 0o755)
    const result = await harness.create({ command: undefined }).run(request("@ok x"))

    expect(result.status).toBe("skipped")
    expect((await fs.readFile(marker, "utf8")).split("\n")).toEqual(["hooks/engine.ts", await fs.realpath(harness.root), ""])
  })

  test("a state directory inside a .planning tree is refused, not silently ignored by the planner", async () => {
    const harness = await setup()
    const nested = path.join(harness.stateRoot, ".planning", "flow")
    const result = await harness.create({ stateRoot: () => nested }).run(request("@ok x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain(".planning")
    await expect(fs.stat(path.join(nested, "uplift", "control.json"))).rejects.toThrow()
  })

  test("never writes outside the state root", async () => {
    const harness = await setup()
    await harness.create().run(request("@ok x", "../../escape"))
    expect(await fs.readdir(path.dirname(harness.stateRoot)).then((names) => names.sort())).toEqual(["project", "state", "ultrathink"])
    expect(await fs.readdir(harness.stateRoot)).toEqual(["uplift"])
  })
})
