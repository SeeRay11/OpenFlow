import { accessSync, constants, realpathSync } from "node:fs"
import path from "node:path"
import { MIN_OMP_VERSION, type OmpProblem, type OmpSettings, type OmpStatus } from "../../shared/omp"
import type { Flight, Lifecycle } from "../host/lifecycle"
import { runProbe } from "../host/probe"
import { filterEnv } from "./env"

/**
 * Finding omp and proving it runs.
 *
 * Shared by the launch builder, the settings status, the model catalog and the
 * terminal, so there is exactly one answer to "which omp, and is it new enough".
 * Runs under both hosts — Bun (`server.ts`) and Node (the vite dev plugin) — so
 * it uses `node:` APIs only.
 */

const CACHE_MS = 30_000
const VERSION_TIMEOUT_MS = 5_000

let cached: { key: string; at: number; status: OmpStatus } | undefined

/** `omp/18.12.2`, `18.12.2` or anything containing a semver triple. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version)
  const want = parseVersion(minimum)
  if (!have || !want) return false
  for (let index = 0; index < 3; index++) {
    if (have[index] !== want[index]) return have[index]! > want[index]!
  }
  return true
}

/**
 * Absolute, symlink-resolved path of the omp binary: the one the settings name
 * (it must be absolute and executable), else the first `omp` on PATH.
 */
export function resolveBinary(settings: Pick<OmpSettings, "binary">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp.bat", "omp"] : ["omp"]
  const candidates = settings.binary
    ? [settings.binary]
    : (env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) => names.map((name) => path.join(directory, name)))

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Not here; try the next candidate.
    }
  }
  return undefined
}

/**
 * The probe runs the user-chosen binary: it gets the same allowlisted environment as a card, never the whole host environment.
 * It leads its own process group on POSIX so a stop (the owner's `dispose`) takes a wrapper script's children with it.
 */
async function readVersion(binary: string, env: NodeJS.ProcessEnv, flight?: Flight): Promise<string | undefined> {
  const result = await runProbe(binary, ["--version"], { env: filterEnv(env), timeoutMs: VERSION_TIMEOUT_MS, flight })
  if (result.code !== 0) throw new Error(`${binary} --version exited with ${result.code}`)
  return parseVersion(result.stdout)?.join(".")
}

/**
 * Whether omp is usable, as the status the settings dialog and every run
 * preflight read. Cached for 30 seconds per (binary setting, profile, PATH):
 * a version probe is a process spawn and the answer rarely changes.
 *
 * With `life` the probe is one of its flights: a closed lifecycle refuses a new probe with its 503, and a probe it
 * stopped is never cached as "omp did not answer".
 */
export async function checkOmp(settings: OmpSettings, env: NodeJS.ProcessEnv = process.env, life?: Lifecycle): Promise<OmpStatus> {
  life?.assertOpen()
  const key = `${settings.binary}|${settings.profile}|${env.PATH ?? ""}`
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.status

  const problems: OmpProblem[] = []
  const binary = resolveBinary(settings, env)
  let version: string | undefined

  if (!binary) {
    problems.push({
      code: "missing",
      message: settings.binary ? `omp was not found at ${settings.binary}.` : "omp is not on PATH.",
      fix: "Install omp (bun add -g @oh-my-pi/pi-coding-agent) or set its binary path in Omp settings.",
    })
  }
  if (binary) {
    const probe = life ? life.run((flight) => readVersion(binary, env, flight)) : readVersion(binary, env)
    version = await probe.catch(() => undefined)
    life?.assertOpen()
    if (!version) {
      problems.push({
        code: "spawn",
        message: `\`${binary} --version\` did not answer.`,
        fix: "Run it in the terminal to see why, or point Omp settings at a working binary.",
      })
    }
    if (version && !versionAtLeast(version, MIN_OMP_VERSION)) {
      problems.push({
        code: "version",
        message: `omp ${version} is older than the ${MIN_OMP_VERSION} OpenFlow needs.`,
        fix: "Update omp (`omp update`) and run again.",
      })
    }
  }

  const status: OmpStatus = {
    available: problems.length === 0,
    binary,
    version,
    minVersion: MIN_OMP_VERSION,
    profile: settings.profile,
    problems,
    checkedAt: Date.now(),
  }
  cached = { key, at: Date.now(), status }
  return status
}

/** Forget the cached status — after the settings change which binary or profile is in use. */
export function resetOmpCheck() {
  cached = undefined
}
