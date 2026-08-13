/**
 * Who is allowed to reach the store.
 *
 * `/flow/api` writes pipelines and run logs into the project and merges agents
 * into its `opencode.json`, and nothing authenticates the caller. On loopback
 * that is the user talking to their own machine. Bound to a real interface it
 * is a remote file-write hole in whatever repository OpenFlow is pointed at, so
 * both hosts — the vite dev server and `server.ts` — refuse unless it is asked
 * for explicitly.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

/** Vite's `server.host`: `undefined`/`false` keep it local, `true` exposes it. */
export function isLoopback(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return true
  if (host === true) return false
  return LOOPBACK.has(host.trim().toLowerCase())
}

export function allowsRemote(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLOW_ALLOW_REMOTE === "1"
}

/**
 * The reason to refuse this bind, or undefined when it is fine. Callers fail
 * closed: the dev server does not start and `server.ts` exits.
 */
export function remoteBindRefusal(options: {
  host: string | boolean | undefined
  project: string
  env?: Record<string, string | undefined>
}): string | undefined {
  if (isLoopback(options.host) || allowsRemote(options.env)) return undefined
  const host = options.host === true ? "every interface" : String(options.host)
  return (
    `refusing to serve OpenFlow on ${host}: the /flow/api store writes files into ${options.project} ` +
    `and merges into its opencode.json, with no authentication.\n` +
    `set FLOW_ALLOW_REMOTE=1 if that is genuinely what you want.`
  )
}
