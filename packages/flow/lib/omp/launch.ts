import path from "node:path"
import { filterEnv } from "./env"
import type { BuildLaunch, LaunchInput, LaunchSpec } from "./rpc-types"

/**
 * One card -> one `omp --mode rpc-ui` command line, its per-session files and
 * its environment. Pure: nothing here touches the filesystem or spawns; the
 * RPC core (`spawnOmp`) writes `files` and runs `argv`.
 *
 * Every flag below exists in `omp --help` (18.12.2). Tool toggles are enforced
 * with `tools.approval.<tool>: "deny"` in the settings overlay, not with
 * `--tools`. Probed against the real binary with a `-e` extension and
 * `set_host_tools`: host tools mount (`xd://`) either way, but `--tools read`
 * shrinks the active set to the named tools, so an extension's tool disappears
 * unless it is listed by name. A user deny always wins, in every approval mode
 * (omp://approval-mode.md), and leaves everything else untouched.
 */

/**
 * The `--model` pattern of the throwaway probe processes (provider list, model
 * catalog). An `omp --mode rpc` process aborts at startup when the profile has
 * no default model; the probes never prompt, and any pattern that matches the
 * catalog starts omp (it fuzzy-matches `--model`), so a one-letter pattern
 * cannot go stale when model names change. Cards never use it: a card without
 * a model must omit `--model` (the user's configured default).
 */
export const PROBE_MODEL = "a"

type Overlay = Record<string, unknown>

/** OpenFlow's tool vocabulary -> the omp tool names a `false` toggle denies. `skill` and `webfetch` have none: see `describeLaunch`. */
const OMP_TOOLS: Record<string, string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  edit: ["edit", "write", "ast_edit"],
  bash: ["bash", "eval"],
  websearch: ["web_search"],
  todowrite: ["todo"],
  question: ["ask"],
}

/** The signing key reaches the swarm extension by name from the host environment; its value never touches argv or a file. */
const SIGNING_KEYS = ["SWARM_ED25519_KEY", "SWARM_ED25519_KEY_FILE", "SWARM_SIGNING_KEY", "SWARM_REQUIRE_KEY"]

/** Identity of a swarm child: only the swarm extension itself may set these, never the launcher. */
const SWARM_IDENTITY = ["SWARM_AGENT", "SWARM_TASK_ID", "SWARM_CHILD"]

function isTree(value: unknown): value is Overlay {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Objects merge key by key; anything else (arrays included) in `patch` replaces. */
function merge(base: Overlay, patch: Overlay): Overlay {
  const out: Overlay = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = isTree(current) && isTree(value) ? merge(current, value) : value
  }
  return out
}

function disabled(tools: Record<string, boolean> | undefined) {
  return Object.entries(tools ?? {})
    .filter(([, enabled]) => enabled === false)
    .map(([name]) => name)
}

/** What OpenFlow asked for that omp cannot enforce per card, so the host can surface it instead of silently widening. */
export function describeLaunch(input: LaunchInput): { notes: string[] } {
  const notes: string[] = []
  for (const name of disabled(input.session.card.tools)) {
    if (name === "webfetch") {
      notes.push("webfetch is off but omp reads URLs with its `read` tool, which cannot be separated from file reads; `read` stays enabled")
      continue
    }
    if (name !== "skill" && !Object.hasOwn(OMP_TOOLS, name)) notes.push(`tool toggle "${name}" is off but has no omp equivalent; it stays enabled`)
  }
  return { notes }
}

export const buildLaunch: BuildLaunch = (input): LaunchSpec => {
  const session = input.session
  const settings = input.settings
  const swarm = input.swarm
  const stateDir = input.stateDir
  const auto = session.permissions === "auto"
  const roleFile = path.join(stateDir, "role.md")
  const overlayFile = path.join(stateDir, "overlay.yml")
  const denied = disabled(session.card.tools).flatMap((name) => (Object.hasOwn(OMP_TOOLS, name) ? OMP_TOOLS[name] : []))
  const toolDenies: Overlay = denied.length ? { tools: { approval: Object.fromEntries(denied.map((tool) => [tool, "deny"])) } } : {}

  const argv = [
    input.binary,
    "--mode",
    "rpc-ui",
    ...(auto ? ["--no-ui"] : []),
    "--no-title",
    "--session-dir",
    path.join(stateDir, "session"),
    "--cwd",
    session.directory,
    "--approval-mode",
    auto ? "yolo" : settings.manualApproval,
    "--max-time",
    `${Math.max(1, Math.floor(settings.maxSessionMinutes))}m`,
    ...(settings.profile ? ["--profile", settings.profile] : []),
    ...(settings.loadUserExtensions ? [] : ["--no-extensions"]),
    ...(session.card.tools?.skill === false ? ["--no-skills"] : []),
    ...(session.model ? ["--model", session.model] : []),
    "--append-system-prompt",
    roleFile,
    "--config",
    overlayFile,
    ...(swarm?.args ?? []),
  ]

  const role = [session.card.prompt ?? "", swarm?.systemPrompt ?? ""].filter((part) => part.length > 0).join("\n\n")
  // The card's own denies go last: no overlay layered under them may turn a disabled tool back on.
  const overlay = [toolDenies, input.overlay ?? {}, swarm?.overlay ?? {}, toolDenies].reduce(merge, {})

  const extra: Record<string, string> = {}
  if (swarm && swarm.effective !== "off") {
    for (const name of SIGNING_KEYS) {
      const value = input.env[name]
      if (value !== undefined) extra[name] = value
    }
    for (const [name, value] of Object.entries(swarm.env)) {
      if (!SWARM_IDENTITY.includes(name)) extra[name] = value
    }
  }

  return {
    argv,
    env: filterEnv(input.env, {
      ...extra,
      OPENFLOW_RUN: session.runId,
      OPENFLOW_CARD: session.nodeId,
      ULTRATHINK_UPLIFT: "0",
      AIO_UPLIFT: "0",
      PI_NO_TITLE: "1",
      NO_COLOR: "1",
    }),
    cwd: session.directory,
    files: [
      { path: roleFile, content: role },
      // JSON is YAML; omp's overlay loader reads it as such (probed against omp 18.12.2).
      { path: overlayFile, content: `${JSON.stringify(overlay, null, 2)}\n` },
    ],
  }
}
