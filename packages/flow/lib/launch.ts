/**
 * Pure argv/URL resolution for the cross-platform launcher (`openflow.ts` at
 * the repo root). Kept here, testable, with no real I/O: the launcher itself
 * spawns the processes, but every decision about *what* to spawn and *whether*
 * to skip a process already serving its port lives in `launchPlan`, driven by
 * an injected `probe` so a unit test needs no live server.
 */

export type LaunchEnv = Record<string, string | undefined>

/** argv to spawn (cwd is always the repo root) and whether it can be skipped. */
export type ChildPlan = { argv: string[]; skip: boolean }

export type LaunchPlan = {
  engine: ChildPlan
  canvas: ChildPlan
  engineUrl: string
  canvasUrl: string
}

const DEFAULT_ENGINE_URL = "http://127.0.0.1:4096"
const CANVAS_URL = "http://localhost:5174"

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

  const engineArgv = [
    "bun",
    "run",
    "--cwd",
    "packages/opencode",
    "--conditions=browser",
    "src/index.ts",
    "serve",
    "--port",
    port,
  ]
  const canvasArgv = ["bun", "--cwd", "packages/flow", "dev"]

  const [engineUp, canvasUp] = await Promise.all([probe(engineUrl), probe(CANVAS_URL)])
  return {
    engine: { argv: engineArgv, skip: engineUp },
    canvas: { argv: canvasArgv, skip: canvasUp },
    engineUrl,
    canvasUrl: CANVAS_URL,
  }
}
