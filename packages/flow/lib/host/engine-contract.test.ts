import type { Server } from "bun"
import { setDefaultTimeout } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { engineRoutes } from "../../shared/engine"
import { OMP_ROUTES } from "../../shared/omp"
import { defineEngineContract, type ContractInstance, type EngineSurface } from "../../src/server/engine-contract"
import {
  accepts,
  createSession,
  describe,
  health,
  interrupt,
  models,
  prompt,
  rejectQuestion,
  release,
  releaseRun,
  replyPermission,
  replyQuestion,
  sessionCalls,
  sessionSteps,
  sessionTranscript,
  sessions,
  setOrigin,
  subscribe,
  transcript,
  waitForIdle,
} from "../../src/server/client"
import { DEFAULT_USAGE, type ContractDriver, type Decision, type StepScript, type TurnScript } from "../../src/server/testing/engine-script"
import { assistantMessage, frames } from "../omp/testing/fake-process"
import { alive, until } from "../uplift/testing/stub-planner"
import { createHost } from "./index"

/**
 * The shared `EngineApi` contract (`src/server/engine-contract.ts`) against the
 * real adapter: the browser client over real HTTP, to a real `createHost` on
 * `Bun.serve` port 0, whose omp is `lib/omp/testing/stub-omp.ts` behind a
 * wrapper script. The same suite runs on `createFakeEngine`, which is what
 * makes the fake a faithful double. Loopback only, no model calls.
 */

setDefaultTimeout(30_000)

// The wrapper omp is a `/bin/sh` script and the host reaps POSIX process groups: nothing here runs on Windows.
const posix = process.platform !== "win32"

const STUB_OMP = path.join(import.meta.dir, "..", "omp", "testing", "stub-omp.ts")

/** A script's messages as the frames omp writes, in the order the stub plays them. Message ids are unique across scripts, as omp's are. */
function framesOf(turn: TurnScript, ids: { next(): string }): unknown[] {
  const out: unknown[] = [frames.agentStart()]
  for (const step of turn.steps) out.push(...messageOf(step, ids.next()))
  if (turn.error) {
    const id = ids.next()
    out.push(
      frames.messageStart(id),
      frames.messageEnd(id, assistantMessage({ stopReason: "error", errorMessage: turn.error.message, errorStatus: turn.error.status, usage: usageOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) })),
      frames.promptResult("$promptId", "error", { error: { message: turn.error.message, ...(turn.error.status === undefined ? {} : { httpStatus: turn.error.status }) } }),
    )
  } else {
    out.push(frames.promptResult("$promptId", "completed"))
  }
  out.push(frames.settled())
  return out
}

function usageOf(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function messageOf(step: StepScript, id: string): unknown[] {
  const tools = step.tools ?? []
  const asked = step.ask
  return [
    frames.messageStart(id),
    ...(step.notice ? [{ type: "notice", level: step.notice.level, message: step.notice.message }] : []),
    ...(step.text ? [frames.textDelta(id, 0, step.text)] : []),
    ...(asked?.kind === "permission" ? [frames.approval(asked.id, `Allow tool: ${asked.action}\n${asked.resource}`), { waitFor: "extension_ui_response" }] : []),
    ...(asked?.kind === "question"
      ? [
          {
            type: "extension_ui_request",
            id: asked.id,
            method: "ask",
            questions: [{ id: "q", question: asked.question, header: asked.header, options: asked.options.map((label) => ({ label })), multi: false }],
          },
          { waitFor: "extension_ui_response" },
        ]
      : []),
    ...(step.delayMs ? [{ delayMs: step.delayMs }] : []),
    ...(step.hang ? [{ hang: true }] : []),
    frames.messageEnd(
      id,
      assistantMessage({
        texts: step.text ? [step.text] : [],
        tools: tools.map((tool) => ({ id: tool.id, name: tool.name, arguments: tool.input })),
        usage: usageOf(step.usage ?? DEFAULT_USAGE),
        stopReason: tools.length ? "toolUse" : "stop",
      }),
    ),
    ...tools.flatMap((tool) => [frames.toolStart(tool.id, tool.name, tool.input), frames.toolEnd(tool.id, tool.name, tool.output)]),
  ]
}

async function startHost(): Promise<ContractInstance> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flow-engine-contract-")))
  const project = path.join(dir, "project")
  const stateDir = path.join(dir, "state")
  const configDir = path.join(dir, "profile", "agent")
  const scriptFile = path.join(dir, "script.json")
  const logFile = path.join(dir, "stub.log")
  const pidFile = path.join(dir, "pids")
  mkdirSync(project)
  writeFileSync(scriptFile, "[]")
  writeFileSync(logFile, "")

  // `omp --version` and `omp config path` are answered here; everything else is the RPC stub.
  // Each run records its pid first: `exec` keeps it, so these are the stub processes.
  const wrapper = path.join(dir, "omp")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac',
      `case " $* " in *" config path "*) echo "${configDir}"; exit 0;; esac`,
      `echo $$ >> "${pidFile}"`,
      `export STUB_OMP_SCRIPT="${scriptFile}" STUB_OMP_LOG="${logFile}"`,
      `exec "${process.execPath}" "${STUB_OMP}" "$@"`,
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)

  const host = createHost({
    project: () => project,
    allowRemote: false,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENFLOW_STATE_DIR: stateDir },
  })
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      // The same order as `server.ts`: the gate first, then the host modules.
      const refused = await host.gate(request)
      if (refused) return refused
      return (await host.handle(request)) ?? new Response("unclaimed", { status: 418 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const saved = await fetch(`${base}${OMP_ROUTES.settings}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ binary: wrapper, swarm: { mode: "off" } }),
  })
  if (!saved.ok) throw new Error(`saving the omp settings failed (${saved.status})`)
  setOrigin(base)

  const pids = () =>
    existsSync(pidFile)
      ? readFileSync(pidFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(Number)
      : []

  const api: EngineSurface = {
    subscribe,
    createSession,
    prompt,
    waitForIdle,
    transcript,
    interrupt,
    release,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    accepts,
    models,
    describe,
    sessionSteps,
    sessionCalls,
    sessionTranscript,
    sessions,
    releaseRun,
    health,
    async active() {
      const response = await fetch(`${base}${engineRoutes.active}`)
      return (await response.json()) as string[]
    },
  }

  const messages = { count: 0 }
  const driver: ContractDriver = {
    script(turn) {
      writeFileSync(scriptFile, JSON.stringify(framesOf(turn, { next: () => `m${++messages.count}` })))
      writeFileSync(logFile, "")
    },
    async decision(requestID) {
      const answered = readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((frame) => frame.type === "extension_ui_response" && frame.id === requestID)
      if (!answered) return undefined
      if (answered.cancelled === true) return { kind: "cancelled" } satisfies Decision
      if (typeof answered.value === "string") {
        const reply = answered.value === "Deny" ? "reject" : answered.value === "Approve" ? "once" : "always"
        return { kind: "permission", reply } satisfies Decision
      }
      const given = (answered.answers ?? []) as Array<{ selectedOptions?: string[]; customInput?: string }>
      return { kind: "question", answers: given.map((answer) => [...(answer.selectedOptions ?? []), ...(answer.customInput ? [answer.customInput] : [])]) } satisfies Decision
    },
  }

  const closing = { done: undefined as Promise<void> | undefined }
  const gone = { pids: [] as number[] }
  return {
    api,
    driver,
    directory: project,
    close() {
      closing.done ??= (async () => {
        await host.dispose()
        await server.stop(true)
        gone.pids = pids()
        setOrigin("")
        rmSync(dir, { recursive: true, force: true })
      })()
      return closing.done
    },
    async leftovers() {
      await closing.done
      if (!gone.pids.length) throw new Error("the wrapper recorded no omp process, so a clean exit proves nothing")
      // Every process the wrapper ever started: a stub that outlives `dispose` is an orphan.
      await until(async () => !(await Promise.all(gone.pids.map(alive))).some(Boolean), 5_000).catch(() => undefined)
      const survivors = await Promise.all(gone.pids.map(async (pid) => ((await alive(pid)) ? String(pid) : undefined)))
      return survivors.filter((pid) => pid !== undefined)
    },
  }
}

// Skipped as a whole where the wrapper cannot run, never silently per scenario.
defineEngineContract("browser client over HTTP to the Omp host (stub omp)", startHost, { skip: !posix })
