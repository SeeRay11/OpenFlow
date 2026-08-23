/**
 * Pure argv/URL resolution for the cross-platform launcher (`openflow.ts` at
 * the repo root). Kept here, testable, with no real I/O: the launcher itself
 * spawns the processes, but every decision about *what* to spawn and *whether*
 * to skip a process already serving its port lives in `launchPlan`, driven by
 * an injected `probe` so a unit test needs no live server.
 *
 * The shell shims (`openflow.ps1`, `openflow.sh`) hold no launcher logic at
 * all — they translate their platform-idiomatic flags into the environment
 * variables read here, so all three surfaces resolve to the same plan.
 */

export type LaunchEnv = Record<string, string | undefined>

/**
 * argv to spawn (cwd is always the repo root) and whether it can be skipped.
 * `prebuild` runs to completion first and must succeed — built mode needs
 * `vite build` before the static host has anything to serve.
 */
export type ChildPlan = { argv: string[]; skip: boolean; prebuild?: string[] }

export type LaunchPlan = {
  engine: ChildPlan
  canvas: ChildPlan
  engineUrl: string
  canvasUrl: string
  /** The canvas host owns `opencode serve`, so the launcher must not start one. */
  managed: boolean
  /** Serving `dist/` through `server.ts` instead of running vite. */
  built: boolean
}

const DEFAULT_ENGINE_URL = "http://127.0.0.1:4096"
const CANVAS_URL = "http://localhost:5174"

/** Shims set `1`; treat an explicit off value as off rather than as "present". */
const enabled = (value: string | undefined) => {
  const flag = value?.trim().toLowerCase()
  return !!flag && flag !== "0" && flag !== "false"
}

/**
 * `probe(url)` answers "is something already serving this URL?" — injected so
 * the test controls it and production passes a real reachability check. A
 * process whose port already answers is marked `skip: true`, matching the
 * "check before starting your own" rule: never start a second engine or canvas.
 */
export async function launchPlan(input: {
  env: LaunchEnv
  repo: string
  probe?: (url: string) => Promise<boolean>
}): Promise<LaunchPlan> {
  const engineUrl = input.env.OPENCODE_SERVER_URL?.trim() || DEFAULT_ENGINE_URL
  const port = new URL(engineUrl).port || "4096"
  const probe = input.probe ?? (async () => false)
  const managed = enabled(input.env.FLOW_MANAGE_SERVER)
  const built = enabled(input.env.OPENFLOW_BUILT)

  // Under FLOW_MANAGE_SERVER the canvas host spawns the engine and can restart
  // it from the UI — only the process that started it can, since the server has
  // no shutdown route. So the launcher neither starts nor waits for one: `skip`
  // here means "not ours to run", not "already up", hence no probe.
  const [engineUp, canvasUp] = await Promise.all([managed || probe(engineUrl), probe(CANVAS_URL)])

  return {
    engine: {
      argv: [
        "bun",
        "run",
        "--cwd",
        "packages/opencode",
        "--conditions=browser",
        "src/index.ts",
        "serve",
        "--port",
        port,
      ],
      skip: engineUp,
    },
    canvas: built
      ? {
          argv: ["bun", "run", "--cwd", "packages/flow", "start"],
          prebuild: ["bun", "run", "--cwd", "packages/flow", "build"],
          skip: canvasUp,
        }
      : { argv: ["bun", "--cwd", "packages/flow", "dev"], skip: canvasUp },
    engineUrl,
    canvasUrl: CANVAS_URL,
    managed,
    built,
  }
}
