/**
 * Omp as a configurable engine: status, OpenFlow's own settings, and the real
 * `omp config` surface. Host: `lib/omp-config`. Consumers: the Omp settings
 * dialog, the Omp launch builder, the uplift / memory / swarm modules.
 *
 * Two layers, deliberately separate:
 *  1. OpenFlow settings (`OmpSettings`) — what OpenFlow decides when it spawns
 *     omp: binary, profile, uplift / memory / swarm. Stored host-side in
 *     `<OPENFLOW_STATE_DIR>/omp-settings.json`. No secrets; tokens only ever come
 *     from the host environment.
 *  2. Omp's own configuration (`OmpConfigEntry`) — read and written through
 *     `omp config list|get|set|reset --json` against the configured profile, so
 *     omp itself validates it. The settings UI never invents an omp option.
 */

import type { SwarmMode } from "./swarm"

export const MIN_OMP_VERSION = "18.12.2"

export type OmpSettings = {
  /** Absolute path of the omp binary; empty resolves `omp` from PATH. */
  binary: string
  /**
   * Isolated omp profile the cards and the terminal run under (`--profile`):
   * its own auth, config and sessions, so OpenFlow never reads or rewrites the
   * user's default profile. Empty means omp's default profile.
   */
  profile: string
  /** Load the user's ambient omp extensions and plugins in cards. Off: `--no-extensions`. */
  loadUserExtensions: boolean
  /** `--approval-mode` when a run uses the manual permission policy. */
  manualApproval: "always-ask" | "write"
  /** `--max-time` for one card session, in minutes. */
  maxSessionMinutes: number
  uplift: {
    enabled: boolean
    /** Wall clock for the planner process group. */
    timeoutMs: number
    /** Let the planner draft clarifying questions (one more model call; cards run unattended). */
    hitl: boolean
    /** Absolute path of the claude-ultrathink checkout or plugin; empty uses ULTRATHINK_ROOT, then omp's plugin directory. */
    root: string
  }
  memory: {
    enabled: boolean
    ttl: "graph" | "30d" | "permanent"
    /** Most items folded into one card's prompt. */
    readLimit: number
    /** `owner/name` override for the `repo:` scope; empty derives it from the project's git remote. */
    repo: string
  }
  swarm: {
    mode: SwarmMode
    /** Absolute path of the agent-swarm checkout; empty uses SWARM_ROOT / ULTRATHINK_SWARM_ROOT. */
    root: string
  }
  substrate: {
    /** Empty uses SUBSTRATE_URL. */
    url: string
  }
}

export const DEFAULT_OMP_SETTINGS: OmpSettings = {
  binary: "",
  profile: "openflow",
  loadUserExtensions: false,
  manualApproval: "write",
  maxSessionMinutes: 480,
  uplift: { enabled: true, timeoutMs: 240_000, hitl: false, root: "" },
  memory: { enabled: true, ttl: "30d", readLimit: 8, repo: "" },
  swarm: { mode: "auto", root: "" },
  substrate: { url: "" },
}

/** Deep partial: the shape of a settings patch. */
export type OmpSettingsPatch = {
  [K in keyof OmpSettings]?: OmpSettings[K] extends object ? Partial<OmpSettings[K]> : OmpSettings[K]
}

export type ValidationError = {
  /** Dotted path into the settings object, e.g. `uplift.timeoutMs`. */
  path: string
  message: string
}

export type OmpProblem = {
  code: "missing" | "version" | "spawn" | "profile" | "no-credentials" | "no-models"
  message: string
  fix?: string
}

export type OmpStatus = {
  /** True when the binary resolved, ran `--version`, and satisfied `MIN_OMP_VERSION`. */
  available: boolean
  /** Absolute resolved binary. */
  binary?: string
  /** e.g. `18.12.2`. */
  version?: string
  minVersion: string
  profile: string
  /** The profile's config directory (`omp config path`). */
  configDir?: string
  providers?: { authenticated: number; total: number }
  problems: OmpProblem[]
  checkedAt: number
}

export type OmpConfigType = "boolean" | "number" | "enum" | "string" | "array" | "record"

export type OmpConfigEntry = {
  /** Dotted omp setting key, e.g. `tools.approvalMode`. */
  key: string
  type: OmpConfigType
  description: string
  value: unknown
  /** Allowed values for `enum`, when omp's text listing exposes them. */
  options?: string[]
  /** omp's own category heading. */
  group?: string
  /** omp redacted the value; show it as set, never reveal it. */
  redacted?: boolean
  /** False for types the UI does not edit as a scalar (array, record): shown read-only with a hint to use the terminal. */
  editable: boolean
}

export type OmpProviderRow = {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

export const OMP_ROUTES = {
  status: "/flow/api/omp/status",
  settings: "/flow/api/omp/settings",
  settingsReset: "/flow/api/omp/settings/reset",
  /** GET lists entries; PUT `/<key>` sets `{ value }`; POST `/<key>/reset` resets. */
  config: "/flow/api/omp/config",
  providers: "/flow/api/omp/providers",
  /** POST, no body: copies the default profile's logins into the configured profile. */
  authImport: "/flow/api/omp/auth/import",
} as const

/** Where a value actually comes from. Names of environment variables only, never their values. */
export type EffectiveSource = { from: "settings" | "env" | "default"; env?: string }

/** `GET OMP_ROUTES.settings`: the settings plus where each env-overridable value comes from. */
export type OmpSettingsView = {
  settings: OmpSettings
  /** Keyed by dotted settings path: only the paths an environment variable can stand in for. */
  effective: Record<string, EffectiveSource>
  warnings: string[]
}

/** `OmpStatus` as the route sends it: settings-file warnings ride along so the dialog can show them. */
export type OmpStatusView = OmpStatus & { warnings: string[] }

/** `POST OMP_ROUTES.authImport`: how many stored logins were copied, and the status afterwards. */
export type OmpAuthImportResult = { imported: number; status: OmpStatusView }
