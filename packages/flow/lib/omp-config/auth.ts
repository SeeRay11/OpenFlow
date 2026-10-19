import type { OmpSettings } from "../../shared/omp"
import { HttpError } from "../host/respond"
import { redact, stripControl } from "../substrate/guard"
import { childEnv, RunTimeout, type Run, type RunResult } from "./config"
import { isRecord } from "./settings"

/**
 * Copies the logins of the user's default omp profile into OpenFlow's own
 * profile: `omp auth export` (default profile, no `--profile`) into memory, then
 * `omp --profile <p> auth import -` with that text on stdin. omp 18.12.2 exports
 * `{ "version": <number>, "credentials": [{ "provider": ..., "credential": ... }] }`.
 *
 * The export is credentials in clear text. It lives in one local string for the
 * length of the two calls: never in argv (every local user can read it), a file,
 * a log, a response or an error message. Failure text comes from the import's
 * stderr only, redacted and capped.
 */

const MESSAGE_CHARS = 300

export type Auth = {
  /** Resolves with the number of credentials copied; throws an `HttpError` otherwise. */
  copy(settings: OmpSettings, binary: string): Promise<number>
}

/** Stored credentials in an `omp auth export`, or undefined when the text is not that shape. */
function countCredentials(text: string): number | undefined {
  try {
    const exported: unknown = JSON.parse(text)
    if (isRecord(exported) && Array.isArray(exported.credentials)) return exported.credentials.length
  } catch {
    // Not JSON: reported below as an export this version does not understand.
  }
  return undefined
}

/** What the user may read of a failure's stderr: control characters, secret shapes and long opaque strings removed. */
function importFailure(stderr: string): string {
  const prefix = "Could not copy the logins: "
  const detail = redact(stripControl(stderr))
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Error:\s*/, "")
  return `${prefix}${detail || "omp failed"}`.slice(0, MESSAGE_CHARS)
}

export function createAuth(deps: { run: Run; env: NodeJS.ProcessEnv }): Auth {
  async function exec(binary: string, args: string[], input?: string): Promise<RunResult> {
    try {
      return await deps.run(binary, args, childEnv(deps.env), input)
    } catch (error) {
      if (error instanceof RunTimeout) throw new HttpError(502, "omp did not answer in time", "omp-timeout")
      throw new HttpError(502, "omp could not be run", "omp-failed")
    }
  }

  return {
    async copy(settings, binary) {
      if (!settings.profile)
        throw new HttpError(400, "The default profile is already in use, so there is nothing to copy.", "default-profile")

      const exported = await exec(binary, ["auth", "export"])
      const noLogins = new HttpError(
        400,
        "Your default omp profile has no logins to copy. Run omp and use /login there first.",
        "no-logins",
      )
      if (exported.code !== 0) throw noLogins
      const imported = countCredentials(exported.stdout)
      if (imported === undefined)
        throw new HttpError(502, "omp exported its logins in a form this version of OpenFlow does not understand.", "omp-failed")
      if (imported === 0) throw noLogins

      const result = await exec(binary, ["--profile", settings.profile, "auth", "import", "-"], exported.stdout)
      if (result.code !== 0) throw new HttpError(502, importFailure(result.stderr), "omp-failed")
      return imported
    },
  }
}
