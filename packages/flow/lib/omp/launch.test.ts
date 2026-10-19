import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import type { SwarmLaunch } from "../../shared/swarm"
import { resolveBinary } from "./binary"
import { buildLaunch, describeLaunch, PROBE_MODEL } from "./launch"
import { spawnOmp } from "./rpc"
import type { LaunchInput } from "./rpc-types"

const STATE = "/state/s1"

function input(patch: Partial<LaunchInput> = {}, session: Partial<LaunchInput["session"]> = {}): LaunchInput {
  return {
    settings: { ...DEFAULT_OMP_SETTINGS },
    binary: "/opt/omp/bin/omp",
    session: {
      runId: "run-1",
      nodeId: "node-1",
      card: { key: "pipe-coder-node-1", role: "coder", prompt: "Be careful." },
      directory: "/work/tree",
      permissions: "auto",
      ...session,
    },
    stateDir: STATE,
    env: { PATH: "/usr/bin", HOME: "/home/a" },
    ...patch,
  }
}

function swarm(patch: Partial<SwarmLaunch> = {}): SwarmLaunch {
  return {
    effective: "auto",
    args: ["-e", "/swarm/omp"],
    env: { SWARM_DIR: "/state/s1/swarm", SWARM_ROOT: "/swarm" },
    overlay: { task: { maxRecursionDepth: 2 } },
    systemPrompt: "",
    stateDir: "/state/s1/swarm",
    preflight: { ok: true, effective: "auto", requested: "auto", problems: [] },
    ...patch,
  }
}

function overlayOf(spec: ReturnType<typeof buildLaunch>) {
  return JSON.parse(spec.files.find((file) => file.path.endsWith("overlay.yml"))?.content ?? "null")
}

function roleOf(spec: ReturnType<typeof buildLaunch>) {
  return spec.files.find((file) => file.path.endsWith("role.md"))?.content
}

describe("buildLaunch: argv", () => {
  test("auto approval: headless, yolo, isolated profile, no ambient extensions", () => {
    const spec = buildLaunch(input({}, { model: "anthropic/claude-sonnet-5-5" }))
    expect(spec.argv).toEqual([
      "/opt/omp/bin/omp",
      "--mode",
      "rpc-ui",
      "--no-ui",
      "--no-title",
      "--session-dir",
      "/state/s1/session",
      "--cwd",
      "/work/tree",
      "--approval-mode",
      "yolo",
      "--max-time",
      "480m",
      "--profile",
      "openflow",
      "--no-extensions",
      "--model",
      "anthropic/claude-sonnet-5-5",
      "--append-system-prompt",
      "/state/s1/role.md",
      "--config",
      "/state/s1/overlay.yml",
    ])
    expect(spec.cwd).toBe("/work/tree")
  })

  test("manual approval keeps the UI and uses the configured mode", () => {
    const write = buildLaunch(input({}, { permissions: "manual" })).argv
    expect(write).not.toContain("--no-ui")
    expect(write.slice(write.indexOf("--approval-mode"), write.indexOf("--approval-mode") + 2)).toEqual(["--approval-mode", "write"])

    const ask = buildLaunch(input({ settings: { ...DEFAULT_OMP_SETTINGS, manualApproval: "always-ask" } }, { permissions: "manual" })).argv
    expect(ask[ask.indexOf("--approval-mode") + 1]).toBe("always-ask")
  })

  test("no profile, user extensions on, no model: those flags are absent", () => {
    const argv = buildLaunch(input({ settings: { ...DEFAULT_OMP_SETTINGS, profile: "", loadUserExtensions: true } })).argv
    expect(argv).not.toContain("--profile")
    expect(argv).not.toContain("--no-extensions")
    expect(argv).not.toContain("--model")
  })

  test("a probe session carries the one-letter probe model; a card session without a model still omits --model", () => {
    expect(PROBE_MODEL).toBe("a")
    const probe = buildLaunch(input({}, { model: PROBE_MODEL })).argv
    expect(probe[probe.indexOf("--model") + 1]).toBe("a")
    expect(buildLaunch(input()).argv).not.toContain("--model")
  })

  test("--max-time is whole minutes, at least one", () => {
    const at = (maxSessionMinutes: number) => {
      const argv = buildLaunch(input({ settings: { ...DEFAULT_OMP_SETTINGS, maxSessionMinutes } })).argv
      return argv[argv.indexOf("--max-time") + 1]
    }
    expect(at(90.7)).toBe("90m")
    expect(at(0)).toBe("1m")
  })

  test("tool denial never uses --tools", () => {
    const argv = buildLaunch(input({}, { card: { key: "k", role: "r", tools: { edit: false, bash: false } } })).argv
    expect(argv).not.toContain("--tools")
    expect(argv).not.toContain("--no-tools")
  })

  test("swarm arguments come last", () => {
    const argv = buildLaunch(input({ swarm: swarm() })).argv
    expect(argv.slice(-2)).toEqual(["-e", "/swarm/omp"])
    expect(argv.indexOf("--config")).toBeLessThan(argv.indexOf("-e"))
  })

  // The only place the flag spellings are checked against reality: skipped when omp is not installed.
  const omp = resolveBinary({ binary: "" })
  test.skipIf(!omp)("every flag in argv exists in `omp --help`", () => {
    const help = Bun.spawnSync([omp as string, "--help"]).stdout.toString()
    const argv = buildLaunch(
      input(
        { binary: omp as string, swarm: swarm() },
        { model: "a/b", card: { key: "k", role: "r", tools: { skill: false } } },
      ),
    ).argv
    const flags = argv.filter((part) => part.startsWith("--"))
    expect(flags.length).toBeGreaterThan(10)
    for (const flag of flags) expect(help).toContain(flag)
    expect(help).toContain("-e, --extension")
  })
})

describe("buildLaunch: files", () => {
  test("role.md is the card prompt, then the swarm addendum after a blank line", () => {
    expect(roleOf(buildLaunch(input()))).toBe("Be careful.")
    expect(roleOf(buildLaunch(input({ swarm: swarm({ systemPrompt: "You may spawn workers." }) })))).toBe("Be careful.\n\nYou may spawn workers.")
    expect(roleOf(buildLaunch(input({ swarm: swarm({ systemPrompt: "Only addendum." }) }, { card: { key: "k", role: "r" } })))).toBe("Only addendum.")
  })

  test("files live in the state directory, outside the project", () => {
    const spec = buildLaunch(input())
    expect(spec.files.map((file) => file.path)).toEqual(["/state/s1/role.md", "/state/s1/overlay.yml"])
  })

  test("the overlay is JSON text (valid YAML); empty when nothing is denied", () => {
    const spec = buildLaunch(input())
    const text = spec.files[1].content
    expect(text.endsWith("\n")).toBe(true)
    expect(JSON.parse(text)).toEqual({})
  })

  test("a false toggle denies every omp tool behind it, a true one denies nothing", () => {
    const spec = buildLaunch(
      input(
        {},
        {
          card: {
            key: "k",
            role: "r",
            tools: { read: true, grep: false, glob: false, edit: false, bash: false, websearch: false, todowrite: false, question: false },
          },
        },
      ),
    )
    expect(overlayOf(spec)).toEqual({
      tools: {
        approval: {
          grep: "deny",
          glob: "deny",
          edit: "deny",
          write: "deny",
          ast_edit: "deny",
          bash: "deny",
          eval: "deny",
          web_search: "deny",
          todo: "deny",
          ask: "deny",
        },
      },
    })
  })

  test("skill=false becomes --no-skills and adds no deny", () => {
    const spec = buildLaunch(input({}, { card: { key: "k", role: "r", tools: { skill: false } } }))
    expect(spec.argv).toContain("--no-skills")
    expect(overlayOf(spec)).toEqual({})
  })

  test("overlays merge deeply: card denies, then the caller's, then the swarm's; a deny cannot be undone", () => {
    const spec = buildLaunch(
      input(
        {
          overlay: { mcp: { enableProjectConfig: false }, task: { maxRecursionDepth: 9, isolation: "none" }, tools: { approval: { bash: "allow", read: "prompt" } } },
          swarm: swarm({ overlay: { task: { maxRecursionDepth: 2 } } }),
        },
        { card: { key: "k", role: "r", tools: { bash: false } } },
      ),
    )
    expect(overlayOf(spec)).toEqual({
      mcp: { enableProjectConfig: false },
      task: { maxRecursionDepth: 2, isolation: "none" },
      tools: { approval: { bash: "deny", eval: "deny", read: "prompt" } },
    })
  })

  test("a tool name like an Object.prototype member in the toggles is ignored safely", () => {
    const tools = JSON.parse('{"constructor":false,"toString":false,"bash":false}')
    const spec = buildLaunch(input({}, { card: { key: "k", role: "r", tools } }))
    expect(overlayOf(spec)).toEqual({ tools: { approval: { bash: "deny", eval: "deny" } } })
  })
})

describe("buildLaunch: environment", () => {
  test("allowlisted host variables plus the OpenFlow markers; uplift is off inside the card", () => {
    const spec = buildLaunch(input({ env: { PATH: "/usr/bin", HOME: "/home/a", OPENROUTER_API_KEY: "dummy-key", EDITOR: "vim" } }))
    expect(spec.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/a",
      OPENROUTER_API_KEY: "dummy-key",
      OPENFLOW_RUN: "run-1",
      OPENFLOW_CARD: "node-1",
      ULTRATHINK_UPLIFT: "0",
      AIO_UPLIFT: "0",
      PI_NO_TITLE: "1",
      NO_COLOR: "1",
    })
  })

  test("no Substrate, Swarm, ultrathink or token variable leaks from the host without swarm", () => {
    const spec = buildLaunch(
      input({
        env: {
          PATH: "/bin",
          SUBSTRATE_TOKEN: "dummy-s",
          SUBSTRATE_URL: "http://s",
          SWARM_ED25519_KEY: "dummy-k",
          SWARM_ROOT: "/swarm",
          ULTRATHINK_ROOT: "/ut",
          AIO_X: "1",
          GITHUB_TOKEN: "dummy-g",
        },
      }),
    )
    expect(Object.keys(spec.env).filter((name) => /SUBSTRATE|SWARM|GITHUB|AIO_X|ULTRATHINK_ROOT/.test(name))).toEqual([])
  })

  test("swarm env is merged and the signing key is passed by name from the host env", () => {
    const env = {
      PATH: "/bin",
      SWARM_ED25519_KEY: "dummy-key-value",
      SWARM_ED25519_KEY_FILE: "/keys/k",
      SWARM_SIGNING_KEY: "dummy-signing",
      SWARM_REQUIRE_KEY: "1",
      SWARM_AGENT: "must-not-pass",
      SWARM_TASK_ID: "must-not-pass",
      SWARM_CHILD: "1",
      SUBSTRATE_TOKEN: "dummy-s",
    }
    const spec = buildLaunch(input({ env, swarm: swarm() }))
    expect(spec.env).toMatchObject({
      SWARM_DIR: "/state/s1/swarm",
      SWARM_ROOT: "/swarm",
      SWARM_ED25519_KEY: "dummy-key-value",
      SWARM_ED25519_KEY_FILE: "/keys/k",
      SWARM_SIGNING_KEY: "dummy-signing",
      SWARM_REQUIRE_KEY: "1",
    })
    expect(spec.env).not.toHaveProperty("SWARM_AGENT")
    expect(spec.env).not.toHaveProperty("SWARM_TASK_ID")
    expect(spec.env).not.toHaveProperty("SWARM_CHILD")
    expect(spec.env).not.toHaveProperty("SUBSTRATE_TOKEN")
  })

  test("a swarm that hands in identity variables cannot make the card a swarm child", () => {
    const spec = buildLaunch(input({ swarm: swarm({ env: { SWARM_DIR: "/d", SWARM_AGENT: "x", SWARM_TASK_ID: "y", SWARM_CHILD: "1" } }) }))
    expect(spec.env.SWARM_DIR).toBe("/d")
    expect(Object.keys(spec.env).filter((name) => ["SWARM_AGENT", "SWARM_TASK_ID", "SWARM_CHILD"].includes(name))).toEqual([])
  })

  test("swarm off: no signing key reaches the card", () => {
    const spec = buildLaunch(
      input({ env: { PATH: "/bin", SWARM_ED25519_KEY: "dummy-key-value" }, swarm: swarm({ effective: "off", args: [], env: {}, overlay: {} }) }),
    )
    expect(Object.keys(spec.env).some((name) => name.startsWith("SWARM_"))).toBe(false)
    expect(spec.argv).not.toContain("-e")
  })

  test("no secret value appears in argv or in a file", () => {
    const secrets = { SWARM_ED25519_KEY: "secret-ed25519-value", SUBSTRATE_TOKEN: "secret-substrate-value", OPENROUTER_API_KEY: "secret-provider-value", SWARM_SIGNING_KEY: "secret-signing-value" }
    const spec = buildLaunch(input({ env: { PATH: "/bin", ...secrets }, swarm: swarm() }))
    const visible = JSON.stringify([spec.argv, spec.files])
    for (const value of Object.values(secrets)) expect(visible).not.toContain(value)
  })
})

describe("describeLaunch", () => {
  test("a plain card has nothing to report", () => {
    expect(describeLaunch(input())).toEqual({ notes: [] })
    expect(describeLaunch(input({}, { card: { key: "k", role: "r", tools: { bash: false, skill: false, edit: false } } }))).toEqual({ notes: [] })
  })

  test("webfetch off cannot be honoured and says so", () => {
    const { notes } = describeLaunch(input({}, { card: { key: "k", role: "r", tools: { webfetch: false } } }))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("webfetch")
    expect(notes[0]).toContain("read")
  })

  test("an unknown false toggle is reported, never silently dropped", () => {
    const { notes } = describeLaunch(input({}, { card: { key: "k", role: "r", tools: { telepathy: false, bash: true } } }))
    expect(notes).toEqual(['tool toggle "telepathy" is off but has no omp equivalent; it stays enabled'])
  })

  test("an MCP allowlist is reported as not enforceable through the overlay", () => {
    const named = describeLaunch(input({}, { card: { key: "k", role: "r", mcp: ["github", "linear"] } })).notes
    expect(named).toHaveLength(1)
    expect(named[0]).toContain("github, linear")
    expect(describeLaunch(input({}, { card: { key: "k", role: "r", mcp: [] } })).notes[0]).toContain("none")
  })
})

// The one test that runs the real binary: read-only (get_state, no model call), skipped when omp is absent.
describe("a real omp honours the launch it is given", () => {
  const omp = resolveBinary({ binary: "" })
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test.skipIf(!omp)(
    "role prompt is appended and the JSON overlay is applied",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "omp-launch-test-"))
      dirs.push(root)
      const spec = buildLaunch({
        ...input(),
        binary: omp as string,
        settings: { ...DEFAULT_OMP_SETTINGS, profile: "" },
        session: { ...input().session, directory: root, card: { key: "k", role: "r", prompt: "LAUNCHTEST-ROLE-MARKER" } },
        stateDir: path.join(root, "state"),
        overlay: { steeringMode: "all", compaction: { enabled: false } },
        env: process.env,
      })
      const proc = spawnOmp(spec)
      try {
        await proc.ready
        const state = await proc.command<{ steeringMode: string; autoCompactionEnabled: boolean; systemPrompt: string[] }>({ type: "get_state" })
        expect(state.steeringMode).toBe("all")
        expect(state.autoCompactionEnabled).toBe(false)
        expect(JSON.stringify(state.systemPrompt)).toContain("LAUNCHTEST-ROLE-MARKER")
        expect(readFileSync(path.join(root, "state", "role.md"), "utf8")).toBe("LAUNCHTEST-ROLE-MARKER")
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    30_000,
  )
})
