import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "bun"
import type { SwarmPreflight } from "../../shared/swarm"
import type { HostHandler } from "../host/respond"
import { SWARM_ROUTES } from "../../shared/swarm"
import { createSwarmHost } from "./index"
import { DUMMY_KEYS, fakePython, fakeRoot, frames, hostEnv, liveDocument, settings, tmpdir, writeLive } from "./testing/fixtures"

let dir: string
let root: string
let python: string
const servers: Server<unknown>[] = []

beforeEach(() => {
  dir = tmpdir()
  root = fakeRoot(dir)
  python = fakePython(dir, { runs: true, crypto: true })
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

const signed = () => hostEnv({ SWARM_ED25519_KEY: DUMMY_KEYS.SWARM_ED25519_KEY })

function host(env: NodeJS.ProcessEnv, root_ = root, mode: "off" | "auto" | "always" = "auto") {
  return createSwarmHost({ settings: async () => ({ ...settings(root_), swarm: { mode, root: root_ } }), env, python })
}

describe("createSwarmHost.launch", () => {
  test("auto with everything in place loads the extension", async () => {
    const state = path.join(dir, "session")
    const launch = await host(signed()).launch({ settings: settings(root), mode: "auto", runId: "r", nodeId: "n", stateDir: state, env: signed() })
    expect(launch.effective).toBe("auto")
    expect(launch.args).toEqual(["-e", path.join(root, "omp")])
    expect(launch.env.SWARM_DIR).toBe(path.join(state, "swarm"))
    expect(fs.existsSync(path.join(state, "swarm"))).toBe(true)
  })

  test("a missing signer degrades to off with the reason in the tracker's status", async () => {
    const swarm = host(hostEnv())
    const state = path.join(dir, "session")
    const launch = await swarm.launch({ settings: settings(root), mode: "always", runId: "r", nodeId: "n", stateDir: state, env: hostEnv() })
    expect(launch.effective).toBe("off")
    expect(launch.args).toEqual([])
    expect(launch.preflight.problems.map((problem) => problem.code)).toEqual(["no-signing-key"])
    expect(fs.existsSync(state)).toBe(false)

    const tracker = swarm.tracker({ mode: "always", stateDir: state })
    const snapshot = tracker.snapshot()
    expect(snapshot.mode).toBe("off")
    expect(snapshot.error).toContain("No assignment-signing key")
    expect(snapshot.error).toContain("SWARM_ED25519_KEY_FILE")
    expect(tracker.observe(frames.taskStart("c1", { agent: "a05-backend", task: "x" }))).toBeUndefined()
    tracker.dispose()
  })

  test("off launches nothing and needs nothing", async () => {
    const launch = await host(hostEnv()).launch({ settings: settings(), mode: "off", runId: "r", nodeId: "n", stateDir: path.join(dir, "s"), env: hostEnv() })
    expect(launch).toMatchObject({ effective: "off", args: [], env: {}, overlay: {}, systemPrompt: "" })
    expect(launch.preflight.ok).toBe(true)
  })
})

describe("createSwarmHost.tracker", () => {
  test("uses the checkout's roster and folds live.json from the session's store", async () => {
    const swarm = host(signed())
    const state = path.join(dir, "session")
    await swarm.launch({ settings: settings(root), mode: "auto", runId: "r", nodeId: "n", stateDir: state, env: signed() })
    const tracker = swarm.tracker({ mode: "auto", stateDir: state })

    // a13-observability looks like a slug but is not in this checkout's omp/agents
    expect(tracker.observe(frames.taskStart("c1", { agent: "a13-observability", task: "x" }))).toBeUndefined()
    expect(tracker.observe(frames.taskStart("c2", { agent: "a05-backend", task: "x" }))?.counts.running).toBe(1)

    writeLive(state, liveDocument([{ agent: "a08-qa", state: "running", activity: "running tests" }]))
    const status = await tracker.poll?.()
    expect(status?.agents.map((agent) => [agent.agent, agent.state, agent.activity])).toEqual([
      ["a05-backend", "running", "delegated"],
      ["a08-qa", "running", "running tests"],
    ])
    tracker.dispose()
  })

  test("without a prior launch the slug shape decides", () => {
    const tracker = host(signed()).tracker({ mode: "auto", stateDir: path.join(dir, "unknown") })
    expect(tracker.observe(frames.taskStart("c1", { agent: "a13-observability", task: "x" }))?.active).toBe(true)
    tracker.dispose()
  })
})

describe("preflight route", () => {
  async function serve(handle: HostHandler) {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await handle(request)) ?? new Response("not mine", { status: 404 }) })
    servers.push(server)
    return `http://127.0.0.1:${server.port}${SWARM_ROUTES.preflight}`
  }

  test("answers the requested mode", async () => {
    const url = await serve(host(signed()).handle)
    const response = await fetch(`${url}?mode=always`)
    expect(response.status).toBe(200)
    const body: SwarmPreflight = await response.json()
    expect(body).toEqual({ ok: true, effective: "always", requested: "always", problems: [], root })
  })

  test("defaults to the settings' mode and reports problems with fixes, never key values", async () => {
    const url = await serve(host(hostEnv({ SWARM_SIGNING_KEY: "" }), root, "auto").handle)
    const body: SwarmPreflight = await (await fetch(url)).json()
    expect(body.requested).toBe("auto")
    expect(body.effective).toBe("off")
    expect(body.ok).toBe(false)
    expect(body.problems.map((problem) => problem.code)).toEqual(["no-signing-key"])
    expect(body.problems[0]?.fix).toBeTruthy()
  })

  test("off is ok with no checkout at all", async () => {
    const url = await serve(host(hostEnv(), "").handle)
    const body: SwarmPreflight = await (await fetch(`${url}?mode=off`)).json()
    expect(body).toEqual({ ok: true, effective: "off", requested: "off", problems: [] })
  })

  test("a key in the environment never shows up in the answer", async () => {
    const url = await serve(host({ ...signed(), SWARM_SIGNING_KEY: DUMMY_KEYS.SWARM_SIGNING_KEY }).handle)
    const text = await (await fetch(`${url}?mode=auto`)).text()
    for (const value of Object.values(DUMMY_KEYS)) expect(text).not.toContain(value)
  })

  test("rejects an unknown mode and non-GET methods, and ignores other paths", async () => {
    const url = await serve(host(signed()).handle)
    const bad = await fetch(`${url}?mode=sometimes`)
    expect(bad.status).toBe(400)
    const failure: { code?: string } = await bad.json()
    expect(failure.code).toBe("bad-mode")
    expect((await fetch(url, { method: "POST" })).status).toBe(405)
    expect((await fetch(new URL("/flow/api/swarm/other", url))).status).toBe(404)
  })
})
