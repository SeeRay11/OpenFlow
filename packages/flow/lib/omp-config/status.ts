import type { OmpProblem, OmpSettings, OmpStatus } from "../../shared/omp"
import { checkOmp } from "../omp/binary"
import { childEnv, firstLine, profileArgs, type Run } from "./config"
import type { Providers } from "./providers"

export type StatusDeps = { run: Run; env: NodeJS.ProcessEnv; providers: Providers }

export type StatusChecker = {
  status(settings: OmpSettings): Promise<OmpStatus>
  /**
   * The profile's omp config directory, from the same cached `config path` answer `status` uses. Never
   * touches the provider list, so the credential stamp can call it from inside a provider read.
   */
  configDir(settings: OmpSettings, binary: string): Promise<string | undefined>
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
  const dirs = new Map<string, Promise<string | undefined>>()

  function configDir(settings: OmpSettings, binary: string): Promise<string | undefined> {
    const key = `${binary}|${settings.profile}`
    const known = dirs.get(key)
    if (known) return known
    const found = deps
      .run(binary, [...profileArgs(settings), "config", "path"], childEnv(deps.env))
      .then(
        (result) => (result.code === 0 ? result.stdout.trim() || undefined : undefined),
        () => undefined,
      )
    dirs.set(key, found)
    // A failed lookup is not remembered: the next call asks again.
    void found.then((dir) => {
      if (!dir && dirs.get(key) === found) dirs.delete(key)
    })
    return found
  }

  return {
    reset: () => dirs.clear(),
    configDir,
    async status(settings) {
      const base = await checkOmp(settings, deps.env)
      const status: OmpStatus = { ...base, problems: [...base.problems], checkedAt: Date.now() }
      const binary = base.binary
      if (!binary || status.problems.length) return status

      const profile = settings.profile || "default"
      const dir = await configDir(settings, binary)
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
            fix: "Use the Copy logins button in Omp settings, or open the terminal and run /login.",
          })
        }
        if (authenticated.length && !authenticated.some((row) => row.available)) {
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
