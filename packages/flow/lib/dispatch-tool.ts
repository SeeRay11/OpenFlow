import path from "node:path"

/**
 * Registers OpenFlow's dispatch MCP server so an orchestrator card can call it.
 *
 * The server itself is `mcp/dispatch.ts` in this package, and the reason it
 * exists is in its header: measured against real providers, a text-only control
 * protocol loses three ways, and the third — a good model trying to *call*
 * `dispatch` as a tool — says plainly what models want the channel to be.
 *
 * It has to be the **global** config, for the same reason the provider
 * repackage does: a session's location is the engine's cwd, never
 * `OPENFLOW_PROJECT` (see FLOW.md), so a project `opencode.json` reaches the
 * catalog reads the browser makes and never the drain that runs the card. The
 * global config is loaded for both.
 *
 * Nothing here is written without an explicit request from the panel, and the
 * file is backed up first, because this is the user's machine-wide config.
 */

export const SERVER_NAME = "openflow"

/**
 * How opencode is told to start it.
 *
 * `runtime` is an absolute path to the bun binary, not the bare word `bun`.
 * opencode spawns a local MCP server without a shell, and a bare command on
 * Windows is not resolved through PATHEXT — measured: the card was offered
 * `openflow_dispatch`, called it correctly, and got "Unknown tool" back because
 * the server had never started. The host passes `process.execPath`, which is
 * the bun already running it.
 */
export function serverEntry(packageRoot: string, runtime: string) {
  return {
    type: "local" as const,
    command: [runtime, path.join(packageRoot, "mcp", "dispatch.ts")],
    enabled: true,
  }
}

/**
 * Whether this config already starts our server, and from the right file.
 *
 * A stale entry — one pointing at a checkout that has moved — is worse than no
 * entry: the card is told the tool exists, the spawn fails, and the failure
 * reads as a broken model. So the command is compared, not just the name.
 */
export function installed(config: any, packageRoot: string, runtime: string) {
  const entry = config?.mcp?.[SERVER_NAME]
  if (!entry) return { present: false, current: false }
  const want = serverEntry(packageRoot, runtime).command
  const have: string[] = Array.isArray(entry.command) ? entry.command : []
  return { present: true, current: have.length === want.length && have.every((part, index) => part === want[index]) }
}

/**
 * Adds or repoints the server. Returns whether anything changed, so a caller
 * can skip the write — and the engine restart — when it would be a no-op.
 *
 * `mcp` is the same key in both config dialects, so unlike the provider
 * repackage this needs no v1/v2 branch.
 */
export function install(config: any, packageRoot: string, runtime: string) {
  const state = installed(config, packageRoot, runtime)
  if (state.current) return { changed: false, value: config }
  return {
    changed: true,
    value: { ...config, mcp: { ...(config?.mcp ?? {}), [SERVER_NAME]: serverEntry(packageRoot, runtime) } },
  }
}

/** Removes the server, for a user who wants their config back. */
export function uninstall(config: any) {
  if (!config?.mcp?.[SERVER_NAME]) return { changed: false, value: config }
  const mcp = { ...config.mcp }
  delete mcp[SERVER_NAME]
  return { changed: true, value: { ...config, mcp } }
}
