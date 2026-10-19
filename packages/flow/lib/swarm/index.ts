import fs from "node:fs"
import path from "node:path"
import type { OmpSettings } from "../../shared/omp"
import type { SwarmHost, SwarmPreflight } from "../../shared/swarm"
import type { HostHandler } from "../host/respond"
import { buildSwarmLaunch } from "./launch"
import { createPreflight } from "./preflight"
import { swarmRoutes } from "./routes"
import { createTracker } from "./tracker"

export type SwarmDeps = {
  settings(): Promise<OmpSettings>
  env?: NodeJS.ProcessEnv
  /** Interpreter for the python and cryptography probes; defaults to `python3`. */
  python?: string
}

const MAX_SESSIONS = 64
const SLUG = /^(a\d\d-[a-z-]+)\.md$/

/** What launch learned about a session that its tracker needs: the checkout (for the roster) and why the swarm is off. */
type Session = { root?: string; error?: string }

function degradation(preflight: SwarmPreflight): string | undefined {
  if (preflight.requested === "off" || preflight.effective !== "off") return undefined
  const problem = preflight.problems[0]
  return problem
    ? `Agent Swarm is off for this card: ${problem.message}${problem.fix ? ` ${problem.fix}` : ""}`
    : "Agent Swarm is off for this card."
}

/** Slugs of the checkout's `omp/agents/*.md`; empty when unreadable, which falls the tracker back to the slug shape. */
function readRoster(root: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(root, "omp", "agents")).flatMap((name) => SLUG.exec(name)?.[1] ?? []))
  } catch {
    return new Set()
  }
}

/** `dispose` refuses further preflights (503) and kills a probe in flight; the swarm's own processes belong to the sessions that launched them. */
export function createSwarmHost(deps: SwarmDeps): SwarmHost & { handle: HostHandler; dispose(): Promise<void> } {
  const env = deps.env ?? process.env
  const preflight = createPreflight({ python: deps.python })
  const sessions = new Map<string, Session>()
  const rosters = new Map<string, Set<string>>()

  return {
    async launch(input) {
      const result = buildSwarmLaunch({
        preflight: await preflight({ requested: input.mode, settings: input.settings, env: input.env, stateDir: input.stateDir }),
        stateDir: input.stateDir,
      })
      const key = path.resolve(input.stateDir)
      sessions.delete(key)
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
      sessions.set(key, { root: result.preflight.root, error: degradation(result.preflight) })
      return result
    },

    tracker(input) {
      const key = path.resolve(input.stateDir)
      const session = sessions.get(key)
      let roster = session?.root ? rosters.get(session.root) : undefined
      if (session?.root && !roster) {
        roster = readRoster(session.root)
        rosters.set(session.root, roster)
      }
      const tracker = createTracker({
        mode: session?.error ? "off" : input.mode,
        stateDir: input.stateDir,
        roster,
        error: session?.error,
      })
      return {
        ...tracker,
        dispose() {
          sessions.delete(key)
          return tracker.dispose()
        },
      }
    },

    handle: swarmRoutes({ settings: deps.settings, env, preflight }),
    dispose: preflight.dispose,
  }
}
