export const HARNESS_ROUTES = {
  health: "/flow/api/harness/health",
  plugins: "/flow/api/harness/plugins",
  secrets: "/flow/api/harness/secrets",
} as const

export type GsdHealth = {
  installed: boolean
  version: string | null
  health: "ok" | "missing" | "unreadable"
  detail: string
}

export type PluginBinding = {
  id: string
  enabled: boolean
  cardId?: string
  config: Record<string, string | number | boolean>
}

export type FieldError = { path: string; message: string }

export type PluginValidation = { ok: true; plugins: PluginBinding[] } | { ok: false; fields: FieldError[] }
