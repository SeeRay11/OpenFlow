import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OMP_ROUTES, type OmpAuthImportResult } from "../../shared/omp"
import { resetOmpCheck } from "../omp/binary"
import type { LaunchSpec, OmpProcess } from "../omp/rpc-types"
import { installFakeOmp } from "./fake-omp"
import { createOmpConfig } from "./index"
import { isRecord } from "./settings"

const SECRETS = ["sk-ant-oat01-AAAA1111bbbb2222cccc3333dddd", "refresh-9f8e7d6c5b4a39281706f5e4d3c2b1a0", "zai-key-QQQQ5555rrrr6666ssss7777"]
const EXPORT = `${JSON.stringify(
  {
    version: 1,
    credentials: [
      { provider: "anthropic", credential: { type: "oauth", access: SECRETS[0], refresh: SECRETS[1] } },
      { provider: "zai", credential: { type: "api_key", key: SECRETS[2], note: "café ✓" } },
    ],
  },
  null,
  2,
)}\n`

type Call = { argv: string[]; leaked: string[] }

let dir: string
let bin: string
let server: { port?: number; stop(closeActive?: boolean): Promise<void> } | undefined
let spawns: number
let configModule: ReturnType<typeof createOmpConfig> | undefined

function start(runTimeoutMs?: number) {
  const module = createOmpConfig({
    stateDir: () => path.join(dir, "state"),
    env: { PATH: bin },
    runTimeoutMs,
    launch: (input) => ({ argv: [input.binary], env: {}, cwd: input.session.directory, files: [] }) satisfies LaunchSpec,
    spawn: () => {
      spawns++
      return {
        ready: Promise.resolve({ protocolVersion: 2 }),
        async command() {
          return { providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: true }] } as never
        },
        async close() {},
      } as Partial<OmpProcess> as OmpProcess
    },
  })
  configModule = module
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      return (await module.handle(request)) ?? new Response("unhandled", { status: 418 })
    },
  })
}

beforeEach(async () => {
  resetOmpCheck()
  dir = await mkdtemp(path.join(os.tmpdir(), "omp-auth-"))
  bin = path.join(dir, "bin")
  await installFakeOmp(bin)
  await writeFile(path.join(bin, "credentials.json"), EXPORT)
  spawns = 0
})

afterEach(async () => {
  await server?.stop(true)
  server = undefined
  resetOmpCheck()
  await rm(dir, { recursive: true, force: true })
})

const url = (route: string) => `http://127.0.0.1:${server?.port}${route}`
const post = () => fetch(url(OMP_ROUTES.authImport), { method: "POST" })
const calls = async () =>
  (await readFile(path.join(bin, "calls.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const call: Call = JSON.parse(line)
      return call
    })
const authCalls = async () => (await calls()).filter((call) => call.argv.includes("auth"))
const flag = (name: string, content = "on") => writeFile(path.join(bin, name), content)
const leaks = (text: string) => SECRETS.filter((secret) => text.includes(secret))

function errorOf(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string") return body.error
  throw new Error("the response has no error sentence")
}

async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    // A killed child nobody has reaped yet is a zombie: gone for our purposes.
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

// The fake omp is a `#!` script the module really executes: POSIX only.
describe.skipIf(process.platform === "win32")("POST authImport", () => {
  test("copies the default profile's logins into the configured profile, byte for byte", async () => {
    start()
    await fetch(url(OMP_ROUTES.status))
    expect(spawns).toBe(1)

    const response = await post()
    expect(response.status).toBe(200)
    const text = await response.text()
    const body: OmpAuthImportResult = JSON.parse(text)
    expect(body.imported).toBe(2)
    expect(body.status).toMatchObject({ available: true, profile: "openflow", providers: { authenticated: 1, total: 1 }, problems: [] })
    // The provider answer was dropped, so the fresh status asked omp again.
    expect(spawns).toBe(2)

    const copied = await readFile(path.join(bin, "profiles", "openflow", "credentials.json"))
    expect(Buffer.compare(copied, Buffer.from(EXPORT, "utf8"))).toBe(0)

    const auth = await authCalls()
    expect(auth.map((call) => call.argv)).toEqual([["auth", "export"], ["--profile", "openflow", "auth", "import", "-"]])
    expect(auth[0]?.argv).not.toContain("--profile")
    expect(auth.flatMap((call) => call.leaked)).toEqual([])
    expect(leaks(text)).toEqual([])
    expect(leaks(JSON.stringify(await calls()))).toEqual([])
  })

  test("only POST is accepted", async () => {
    start()
    const response = await fetch(url(OMP_ROUTES.authImport))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })

  test("the default profile has nothing to copy: 400 and omp is not asked for logins", async () => {
    start()
    const put = await fetch(url(OMP_ROUTES.settings), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "" }),
    })
    expect(put.status).toBe(200)
    const response = await post()
    expect(response.status).toBe(400)
    expect(errorOf(await response.json())).toBe("The default profile is already in use, so there is nothing to copy.")
    expect(await authCalls()).toEqual([])
  })

  test("a failing export is a 400 and nothing is imported", async () => {
    start()
    await flag("fail-export")
    const response = await post()
    expect(response.status).toBe(400)
    expect(errorOf(await response.json())).toBe("Your default omp profile has no logins to copy. Run omp and use /login there first.")
    expect((await authCalls()).map((call) => call.argv)).toEqual([["auth", "export"]])
  })

  test("an export with zero credentials is the same 400", async () => {
    start()
    await writeFile(path.join(bin, "credentials.json"), JSON.stringify({ version: 1, credentials: [] }))
    const response = await post()
    expect(response.status).toBe(400)
    expect(errorOf(await response.json())).toContain("no logins to copy")
    expect(await authCalls()).toHaveLength(1)
  })

  test("an export in a form OpenFlow does not know is a 502 that does not quote it", async () => {
    start()
    await writeFile(path.join(bin, "credentials.json"), `not json ${SECRETS[0]}`)
    const response = await post()
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).toContain("does not understand")
    expect(leaks(text)).toEqual([])
    expect(await authCalls()).toHaveLength(1)
  })

  test("a failing import is a 502 whose message is capped and redacted", async () => {
    start()
    await flag("fail-import", `credential rejected ${SECRETS[0]} ${"because ".repeat(80)}${SECRETS[1]}`)
    const response = await post()
    expect(response.status).toBe(502)
    const text = await response.text()
    const message = errorOf(JSON.parse(text))
    expect(message.startsWith("Could not copy the logins: credential rejected")).toBe(true)
    expect(message.length).toBeLessThanOrEqual(300)
    expect(leaks(text)).toEqual([])
    expect(leaks(JSON.stringify(await calls()))).toEqual([])
  })

  test("a short failing import is reported whole, with secrets masked", async () => {
    start()
    await flag("fail-import", `bad token ${SECRETS[0]}`)
    const message = errorOf(await (await post()).json())
    expect(message).toContain("bad token")
    expect(message).toContain("[REDACTED")
    expect(leaks(message)).toEqual([])
  })

  /**
   * The pids the fake omp wrote as it started to hang. It writes the file in place, in more than one step, so it is read until it parses and names both processes
   * (no event exists for another process's write: deadline-bounded polling, not a fixed wait).
   */
  async function recordedPids(): Promise<{ child: number; grandchild: number }> {
    const deadline = Date.now() + 15_000
    for (;;) {
      const text = await readFile(path.join(bin, "pids.json"), "utf8").catch(() => "")
      try {
        const pids: unknown = JSON.parse(text)
        if (isRecord(pids) && typeof pids.child === "number" && typeof pids.grandchild === "number") return { child: pids.child, grandchild: pids.grandchild }
      } catch {
        // Not complete yet.
      }
      if (Date.now() > deadline) throw new Error("the fake omp recorded no pids")
      await Bun.sleep(10)
    }
  }

  /** Real processes dying is the thing under test; there is no event to await for a SIGKILLed group. */
  async function gone(...pids: number[]) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (await Promise.all(pids.map(alive))).some(Boolean)) await Bun.sleep(20)
  }

  test("a hung omp is killed with everything it started and answered as a timeout", async () => {
    start(1500)
    await flag("hang")
    const started = Date.now()
    const response = await post()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(response.status).toBe(502)
    expect(errorOf(await response.json())).toBe("omp did not answer in time")

    const { child, grandchild } = await recordedPids()
    await gone(child, grandchild)
    expect(await alive(child)).toBe(false)
    expect(await alive(grandchild)).toBe(false)
  })

  test("omp missing is a 503", async () => {
    start()
    await rm(path.join(bin, "omp"))
    expect((await post()).status).toBe(503)
  })

  test("dispose kills a run in flight with everything it started, answers it, and refuses the next call", async () => {
    start()
    await flag("hang")
    const posting = post()
    const pids = await recordedPids()
    expect(await alive(pids.child)).toBe(true)

    await configModule?.dispose()

    expect((await posting).status).toBe(502)
    await gone(pids.child, pids.grandchild)
    expect(await alive(pids.child)).toBe(false)
    expect(await alive(pids.grandchild)).toBe(false)
    expect((await post()).status).toBe(503)
  })
})
