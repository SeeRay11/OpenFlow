import { accessSync, constants, existsSync, statSync } from "node:fs"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  DEFAULT_OMP_SETTINGS,
  type EffectiveSource,
  type OmpSettings,
  type OmpSettingsPatch,
  type OmpSettingsView,
  type ValidationError,
} from "../../shared/omp"
import { SWARM_MODES } from "../../shared/swarm"
import { resetOmpCheck } from "../omp/binary"
import { parseBaseUrl, tokenAllowed } from "../substrate/client"

/**
 * OpenFlow's own Omp settings: what it decides when it spawns omp, kept in
 * `<stateDir>/omp-settings.json`. The file holds no secrets by construction
 * (every field is a path, a flag, a number or a URL that must not carry
 * credentials); tokens only ever come from the host environment.
 */

export const SETTINGS_FILE = "omp-settings.json"

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MANUAL_APPROVAL = ["always-ask", "write"]
const MEMORY_TTL = ["graph", "30d", "permanent"]

export type UpdateResult = { ok: true; view: OmpSettingsView } | { ok: false; errors: ValidationError[] }

export type SettingsStoreOptions = { stateDir(): string; env?: NodeJS.ProcessEnv }

export type SettingsStore = {
  load(): Promise<{ settings: OmpSettings; warnings: string[] }>
  view(): Promise<OmpSettingsView>
  update(patch: unknown): Promise<UpdateResult>
  reset(): Promise<OmpSettingsView>
  changed(listener: () => void): () => void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function defaults(): OmpSettings {
  return structuredClone(DEFAULT_OMP_SETTINGS)
}

/**
 * Merges `patch` over `base`, leaf by leaf. A key the settings do not have, or a
 * leaf of the wrong JS type, is reported (or, with `lenient`, skipped) instead of
 * stored: the file is read back later by code that trusts its shape.
 */
function merge(base: OmpSettings, patch: unknown, lenient: boolean): { settings: OmpSettings; errors: ValidationError[] } {
  const settings = structuredClone(base)
  const errors: ValidationError[] = []
  if (!isRecord(patch)) return { settings, errors: [{ path: "", message: "settings must be a JSON object" }] }

  const apply = (target: Record<string, unknown>, source: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(source)) {
      const where = prefix + key
      if (!Object.hasOwn(target, key)) {
        errors.push({ path: where, message: "unknown setting" })
        continue
      }
      const current = target[key]
      if (isRecord(current)) {
        if (!isRecord(value)) errors.push({ path: where, message: "expected an object" })
        else apply(current, value, `${where}.`)
        continue
      }
      if (typeof value !== typeof current) {
        errors.push({ path: where, message: `expected ${typeof current}` })
        continue
      }
      target[key] = value
    }
  }
  apply(settings as unknown as Record<string, unknown>, patch, "")
  return { settings, errors: lenient ? [] : errors }
}

function unsafePath(value: string): string | undefined {
  if (!path.isAbsolute(value)) return "must be an absolute path"
  if (/[\u0000-\u001f]/.test(value)) return "must not contain control characters"
  if (value.split(/[\\/]/).includes("..")) return "must not contain '..' segments"
  return undefined
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function integer(errors: ValidationError[], field: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    errors.push({ path: field, message: `must be a whole number from ${min} to ${max}` })
}

function member(errors: ValidationError[], field: string, value: string, allowed: readonly string[]) {
  if (!allowed.includes(value)) errors.push({ path: field, message: `must be one of ${allowed.join(", ")}` })
}

/** A directory that must hold `marker`, when the setting is not empty. */
function checkout(errors: ValidationError[], field: string, root: string, marker: string) {
  if (!root) return
  const unsafe = unsafePath(root)
  if (unsafe) return void errors.push({ path: field, message: unsafe })
  if (!existsSync(path.join(root, marker))) errors.push({ path: field, message: `${marker} was not found under this directory` })
}

/** Every rule that decides whether a settings object may be saved. Checked on the merged result. */
export function validateSettings(settings: OmpSettings): ValidationError[] {
  const errors: ValidationError[] = []

  if (settings.binary) {
    const unsafe = unsafePath(settings.binary)
    if (unsafe) errors.push({ path: "binary", message: unsafe })
    else if (!isExecutableFile(settings.binary)) errors.push({ path: "binary", message: "is not an executable file" })
  }
  if (settings.profile && !PROFILE.test(settings.profile))
    errors.push({ path: "profile", message: "use 1-32 lowercase letters, digits, - or _, starting with a letter or digit" })
  member(errors, "manualApproval", settings.manualApproval, MANUAL_APPROVAL)
  integer(errors, "maxSessionMinutes", settings.maxSessionMinutes, 1, 1440)

  integer(errors, "uplift.timeoutMs", settings.uplift.timeoutMs, 10_000, 1_800_000)
  checkout(errors, "uplift.root", settings.uplift.root, path.join("bin", "run-bun"))

  member(errors, "memory.ttl", settings.memory.ttl, MEMORY_TTL)
  integer(errors, "memory.readLimit", settings.memory.readLimit, 0, 50)
  if (settings.memory.repo && !REPO.test(settings.memory.repo))
    errors.push({ path: "memory.repo", message: "use owner/name" })

  member(errors, "swarm.mode", settings.swarm.mode, SWARM_MODES)
  checkout(errors, "swarm.root", settings.swarm.root, path.join("omp", "package.json"))

  if (settings.substrate.url) {
    try {
      const url = new URL(settings.substrate.url)
      if (url.protocol !== "http:" && url.protocol !== "https:")
        errors.push({ path: "substrate.url", message: "must start with http:// or https://" })
      else if (url.username || url.password)
        errors.push({ path: "substrate.url", message: "must not contain a username or password; tokens come from the environment" })
    } catch {
      errors.push({ path: "substrate.url", message: "is not a valid URL" })
    }
  }
  return errors
}

export function effectiveSources(settings: OmpSettings, env: NodeJS.ProcessEnv): Record<string, EffectiveSource> {
  const source = (value: string, names: string[]): EffectiveSource => {
    if (value) return { from: "settings" }
    const name = names.find((candidate) => Boolean(env[candidate]))
    return name ? { from: "env", env: name } : { from: "default" }
  }
  return {
    binary: source(settings.binary, []),
    profile: source(settings.profile, ["OMP_PROFILE"]),
    "uplift.root": source(settings.uplift.root, ["ULTRATHINK_ROOT"]),
    "swarm.root": source(settings.swarm.root, ["SWARM_ROOT", "ULTRATHINK_SWARM_ROOT"]),
    "substrate.url": source(settings.substrate.url, ["SUBSTRATE_URL"]),
  }
}

/**
 * A warning, never a refusal: a Substrate over plain http on another machine is a legitimate lab setup, but the
 * omp token is withheld from it unless `SUBSTRATE_URL` names the same address (`lib/substrate/client.ts`).
 */
function substrateWarnings(settings: OmpSettings, env: NodeJS.ProcessEnv): string[] {
  const url = settings.substrate.url ? parseBaseUrl(settings.substrate.url) : undefined
  if (!url || tokenAllowed(url, env)) return []
  return [
    `substrate.url ${url.host} is plain http on a non-loopback host, so the Substrate token is not sent to it and memory stays off. Use https, or set SUBSTRATE_URL to the same address to trust it.`,
  ]
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const env = options.env ?? process.env
  const listeners = new Set<() => void>()
  /** Survives until the next save: a moved-aside file is gone from disk, so only memory remembers it. */
  let warnings: string[] = []
  let queue: Promise<unknown> = Promise.resolve()

  const file = () => path.join(options.stateDir(), SETTINGS_FILE)

  /** Writes run one at a time so two quick PUTs cannot interleave a read-merge-write. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  async function read(): Promise<OmpSettings> {
    const target = file()
    let text: string
    try {
      text = await readFile(target, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed)) {
      await rename(target, `${target}.bad`)
      warnings = [`${SETTINGS_FILE} was unreadable and was moved to ${SETTINGS_FILE}.bad; the defaults are in use.`]
      return defaults()
    }
    const merged = merge(defaults(), parsed, false)
    if (merged.errors.length) {
      // Keep the readable part: an older or newer build may have written keys this one does not know.
      warnings = [`${SETTINGS_FILE} had ${merged.errors.length} entr${merged.errors.length === 1 ? "y" : "ies"} this build ignored (${merged.errors.map((entry) => entry.path).join(", ")}).`]
    }
    return merge(defaults(), parsed, true).settings
  }

  async function write(settings: OmpSettings) {
    const target = file()
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    warnings = []
  }

  function notify() {
    resetOmpCheck()
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber must not fail a save that already happened.
      }
    }
  }

  async function view(settings?: OmpSettings): Promise<OmpSettingsView> {
    const current = settings ?? (await read())
    return { settings: current, effective: effectiveSources(current, env), warnings: [...warnings, ...substrateWarnings(current, env)] }
  }

  return {
    async load() {
      const settings = await read()
      return { settings, warnings: [...warnings, ...substrateWarnings(settings, env)] }
    },
    view: () => view(),
    update: (patch) =>
      serial(async () => {
        const base = await read()
        const merged = merge(base, patch, false)
        if (merged.errors.length) return { ok: false, errors: merged.errors }
        const errors = validateSettings(merged.settings)
        if (errors.length) return { ok: false, errors }
        await write(merged.settings)
        notify()
        return { ok: true, view: await view(merged.settings) }
      }),
    reset: () =>
      serial(async () => {
        const settings = defaults()
        await write(settings)
        notify()
        return view(settings)
      }),
    changed(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type { OmpSettingsPatch }
