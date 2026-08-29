import os from "node:os"
import path from "node:path"

/**
 * Makes OpenRouter, Groq and their OpenAI-compatible siblings dispatchable on
 * an engine whose runner cannot route their packages.
 *
 * `core/src/session/runner/model.ts` (`fromCatalogModel`) routes three API
 * shapes and nothing else: `@ai-sdk/openai`, `@ai-sdk/anthropic`, and
 * `@ai-sdk/openai-compatible` *with a url*. A model whose catalog entry names
 * `@openrouter/ai-sdk-provider` or `@ai-sdk/groq` therefore fails the moment a
 * node dispatches:
 *
 *   SessionRunnerModel.UnsupportedApiError: Unsupported API for
 *   groq/llama-3.3-70b-versatile: aisdk:@ai-sdk/groq
 *
 * Upstream's fix routes those by provider id through
 * `llm/src/providers/openai-compatible-profile.ts`, but this fork's vendored
 * runner does not consult that table. The fix that needs no engine change is to
 * repackage the provider in config: point it at `@ai-sdk/openai-compatible` and
 * give it the base URL the profile table already publishes. Stored credentials
 * still resolve, because the provider id is unchanged.
 *
 * It has to be the *global* config. A session's location is the engine's cwd,
 * never `OPENFLOW_PROJECT` (see FLOW.md), so a project `opencode.json` reaches
 * the catalog reads the browser makes and never the drain that runs the model.
 * The global config is loaded for both.
 *
 * Cost of the swap: a provider plugin that keys off the old package stops
 * applying — for OpenRouter that is its `HTTP-Referer`/`X-Title` headers and
 * its disabling of the broken `gpt-5-chat` aliases.
 */

/**
 * Provider id to base URL, copied verbatim from upstream's
 * `openai-compatible-profile.ts`. That table is upstream's own statement about
 * which providers speak OpenAI chat and at which URL, so it is the list to copy
 * from rather than a local one to grow.
 */
export const COMPATIBLE_PROFILES: Record<string, string> = {
  baseten: "https://inference.baseten.co/v1",
  cerebras: "https://api.cerebras.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  deepseek: "https://api.deepseek.com/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  togetherai: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
}

export const COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible"

/**
 * Mirrors `Global.Path.config` (xdg-basedir), the directory opencode loads
 * before any project file. `xdg-basedir` falls back to `~/.config` on every
 * platform, Windows included, so this is one path and not a per-OS branch.
 *
 * Both names opencode accepts are returned, in the order it reads them, so a
 * caller can prefer the file that already exists.
 */
export function globalConfigCandidates(env: Record<string, string | undefined> = process.env, home = os.homedir()) {
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return [path.join(config, "opencode", "opencode.json"), path.join(config, "opencode", "opencode.jsonc")]
}

/**
 * Keys that make `ConfigMigrateV1.isV1` claim a file, copied from
 * `core/src/v1/config/migrate.ts`. One of them anywhere in the file sends the
 * *whole* config through the v1 migration, where `providers` is not a key and
 * `provider` is — so the shape this writes has to follow the file it is
 * writing into, or the override lands somewhere the loader never looks.
 */
const V1_KEYS = new Set([
  "logLevel",
  "server",
  "command",
  "reference",
  "snapshot",
  "plugin",
  "autoshare",
  "disabled_providers",
  "enabled_providers",
  "small_model",
  "mode",
  "agent",
  "provider",
  "permission",
  "tools",
  "attachment",
  "layout",
])

export function isV1Config(config: unknown) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false
  return Object.keys(config).some((key) => V1_KEYS.has(key))
}

/** Provider ids this config already repackages, in table order. */
export function repackaged(config: any): string[] {
  return Object.keys(COMPATIBLE_PROFILES).filter((id) => {
    const v1 = config?.provider?.[id]
    if (v1?.npm === COMPATIBLE_PACKAGE && v1?.api === COMPATIBLE_PROFILES[id]) return true
    const v2 = config?.providers?.[id]?.api
    return v2?.type === "aisdk" && v2?.package === COMPATIBLE_PACKAGE && v2?.url === COMPATIBLE_PROFILES[id]
  })
}

/**
 * Adds the override for each id, in whichever dialect the file is already
 * written in, and reports which entries actually changed. An id already
 * repackaged is not listed, so a caller can skip the write — and the backup —
 * entirely.
 *
 * Everything else on the provider entry survives: a hand-written `models` map
 * or `options` block is merged around, not replaced.
 */
export function repackage(config: any, ids: string[]) {
  const value = { ...config }
  const changed = ids.filter((id) => COMPATIBLE_PROFILES[id] && !repackaged(config).includes(id))
  if (!changed.length) return { value, changed }

  if (isV1Config(config)) {
    value.provider = { ...value.provider }
    for (const id of changed)
      value.provider[id] = { ...value.provider[id], npm: COMPATIBLE_PACKAGE, api: COMPATIBLE_PROFILES[id] }
    return { value, changed }
  }

  value.providers = { ...value.providers }
  for (const id of changed)
    value.providers[id] = {
      ...value.providers[id],
      api: { type: "aisdk", package: COMPATIBLE_PACKAGE, url: COMPATIBLE_PROFILES[id] },
    }
  return { value, changed }
}
