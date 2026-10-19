/**
 * Pure argv/URL resolution for the cross-platform launcher (`openflow.ts` at
 * the repo root). Kept here, testable, with no real I/O: the launcher itself
 * spawns the process, but every decision about *what* to spawn and *whether*
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
 * `vite build` before the static host has anything to serve. That is why the
 * canvas runs `serve` and not `start`: `start` builds too, and building twice
 * per launch is pure waiting.
 */
export type ChildPlan = { argv: string[]; skip: boolean; prebuild?: string[] }

export type LaunchPlan = {
  canvas: ChildPlan
  canvasUrl: string
  /** Serving `dist/` through `server.ts` instead of running vite. */
  built: boolean
}

const CANVAS_URL = "http://localhost:5174"

/** Shims set `1`; treat an explicit off value as off rather than as "present". */
const enabled = (value: string | undefined) => {
  const flag = value?.trim().toLowerCase()
  return !!flag && flag !== "0" && flag !== "false"
}

/**
 * `probe(url)` answers "is something already serving this URL?" — injected so
 * the test controls it and production passes a real reachability check. A
 * canvas whose port already answers is marked `skip: true`, matching the
 * "check before starting your own" rule: never start a second canvas.
 */
export async function launchPlan(input: {
  env: LaunchEnv
  repo: string
  probe?: (url: string) => Promise<boolean>
}): Promise<LaunchPlan> {
  const probe = input.probe ?? (async () => false)
  const built = enabled(input.env.OPENFLOW_BUILT)
  const canvasUp = await probe(CANVAS_URL)

  return {
    canvas: built
      ? {
          argv: ["bun", "run", "--cwd", "packages/flow", "serve"],
          prebuild: ["bun", "run", "--cwd", "packages/flow", "build"],
          skip: canvasUp,
        }
      : { argv: ["bun", "--cwd", "packages/flow", "dev"], skip: canvasUp },
    canvasUrl: CANVAS_URL,
    built,
  }
}
