import type { OmpProblem, OmpSettings, OmpStatus, OmpStatusView } from "../../shared/omp"
import { checkOmp } from "../omp/binary"
import { childEnv, firstLine, profileArgs, type Run } from "./config"
import type { Providers } from "./providers"

export type StatusDeps = { run: Run; env: NodeJS.ProcessEnv; providers: Providers }

export type StatusChecker = {
  status(settings: OmpSettings): Promise<OmpStatus>
  reset(): void
}

/**
 * Whether omp is usable for cards, in the order a user fixes things: the
 * binary, then its version, then the profile's directory and credentials.
 * Binary and version come from `checkOmp` (cached 30 s there); the profile
 * directory never changes for a (binary, profile) pair, so it is kept until
 * the settings change.
 */
export function createStatusChecker(deps: StatusDeps): StatusChecker {
  const dirs = new Map<string, string>()

  return {
    reset: () => dirs.clear(),
    async status(settings) {
      const base = await checkOmp(settings, deps.env)
      const status: OmpStatus = { ...base, problems: [...base.problems], checkedAt: Date.now() }
      const binary = base.binary
      if (!binary || status.problems.length) return status

      const profile = settings.profile || "default"
      const key = `${binary}|${settings.profile}`
      let dir = dirs.get(key)
      if (!dir) {
        const result = await deps
          .run(binary, [...profileArgs(settings), "config", "path"], childEnv(deps.env))
          .catch(() => undefined)
        dir = result?.code === 0 ? result.stdout.trim() : undefined
        if (dir) dirs.set(key, dir)
      }
      if (dir) status.configDir = dir

      const problems: OmpProblem[] = []
      try {
        const rows = await deps.providers.list(settings, binary)
        const authenticated = rows.filter((row) => row.authenticated)
        status.providers = { authenticated: authenticated.length, total: rows.length }
        if (!authenticated.length) {
          problems.push({
            code: "no-credentials",
            message: `The ${profile} profile has no credentials.`,
            fix: "Open the terminal and run /login.",
          })
        } else if (!authenticated.some((row) => row.available)) {
          problems.push({
            code: "no-models",
            message: `None of the ${profile} profile's authenticated providers can serve models.`,
            fix: "Open the terminal and run /login for a provider that is available, or check the provider's own status.",
          })
        }
      } catch (error) {
        problems.push({
          code: "profile",
          message: `Could not read the ${profile} profile's providers: ${firstLine(error instanceof Error ? error.message : String(error))}`,
          fix: "Check the profile name in Omp settings, or run omp in the terminal to see the error.",
        })
      }
      if (!dir)
        problems.push({
          code: "profile",
          message: `omp could not report the ${profile} profile's config directory.`,
          fix: "Check the profile name in Omp settings.",
        })
      status.problems = problems
      return status
    },
  }
}
