import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { UpliftRequest } from "../../shared/uplift"
import { isUplifted, loadStored, redact, saveStored, sessionIdFor, specPathFor } from "./result"
import { createHarness, type Harness } from "./testing/stub-planner"

/**
 * The interpretation tests run the real module against the stub planner, so
 * what is asserted is what a card would be handed: a child process, its stdout,
 * and the session files it left behind.
 */

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

function request(original: string, extra: Partial<UpliftRequest> = {}): UpliftRequest {
  return { runId: "run1", nodeId: "n1", original, ...extra }
}

describe("a plan", () => {
  test("is ok: the spec XML plus the guidance line, never the context markdown", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@ok build the thing"))

    expect(result.status).toBe("ok")
    expect(result.source).toBe("llm")
    expect(result.original).toBe("@ok build the thing")
    expect(result.uplifted?.startsWith("<BUILD_PROMPT>")).toBe(true)
    expect(result.uplifted).toContain("<ORIGINAL>@ok build the thing</ORIGINAL>")
    expect(result.uplifted?.endsWith("\n\nThe Graph of Thought above is guidance; verify against the repository.")).toBe(true)
    expect(result.uplifted).not.toContain("ultrathink-kickoff")
    expect(result.uplifted).not.toContain("## Prompt Uplift")
    expect(result.graphId).toBe("ut-stub-12345678")
    expect(result.nodes).toBe(3)
    expect(result.waves).toBe(2)
    expect(result.engine).toBe("claude:stub")
    expect(result.degraded).toBeUndefined()
    expect(result.specPath).toBe(path.join(harness.stateDir, "sessions", "openflow-run1-n1-1.xml"))
    expect(await Bun.file(result.specPath!).exists()).toBe(true)
  })

  test("is sent the planner as prime-agent with a per-attempt session id and the project as cwd", async () => {
    const harness = await setup()
    const uplift = harness.create()
    await uplift.run(request("@ok first"))
    await uplift.run(request("@ok second", { cwd: harness.root }))

    const first = await harness.dump("openflow-run1-n1-1")
    expect(first.request).toEqual({ host: "prime-agent", session_id: "openflow-run1-n1-1", prompt: "@ok first", cwd: harness.project })
    const second = await harness.dump("openflow-run1-n1-2")
    expect(second.request.cwd).toBe(harness.root)
    expect(second.cwd).toBe(harness.root)
  })

  test("over 128 KiB of output is read to the end", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@big large"))
    expect(result.status).toBe("ok")
  })

  test("with parts that fell back is still ok, and carries what the planner decided", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@partial plan it"))

    expect(result.status).toBe("ok")
    expect(result.degraded).toEqual(["fill:n3"])
    // The errored decision has no probability, so it is left out rather than shown as 0.
    expect(result.decisions).toEqual([{ point: "plan", p: 0.97, action: "plan" }])
  })

  test("falls back to the XML held in the session record when the .xml file is missing", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@no-xml recover"))
    expect(result.status).toBe("ok")
    expect(result.uplifted).toContain("<ORIGINAL>@no-xml recover</ORIGINAL>")
  })
})

describe("a skip", () => {
  test.each(["jev-skip", "empty", "disabled", "passthrough", "precheck-skip", "precheck-passthrough"])("%s is deliberate: skipped, original goes through", async (reason) => {
    const harness = await setup()
    const result = await harness.create().run(request(reason === "jev-skip" ? "@jev-skip tiny" : `@skip:${reason} tiny`))
    expect(result.status).toBe("skipped")
    expect(result.reason).toBe(reason)
    expect(result.uplifted).toBeUndefined()
  })

  test.each(["native-unavailable", "unsupported-host"])("%s is a configuration problem: failed", async (reason) => {
    const harness = await setup()
    const result = await harness.create().run(request(`@skip:${reason} x`))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain(reason)
    expect(result.reason).toContain("update claude-ultrathink")
  })

  test("an unexpected skip reason is failed, not silently passed through", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@skip:subagent x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("subagent")
  })

  test("turned off in settings: skipped without starting a planner", async () => {
    const harness = await setup()
    harness.settings.uplift.enabled = false
    const result = await harness.create().run(request("@ok x"))
    expect(result).toMatchObject({ status: "skipped", reason: "disabled" })
    await expect(harness.dump("openflow-run1-n1-1")).rejects.toThrow()
  })

  test("blank text and text that is already an uplifted spec never reach the planner", async () => {
    const harness = await setup()
    const uplift = harness.create()
    expect(await uplift.run(request("   \n"))).toMatchObject({ status: "skipped", reason: "empty" })
    expect(await uplift.run(request("<BUILD_PROMPT><ORIGINAL>x</ORIGINAL></BUILD_PROMPT>"))).toMatchObject({ status: "skipped", reason: "passthrough" })
    await expect(harness.dump("openflow-run1-n1-1")).rejects.toThrow()
  })
})

describe("a failure", () => {
  test("a fallback plan is failed and the reason names the login", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@fallback:Not_logged_in_Please_run_/login x"))
    expect(result.status).toBe("failed")
    expect(result.source).toBe("fallback")
    expect(result.uplifted).toBeUndefined()
    expect(result.reason).toBe("the claude CLI is not logged in: run `claude` once and sign in")
  })

  test("a missing claude CLI is named as such", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@fallback:Executable_not_found_in_$PATH x"))
    expect(result.reason).toBe("the claude CLI was not found: install it and put it on PATH")
  })

  test("another engine error is quoted, redacted and bounded", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@fallback:claude_exited_1_(sk-or-v1-abcdef0123456789) x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("claude exited 1")
    expect(result.reason).not.toContain("sk-or-v1-abcdef")
  })

  test("a fallback with no recorded error says why it can be", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@fallback-silent x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("size limit")
  })

  test("no output is failed", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@empty x"))
    expect(result).toMatchObject({ status: "failed", reason: "the planner printed no result" })
  })

  test("output that is not JSON is failed", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@garbage x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("printed no result")
  })

  test("a crash is failed with the exit code and a redacted stderr tail", async () => {
    const harness = await setup()
    const result = await harness.create().run(request("@crash x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("exited with code 3")
    expect(result.reason).toContain("could not start")
    expect(result.reason).not.toContain("sk-or-v1-abcdef")
    expect(result.reason).not.toContain("dummy-provider-key")
  })

  test("a planner that was never installed is failed with the setting to change", async () => {
    const harness = await setup()
    harness.settings.uplift.root = path.join(harness.root, "nowhere")
    const result = await harness.create().run(request("@ok x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("set the claude-ultrathink path in Omp settings")
  })
})

describe("locating claude-ultrathink", () => {
  // The plugin directory is a symlink, which Windows only grants with a privilege.
  test.skipIf(process.platform === "win32")("settings win, then ULTRATHINK_ROOT, then omp's plugin directory under HOME", async () => {
    const harness = await setup()
    const home = path.join(harness.root, "..", "home")
    const plugin = path.join(home, ".omp", "plugins", "node_modules")
    await fs.mkdir(plugin, { recursive: true })
    await fs.symlink(harness.root, path.join(plugin, "ultrathink"))
    harness.env.HOME = home
    harness.settings.uplift.root = ""

    // Plugin directory only.
    expect((await harness.create().run(request("@ok a"))).status).toBe("ok")

    // ULTRATHINK_ROOT pointing nowhere beats the plugin directory, and says so.
    harness.env.ULTRATHINK_ROOT = path.join(harness.root, "missing")
    const wrongEnv = await harness.create().run(request("@ok b"))
    expect(wrongEnv.status).toBe("failed")
    expect(wrongEnv.reason).toContain("ULTRATHINK_ROOT")

    // A configured root beats both.
    harness.settings.uplift.root = harness.root
    expect((await harness.create().run(request("@ok c"))).status).toBe("ok")
  })

  test("nothing found: failed with the actionable sentence", async () => {
    const harness = await setup()
    harness.env.HOME = path.join(harness.root, "..", "empty-home")
    harness.settings.uplift.root = ""
    const result = await harness.create().run(request("@ok x"))
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("set the claude-ultrathink path in Omp settings")
  })

  test("a relative root is refused", async () => {
    const harness = await setup()
    harness.settings.uplift.root = "relative/ultrathink"
    const result = await harness.create().run(request("@ok x"))
    expect(result.reason).toContain("absolute")
  })
})

describe("helpers", () => {
  test("redact removes key-looking text", () => {
    expect(redact("key sk-or-v1-abcdef0123456789 and Bearer abcdefghijkl1234 ok")).toBe("key [redacted] and Bearer [redacted] ok")
    expect(redact("OPENROUTER_API_KEY=hunter2 next")).toBe("OPENROUTER_API_KEY=[redacted] next")
    expect(redact("a".repeat(40))).toBe("[redacted]")
    expect(redact("claude exited 1")).toBe("claude exited 1")
  })

  test("session ids are clean, bounded and distinct for distinct raw ids", () => {
    expect(sessionIdFor("run-1", "n2", 3)).toBe("openflow-run-1-n2-3")
    const odd = sessionIdFor("../../etc", "a/b", 1)
    expect(odd).toMatch(/^openflow-[A-Za-z0-9_.-]+$/)
    expect(odd).not.toContain("/")
    expect(sessionIdFor("a/b", "n", 1)).not.toBe(sessionIdFor("a_b", "n", 1))
    expect(sessionIdFor("r".repeat(500), "n".repeat(500), 1).length).toBeLessThan(120)
    expect(specPathFor("/state", "openflow-run-1-n2-3")).toBe("/state/sessions/openflow-run-1-n2-3.xml")
  })

  test("isUplifted recognises the root tags only at the start", () => {
    expect(isUplifted("  <FIX_PROMPT>\n<ORIGINAL>x</ORIGINAL>")).toBe(true)
    expect(isUplifted("<UPLIFTED_PROMPT>")).toBe(true)
    expect(isUplifted("fix it <FIX_PROMPT>")).toBe(false)
    expect(isUplifted("<div>fix it</div>")).toBe(false)
  })

  test("a stored result round-trips, and an id that is a path stays inside the state directory", async () => {
    const harness = await setup()
    const dir = path.join(harness.stateRoot, "store")
    const result = { status: "skipped" as const, original: "x", reason: "empty", elapsedMs: 1 }
    await saveStored(dir, "../../escape", "..", { attempt: 4, result })

    expect(await loadStored(dir, "../../escape", "..")).toEqual({ attempt: 4, result })
    expect(await loadStored(dir, "other", "..")).toBeUndefined()
    expect(await fs.readdir(harness.stateRoot)).toEqual(["store"])
    expect(await fs.readdir(path.join(dir, "results"))).toHaveLength(1)
  })
})

/**
 * The one test that runs the real planner: it spends model tokens through the
 * `claude` CLI (and Jev, when a key is present), so it only runs on request:
 * `OPENFLOW_LIVE_UPLIFT=1 bun test lib/uplift/result.test.ts`.
 */
describe.skipIf(!process.env.OPENFLOW_LIVE_UPLIFT)("live planner", () => {
  test("plans a trivial prompt with the real claude-ultrathink", async () => {
    const harness = await setup()
    const live = harness.create({ env: process.env, command: undefined, maxConcurrent: 1 })
    // Settings' root stays empty: ULTRATHINK_ROOT, then omp's plugin directory, exactly as in production.
    harness.settings.uplift.root = ""
    const result = await live.run(request("uplift: write a function that adds two numbers", { timeoutMs: 300_000 }))

    expect(result.reason).toBeUndefined()
    expect(result.status).toBe("ok")
    expect(result.source).toBe("llm")
    expect(result.uplifted).toContain("<ORIGINAL>")
    expect(await Bun.file(result.specPath!).exists()).toBe(true)
  }, 320_000)
})
