import type { FieldError, PluginBinding, PluginValidation } from "../../shared/harness"

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const SECRET = /token|secret|password|api[-_]?key|authorization|credential/i

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validatePlugins(input: unknown): PluginValidation {
  const fields: FieldError[] = []
  if (!Array.isArray(input)) return { ok: false, fields: [{ path: "plugins", message: "plugins must be a list" }] }
  if (input.length > 32) fields.push({ path: "plugins", message: "at most 32 plugins" })
  const plugins: PluginBinding[] = []
  input.forEach((row, index) => {
    const base = `plugins.${index}`
    if (!isObject(row)) {
      fields.push({ path: base, message: "plugin must be an object" })
      return
    }
    if (typeof row.id !== "string" || !ID.test(row.id)) fields.push({ path: `${base}.id`, message: "id must be 1-64 letters, digits, dots, underscores, or hyphens" })
    if (typeof row.enabled !== "boolean") fields.push({ path: `${base}.enabled`, message: "enabled must be true or false" })
    if (row.cardId !== undefined && (typeof row.cardId !== "string" || row.cardId.length < 1 || row.cardId.length > 81)) {
      fields.push({ path: `${base}.cardId`, message: "cardId must be 1-81 characters" })
    }
    const config: Record<string, string | number | boolean> = {}
    if (row.config !== undefined && !isObject(row.config)) fields.push({ path: `${base}.config`, message: "config must be an object" })
    if (isObject(row.config)) {
      const keys = Object.keys(row.config)
      if (keys.length > 16) fields.push({ path: `${base}.config`, message: "at most 16 config fields" })
      for (const key of keys) {
        if (SECRET.test(key)) {
          fields.push({ path: `${base}.config.${key}`, message: "put credentials in the harness secret file, not plugin config" })
          continue
        }
        const value = row.config[key]
        if (typeof value === "string" && value.length > 200) fields.push({ path: `${base}.config.${key}`, message: "value is longer than 200 characters" })
        else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          fields.push({ path: `${base}.config.${key}`, message: "value must be a string, number, or boolean" })
        } else config[key] = value as string | number | boolean
      }
    }
    if (typeof row.id === "string" && typeof row.enabled === "boolean") {
      plugins.push({ id: row.id, enabled: row.enabled, ...(typeof row.cardId === "string" ? { cardId: row.cardId } : {}), config })
    }
  })
  if (fields.length) return { ok: false, fields }
  return { ok: true, plugins }
}

export function cardsBlockedByPlugins(plugins: PluginBinding[], required: { cardId: string; pluginId: string }[]) {
  const blocked: { cardId: string; pluginId: string; message: string }[] = []
  for (const need of required) {
    const match = plugins.find((plugin) => plugin.id === need.pluginId && (plugin.cardId === undefined || plugin.cardId === need.cardId))
    if (!match) blocked.push({ cardId: need.cardId, pluginId: need.pluginId, message: `plugin ${need.pluginId} is not configured for this card` })
    else if (!match.enabled) blocked.push({ cardId: need.cardId, pluginId: need.pluginId, message: `plugin ${need.pluginId} is disabled` })
  }
  return blocked
}
