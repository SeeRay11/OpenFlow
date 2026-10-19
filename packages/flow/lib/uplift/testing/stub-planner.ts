import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../../shared/omp"
import type { UpliftDeps, UpliftModule } from "../index"

/**
 * A stand-in for claude-ultrathink's `hooks/engine.ts`: reads the one JSON line
 * on stdin, writes the session files the real planner writes, and prints a
 * canned `PlanResponse`. It never makes a model call.
 *
 * The behaviour is chosen by a directive at the start of the prompt
 * (`@mode` or `@mode:arg`), because the planner's environment is an allowlist
 * and a test variable would never reach it. The stub also dumps what it was
 * given (`dump-<sid>.json`) so tests can assert on the real environment.
 *
 *   @ok  @partial  @jev-skip  @skip:<reason>  @fallback[:<engineError>]  @fallback-silent
 *   @empty  @garbage  @crash  @hang  @stubborn  @big  @gate:<port>  @no-xml
 */

const GOAL = "Stub goal"

export type Dump = {
  request: { host: string; session_id: string; prompt: string; cwd: string }
  env: Record<string, string | undefined>
  control: unknown
  cwd: string
  pid: number
}

function stateDirOf() {
  return process.env.ULTRATHINK_STATE_DIR!
}

function writeSession(sid: string, prompt: string, options: { source: "llm" | "fallback"; degraded?: string[]; rich?: boolean; engineError?: string; xml?: boolean }) {
  const dir = stateDirOf()
  mkdirSync(path.join(dir, "sessions"), { recursive: true })
  const xml = `<BUILD_PROMPT>\n  <ORIGINAL>${prompt}</ORIGINAL>\n  <GRAPH_OF_THOUGHT><GOAL>${GOAL}</GOAL></GRAPH_OF_THOUGHT>\n</BUILD_PROMPT>`
  const record = {
    sessionId: sid,
    at: Date.now(),
    engine: "claude:stub",
    ...(options.engineError ? { engineError: options.engineError } : {}),
    ...(options.degraded ? { degraded: options.degraded } : {}),
    result: { xml, original: prompt, root: "BUILD_PROMPT", source: options.source },
    ...(options.rich
      ? {
          decisions: [
            { point: "plan", outcome: "ok", model: "stub", p: 0.97, probabilities: { plan_worthy: 0.97 }, threshold: 0.2, action: "plan", latencyMs: 5, attempts: 1, at: 1 },
            { point: "blocking", outcome: "error", model: "stub", probabilities: {}, threshold: 0.5, action: "keep", latencyMs: 5, attempts: 1, error: "timeout", at: 2 },
          ],
          clarifications: [
            {
              id: "q1",
              question: "Which database?",
              header: "Storage",
              why: "Changes the schema.",
              options: [{ label: "sqlite", description: "local" }, { label: "postgres" }],
              default: "sqlite",
              blocking: true,
              answer: "ignored",
            },
          ],
        }
      : {}),
  }
  writeFileSync(path.join(dir, "sessions", `${sid}.json`), JSON.stringify(record))
  if (options.xml !== false) writeFileSync(path.join(dir, "sessions", `${sid}.xml`), xml)
}

function view(source: "llm" | "fallback") {
  return {
    root: "BUILD_PROMPT",
    source,
    engine: "claude:stub",
    graphId: "ut-stub-12345678",
    goal: GOAL,
    elapsedMs: 1,
    nodes: ["n1", "n2", "n3"].map((id, index) => ({ id, title: id, kind: "task", wave: index < 2 ? 0 : 1, dependsOn: [], steps: [] })),
    waves: [["n1", "n2"], ["n3"]],
    clarifications: [],
  }
}

/** Waits for the write to reach the pipe: a response over 128 KiB is cut off if the process exits first. */
async function print(response: unknown) {
  await Bun.write(Bun.stdout, `${JSON.stringify(response)}\n`)
}

async function okResponse(sid: string, prompt: string, options: { rich?: boolean; degraded?: string[]; xml?: boolean; big?: boolean }) {
  writeSession(sid, prompt, { source: "llm", ...options })
  const context = `## Prompt Uplift\n\nUse the skills ultrathink-plan and ultrathink-kickoff.\n${options.big ? "x".repeat(300_000) : ""}`
  await print({ context, graphId: "ut-stub-12345678", specPath: path.join(stateDirOf(), "sessions", `${sid}.xml`), view: view("llm") })
}

async function main() {
  const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Dump["request"]
  const dir = stateDirOf()
  const control = JSON.parse(readFileSync(path.join(dir, "control.json"), "utf8")) as unknown
  const dump: Dump = { request, env: { ...process.env }, control, cwd: process.cwd(), pid: process.pid }
  writeFileSync(path.join(dir, `dump-${request.session_id}.json`), JSON.stringify(dump))

  const directive = /^@([a-z-]+)(?::(\S+))?/.exec(request.prompt)
  const mode = directive?.[1] ?? "ok"
  const arg = directive?.[2]
  const sid = request.session_id

  switch (mode) {
    case "ok":
    case "big":
      return await okResponse(sid, request.prompt, { big: mode === "big" })
    case "partial":
      return await okResponse(sid, request.prompt, { rich: true, degraded: ["fill:n3"] })
    case "no-xml":
      return await okResponse(sid, request.prompt, { xml: false })
    case "jev-skip":
      return await print({ context: "", skipped: "jev-skip" })
    case "skip":
      return await print({ context: "", skipped: arg ?? "empty" })
    case "fallback":
    case "fallback-silent": {
      // Directives cannot hold spaces, so `_` stands for one.
      const engineError = mode === "fallback" ? (arg ?? "claude_exited_1").replaceAll("_", " ") : undefined
      writeSession(sid, request.prompt, { source: "fallback", engineError })
      return await print({ context: `## Planning degraded\n\nThe claude:stub planning call failed (${engineError ?? ""}).`, view: view("fallback") })
    }
    case "empty":
      return
    case "garbage":
      await Bun.write(Bun.stdout, "this is not json\n")
      return
    case "crash":
      await Bun.write(Bun.stderr, "fatal: could not start sk-or-v1-abcdef0123456789abcdef0123456789 OPENROUTER_API_KEY=dummy-provider-key\n")
      process.exit(3)
      return
    case "hang":
    case "stubborn": {
      if (mode === "stubborn") process.on("SIGTERM", () => undefined)
      // Same process group as this leader: the pool must take it down too.
      const helper = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] })
      writeFileSync(path.join(dir, `pids-${sid}.json`), JSON.stringify({ leader: process.pid, helper: helper.pid }))
      setInterval(() => undefined, 1_000)
      await Promise.withResolvers<void>().promise
      return
    }
    case "gate": {
      await fetch(`http://127.0.0.1:${arg}/started/${sid}`)
      return await okResponse(sid, request.prompt, {})
    }
    default:
      return await print({ context: "", skipped: "engine-error" })
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(9))
}

/** Test-side: a fake ultrathink checkout, state and project directories, and the module under test wired to the stub. */
export type Harness = {
  root: string
  stateRoot: string
  stateDir: string
  project: string
  settings: OmpSettings
  env: NodeJS.ProcessEnv
  create(deps?: Partial<UpliftDeps>): UpliftModule
  dump(sessionId: string): Promise<Dump>
  pids(sessionId: string): Promise<{ leader: number; helper: number }>
  cleanup(): Promise<void>
}

export async function createHarness(): Promise<Harness> {
  // Imported here so the stub script itself stays cheap to start.
  const { createUplift } = await import("../index")
  const dir = mkdtempSync(path.join(os.tmpdir(), "flow-uplift-"))
  const root = path.join(dir, "ultrathink")
  const stateRoot = path.join(dir, "state")
  const project = path.join(dir, "project")
  for (const folder of [path.join(root, "bin"), path.join(root, "hooks"), stateRoot, project]) mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(root, "bin", "run-bun"), "#!/bin/sh\n")
  writeFileSync(path.join(root, "hooks", "engine.ts"), "")

  const settings: OmpSettings = structuredClone(DEFAULT_OMP_SETTINGS)
  settings.uplift.root = root
  // The real HOME keeps Bun's transpile cache warm for every stub start.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME }
  const modules: UpliftModule[] = []
  const stub = path.join(import.meta.dir, "stub-planner.ts")
  const stateDir = path.join(stateRoot, "uplift")

  return {
    root,
    stateRoot,
    stateDir,
    project,
    settings,
    env,
    create(deps = {}) {
      const module = createUplift({
        project: () => project,
        stateRoot: () => stateRoot,
        settings: async () => structuredClone(settings),
        env,
        command: () => ({ argv: [process.execPath, stub], cwd: root }),
        ...deps,
      })
      modules.push(module)
      return module
    },
    async dump(sessionId) {
      return JSON.parse(await fs.readFile(path.join(stateDir, `dump-${sessionId}.json`), "utf8")) as Dump
    },
    async pids(sessionId) {
      return JSON.parse(await fs.readFile(path.join(stateDir, `pids-${sessionId}.json`), "utf8")) as { leader: number; helper: number }
    },
    async cleanup() {
      await Promise.all(modules.splice(0).map((module) => module.dispose()))
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/** True while the process exists and is not a zombie awaiting a reaper. */
export async function alive(pid: number) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (stat === undefined) return false
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
}

/** Waits for a condition that has no event to listen to (another process's death), bounded by a deadline. */
export async function until(condition: () => boolean | Promise<boolean>, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline")
    await Bun.sleep(5)
  }
}
