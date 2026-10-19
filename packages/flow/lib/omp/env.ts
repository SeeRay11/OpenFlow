/**
 * The environment a child of the host receives: an allowlist, not a copy.
 *
 * Omp cards and the terminal run user-directed code, so nothing reaches them
 * unless it is named here. The deny rules beat every allow rule: a Substrate,
 * Swarm, ultrathink or AIO variable, or anything ending in `_TOKEN` /
 * `_SECRET`, only gets through when the caller hands it over explicitly in
 * `extra` (the launch builder does that for the one signing key the swarm
 * extension needs). Provider keys (`*_API_KEY`) are allowed for omp cards:
 * omp resolves providers from the environment.
 */

const EXACT: Record<string, true> = {
  HOME: true,
  USER: true,
  LOGNAME: true,
  SHELL: true,
  LANG: true,
  TERM: true,
  COLORTERM: true,
  TMPDIR: true,
  TZ: true,
  SSH_AUTH_SOCK: true,
}

// Windows variable names are case-insensitive and proxy variables travel in both cases.
const EXACT_ANY_CASE: Record<string, true> = {
  PATH: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  ALL_PROXY: true,
  NO_PROXY: true,
  REQUESTS_CA_BUNDLE: true,
  SYSTEMROOT: true,
  COMSPEC: true,
  PATHEXT: true,
  USERPROFILE: true,
  APPDATA: true,
  LOCALAPPDATA: true,
}

const PREFIXES = ["LC_", "XDG_", "PI_", "OMP_", "BUN_", "NODE_", "GIT_", "SSL_CERT_"]

const DENIED_PREFIXES = ["SUBSTRATE_", "SWARM_", "ULTRATHINK_", "AIO_"]
const DENIED_SUFFIXES = ["_TOKEN", "_SECRET"]

const API_KEY = /^[A-Z0-9_]+_API_KEY$/

function inherit(host: NodeJS.ProcessEnv, apiKeys: boolean) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    if (DENIED_SUFFIXES.some((suffix) => upper.endsWith(suffix))) continue
    // Before any prefix allow: `PI_` and `OMP_` would otherwise carry `PI_API_KEY` into a shell.
    if (!apiKeys && upper.endsWith("_API_KEY")) continue
    const allowed =
      Object.hasOwn(EXACT, name) ||
      Object.hasOwn(EXACT_ANY_CASE, upper) ||
      PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      (apiKeys && API_KEY.test(name))
    if (allowed) env[name] = value
  }
  return env
}

/** The child environment for an omp card: the allowlisted host variables, then `extra` on top. */
export function filterEnv(host: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  return { ...inherit(host, true), ...extra }
}

/** The environment for an interactive shell: the same allowlist without provider keys, and a terminal that can draw. */
export function terminalEnv(host: NodeJS.ProcessEnv): Record<string, string> {
  return { ...inherit(host, false), TERM: "xterm-256color", COLORTERM: "truecolor" }
}
