import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { OmpSettings } from "../../shared/omp"
import type { SwarmMode, SwarmPreflight, SwarmProblem } from "../../shared/swarm"

/**
 * Can a card run with agent-swarm's Omp extension loaded, and if not, why not.
 *
 * Every check is value-free: the signing configuration is detected by the
 * presence of a variable or a file, never by reading it (agent-swarm's own
 * `swarm/envelope.py` is the only reader, and refuses to read inside agent
 * sessions). A missing signer is a hard degrade to `off` — the extension's
 * dispatch fails closed without one, and the unsigned development key
 * (`SWARM_ALLOW_INSECURE_DEV_KEY`) is deliberately never offered as a fix.
 *
 * Runs under both hosts (Bun and Node): `node:` APIs only.
 */

const CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 3_000

export type PreflightInput = {
  requested: SwarmMode
  settings: Pick<OmpSettings, "swarm">
  env: NodeJS.ProcessEnv
  /** Per-session directory; when given, `<stateDir>/swarm` must be creatable. */
  stateDir?: string
}

export type Preflight = (input: PreflightInput) => Promise<SwarmPreflight>

/** The agent-swarm checkout the settings or the environment name; undefined when none is configured. */
export function configuredRoot(settings: Pick<OmpSettings, "swarm">, env: NodeJS.ProcessEnv): string | undefined {
  const named = [settings.swarm.root, env.SWARM_ROOT, env.ULTRATHINK_SWARM_ROOT].map((value) => value?.trim()).find(Boolean)
  return named ? path.resolve(named) : undefined
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** `${XDG_CONFIG_HOME:-$HOME/.config}/agent-swarm/signing-key.hex`, the location `swarm/envelope.py` also honours. */
function conventionalKeyFile(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, ".config") : undefined)
  return base ? path.join(base, "agent-swarm", "signing-key.hex") : undefined
}

function signingConfigured(env: NodeJS.ProcessEnv): boolean {
  if (env.SWARM_ED25519_KEY || env.SWARM_SIGNING_KEY) return true
  const named = env.SWARM_ED25519_KEY_FILE
  if (named && isFile(named)) return true
  const conventional = conventionalKeyFile(env)
  return conventional !== undefined && isFile(conventional)
}

/** True when the command exits 0 within the probe budget. The probe never sees the host's secrets. */
function probe(python: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const done = Promise.withResolvers<boolean>()
  const clean = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", LANG: env.LANG ?? "C" }
  try {
    execFile(python, args, { timeout: PROBE_TIMEOUT_MS, env: clean, windowsHide: true }, (error) => done.resolve(!error))
  } catch {
    done.resolve(false) // execFile throws synchronously for an unusable path, e.g. one containing NUL
  }
  return done.promise
}

/**
 * Nearest existing ancestor must be a writable directory. Does not create
 * anything: a GET preflight must not leave directories behind.
 */
function stateDirProblem(stateDir: string): SwarmProblem | undefined {
  let current = path.resolve(stateDir, "swarm")
  for (;;) {
    try {
      if (!fs.statSync(current).isDirectory()) break
      fs.accessSync(current, fs.constants.W_OK)
      return undefined
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return {
    code: "bad-state-dir",
    message: `The swarm task-store directory cannot be created under ${path.resolve(stateDir)}.`,
    fix: "Point OPENFLOW_STATE_DIR at a directory this user can write to.",
  }
}

async function environmentProblems(root: string | undefined, python: string, env: NodeJS.ProcessEnv): Promise<SwarmProblem[]> {
  const problems: SwarmProblem[] = []
  if (!root) {
    problems.push({
      code: "no-root",
      message: "No agent-swarm checkout is configured.",
      fix: "Set the agent-swarm path in the Omp settings, or export SWARM_ROOT.",
    })
  } else if (!isFile(path.join(root, "omp", "package.json")) || !isFile(path.join(root, "scripts", "orch_plan.py"))) {
    problems.push({
      code: "bad-root",
      message: `${root} is not an agent-swarm checkout (omp/package.json or scripts/orch_plan.py is missing).`,
      fix: "Point the agent-swarm path at the repository root that contains omp/ and scripts/.",
    })
  }

  if (!(await probe(python, ["--version"], env))) {
    problems.push({
      code: "no-python",
      message: `${python} did not run; every swarm tool shells out to it.`,
      fix: "Install Python 3 and make python3 resolvable on the host PATH.",
    })
  } else if (!(await probe(python, ["-c", "import cryptography"], env))) {
    problems.push({
      code: "no-crypto",
      message: "Python cannot import `cryptography`, which Ed25519 assignment signing needs.",
      fix: "Install it for that interpreter: python3 -m pip install cryptography.",
    })
  }

  if (!signingConfigured(env)) {
    problems.push({
      code: "no-signing-key",
      message: "No assignment-signing key is configured; the swarm cannot dispatch specialists without one.",
      fix: "Provision SWARM_ED25519_KEY_FILE (or SWARM_ED25519_KEY / SWARM_SIGNING_KEY) in the host environment, then restart.",
    })
  }
  return problems
}

/**
 * Environment checks (root, python, cryptography, signing presence) are cached
 * for 30 s per (root, python, signing sources). The state directory is checked
 * every call: it differs per session and is a single stat.
 */
export function createPreflight(options: { python?: string; now?: () => number } = {}): Preflight {
  const python = options.python ?? "python3"
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; problems: Promise<SwarmProblem[]> }>()

  return async (input) => {
    const requested = input.requested
    if (requested === "off") return { ok: true, effective: "off", requested, problems: [] }

    const root = configuredRoot(input.settings, input.env)
    const key = JSON.stringify([
      root,
      python,
      Boolean(input.env.SWARM_ED25519_KEY),
      Boolean(input.env.SWARM_SIGNING_KEY),
      input.env.SWARM_ED25519_KEY_FILE ?? "",
      conventionalKeyFile(input.env) ?? "",
    ])
    const hit = cache.get(key)
    const entry = hit && now() - hit.at < CACHE_MS ? hit : { at: now(), problems: environmentProblems(root, python, input.env) }
    cache.set(key, entry)
    const problems = [...(await entry.problems)]

    const stateProblem = input.stateDir ? stateDirProblem(input.stateDir) : undefined
    if (stateProblem) problems.push(stateProblem)

    const result: SwarmPreflight = problems.length
      ? { ok: false, effective: "off", requested, problems }
      : { ok: true, effective: requested, requested, problems }
    return root ? { ...result, root } : result
  }
}
