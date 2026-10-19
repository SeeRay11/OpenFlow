import fs from "node:fs"
import path from "node:path"
import type { SwarmLaunch, SwarmPreflight } from "../../shared/swarm"

/**
 * What agent-swarm contributes to one card's Omp launch.
 *
 * Deliberately absent from `env`: SWARM_AGENT, SWARM_TASK_ID and SWARM_CHILD
 * (they put the card's own top-level session under the swarm guard and disable
 * its HOOK-01 hint) and every signing variable. A signing key reaches the
 * child only through the launch builder's by-name passthrough of the host env;
 * its value never goes through this module.
 */

/**
 * Settings overlay for the card's `--config`. Verified against omp 18.12.2:
 * `omp config list --json` lists `task.maxRecursionDepth` (default 2) and
 * `task.isolation.enabled` (boolean, default false), and omp://settings.md
 * migrates the legacy `task.isolation.mode: none` to `enabled: false`.
 * Depth 2 is card -> A01 -> specialists. Isolation stays off because isolated
 * worktrees would split the Task Store.
 */
const OVERLAY = { task: { maxRecursionDepth: 2, isolation: { enabled: false } } }

/**
 * `always` is not the extension's `/swarm` command: that writes
 * `.claude/swarm-state.json` and appends to `.planning/STATE.md` in the cwd.
 */
const ALWAYS_PROMPT = [
  "Agent Swarm is enabled for this session.",
  "For software-delivery work (building, changing, fixing, reviewing or releasing code), do not implement it yourself:",
  'hand the whole brief to the swarm by calling the `task` tool once with `agent: "a01-orchestrator"` and the brief as the task,',
  "then report what it returns.",
  "Do not use the `/swarm` command and do not write inside `.swarm/` or `.omp/`.",
  "Answer questions and trivial lookups directly.",
].join(" ")

/** Creates the card's task store (0700, outside the worktree). Returns its absolute path, or undefined when it cannot be made. */
function ensureStore(stateDir: string): string | undefined {
  const store = path.join(path.resolve(stateDir), "swarm")
  try {
    fs.mkdirSync(store, { recursive: true, mode: 0o700 })
    fs.chmodSync(store, 0o700)
    return store
  } catch {
    return undefined
  }
}

export function buildSwarmLaunch(input: { preflight: SwarmPreflight; stateDir: string }): SwarmLaunch {
  const preflight = input.preflight
  const off = (degraded: SwarmPreflight): SwarmLaunch => ({
    effective: "off",
    args: [],
    env: {},
    overlay: {},
    systemPrompt: "",
    stateDir: path.join(path.resolve(input.stateDir), "swarm"),
    preflight: degraded,
  })

  if (preflight.effective === "off" || !preflight.root) return off(preflight)

  const store = ensureStore(input.stateDir)
  if (!store) {
    // preflight proved the directory creatable; losing the race is still a degrade, not a throw
    return off({
      ...preflight,
      ok: false,
      effective: "off",
      problems: [
        ...preflight.problems,
        {
          code: "bad-state-dir",
          message: `The swarm task-store directory could not be created under ${path.resolve(input.stateDir)}.`,
          fix: "Point OPENFLOW_STATE_DIR at a directory this user can write to.",
        },
      ],
    })
  }

  return {
    effective: preflight.effective,
    args: ["-e", path.join(preflight.root, "omp")],
    env: { SWARM_DIR: store, SWARM_ROOT: preflight.root },
    overlay: structuredClone(OVERLAY),
    systemPrompt: preflight.effective === "always" ? ALWAYS_PROMPT : "",
    stateDir: store,
    preflight,
  }
}
