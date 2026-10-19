import { spawn, type ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import type { OmpConfigEntry, OmpConfigType, OmpSettings, ValidationError } from "../../shared/omp"
import { resolveBinary } from "../omp/binary"
import { HttpError } from "../host/respond"
import { isRecord } from "./settings"

/**
 * The real `omp config` surface, read and written through omp itself so omp
 * validates every value and OpenFlow never invents an option.
 *
 * CLI syntax, verified against omp 18.12.2 (`omp config --help` is just
 * `omp config [ACTION] [KEY] [VALUE...] [--json]`; the rest was probed):
 *  - `--profile <name>` is a GLOBAL flag and goes BEFORE `config`; after it omp
 *    answers `Unknown option '--profile'`.
 *  - `omp config list --json` -> `{ "<key>": { type, description, value?, redacted? } }`;
 *    `value` is absent for an unset string; `redacted: true` only appears once a
 *    secret is set, and then `value` is absent. No enum choices, no category.
 *  - `omp config list` (text) -> `[category]` headings, then `  key = value (type)`
 *    or, for enums, `  key = value (a|b|c)`. Unset values print `(not set)`.
 *  - `omp config set <key> <value>`; a value starting with `-` needs `--` first.
 *    Exit 1 with `Error: ...` on stderr for an invalid value or unknown key.
 *  - `omp config reset <key>`; `omp config path`.
 *  - `set`, `reset` and `get --json` all ECHO the value on stdout (even a secret
 *    one), so their stdout is never returned or logged, and entries are always
 *    re-read through `list --json`, which carries the `redacted` flag.
 */

const TYPES: readonly string[] = ["boolean", "number", "enum", "string", "array", "record"]
const SCALAR_NAMES: readonly string[] = ["boolean", "number", "string", "array", "record"]
export const RUN_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 32 * 1024 * 1024
/** Anchored at the end: `compaction.reserveTokens` is a count, `auth.broker.token` is a credential. */
const SENSITIVE = /(token|secret|password|passphrase|api[-_]?key|credentials?|private[-_]?key)$/i
/** The host environment omp needs to find its profile; provider keys and OpenFlow's own tokens stay out. */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|XDG_[A-Z_]+|PI_[A-Z_]+|OMP_PROFILE|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SYSTEMROOT)$/

export type RunResult = { code: number; stdout: string; stderr: string }
/** `input`, when given, is written to the child's stdin; it is never logged or kept. */
export type Run = (binary: string, args: string[], env: Record<string, string>, input?: string) => Promise<RunResult>

export type ListingMeta = { type: OmpConfigType; group?: string; options?: string[] }

/** A rejected value, answered 422 with the offending field. */
export class ValidationFailure extends HttpError {
  readonly errors: ValidationError[]

  constructor(message: string, errors: ValidationError[] = [{ path: "value", message }]) {
    super(422, message, "invalid")
    this.errors = errors
  }
}

/** The child did not finish within the deadline; its process group was killed. */
export class RunTimeout extends Error {
  constructor(command: string) {
    super(`omp ${command} timed out`)
  }
}

function killTree(child: ChildProcess) {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // The group is already gone; fall back to the child itself.
    }
  }
  child.kill("SIGKILL")
}

/**
 * Runs a command to completion. The child leads its own process group on POSIX so a
 * timeout kills grandchildren too, and every pipe is closed so nothing keeps the
 * event loop alive. `input` goes to stdin and is not kept; without it stdin is closed.
 */
export function createRun(timeoutMs: number): Run {
  return (binary, args, env, input) => {
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>()
    const child = spawn(binary, args, {
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    function settle(finish: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    function abort(error: Error) {
      settle(() => reject(error))
      killTree(child)
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const timer = setTimeout(() => abort(new RunTimeout(args.at(-1) ?? "")), timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT) abort(new Error("omp printed too much output"))
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      if (stderr.length > MAX_OUTPUT) abort(new Error("omp printed too much output"))
    })
    child.on("error", (error) => abort(error))
    child.on("close", (code, signal) =>
      settle(() => (code === null ? reject(new Error(`omp stopped on ${signal ?? "a signal"}`)) : resolve({ code, stdout, stderr }))),
    )
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(input)
    }
    return promise
  }
}

export const defaultRun: Run = createRun(RUN_TIMEOUT_MS)

export function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { NO_COLOR: "1", TERM: "dumb" }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ENV_ALLOW.test(name)) result[name] = value
  }
  return result
}

export function profileArgs(settings: Pick<OmpSettings, "profile">): string[] {
  return settings.profile ? ["--profile", settings.profile] : []
}

/** Keys that hold credentials by name. Their values never leave the host, and they are not written from here: argv is visible to every local user. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key)
}

/** First line of a CLI failure, trimmed: what the user needs, without a stack or a wall of help text. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim())
  return (line ?? "omp failed").replace(/^Error:\s*/, "").trim().slice(0, 300)
}

/** Reads omp's text listing for what the JSON listing leaves out: category headings and enum choices. */
export function parseListing(text: string): Map<string, ListingMeta> {
  const meta = new Map<string, ListingMeta>()
  let group: string | undefined
  for (const line of text.split("\n")) {
    const heading = /^\[([^\]]+)\]\s*$/.exec(line)
    if (heading) {
      group = heading[1]
      continue
    }
    const row = /^\s+(\S+) = .* \(([^()]*)\)$/.exec(line)
    if (!row) continue
    const shape = row[2]!
    if (SCALAR_NAMES.includes(shape)) meta.set(row[1]!, { type: shape as OmpConfigType, group })
    else meta.set(row[1]!, { type: "enum", group, options: shape.split("|").filter(Boolean) })
  }
  return meta
}

export function toEntry(key: string, raw: unknown, meta: ListingMeta | undefined): OmpConfigEntry {
  const item = isRecord(raw) ? raw : {}
  const type = typeof item.type === "string" && TYPES.includes(item.type) ? (item.type as OmpConfigType) : (meta?.type ?? "string")
  const sensitive = isSensitiveKey(key) || item.redacted === true
  const entry: OmpConfigEntry = {
    key,
    type,
    description: typeof item.description === "string" ? item.description : "",
    value: undefined,
    editable: !sensitive && type !== "array" && type !== "record",
  }
  if (meta?.group) entry.group = meta.group
  if (type === "enum" && meta?.options?.length) entry.options = meta.options
  if (sensitive) {
    if (item.redacted === true || item.value !== undefined) entry.redacted = true
    return entry
  }
  if (item.value !== undefined) entry.value = item.value
  return entry
}

export type Config = {
  list(settings: OmpSettings): Promise<OmpConfigEntry[]>
  set(settings: OmpSettings, key: string, value: unknown): Promise<OmpConfigEntry>
  reset(settings: OmpSettings, key: string): Promise<OmpConfigEntry>
}

export function createConfig(deps: { run: Run; env: NodeJS.ProcessEnv }): Config {
  let listing: { key: string; meta: Map<string, ListingMeta> } | undefined

  async function omp(settings: OmpSettings, args: string[]): Promise<RunResult & { binary: string }> {
    const binary = resolveBinary(settings, deps.env)
    if (!binary) throw new HttpError(503, "omp was not found; set its path in Omp settings", "omp-unavailable")
    try {
      return { ...(await deps.run(binary, [...profileArgs(settings), "config", ...args], childEnv(deps.env))), binary }
    } catch (error) {
      throw new HttpError(503, `could not run omp: ${firstLine(error instanceof Error ? error.message : String(error))}`, "omp-unavailable")
    }
  }

  /** The text listing changes only when omp is upgraded, so it is cached per binary file and modification time; `fresh` skips the cache. */
  async function metaFor(settings: OmpSettings, fresh = false): Promise<Map<string, ListingMeta>> {
    const binary = resolveBinary(settings, deps.env)
    const key = binary ? `${binary}|${(await stat(binary).catch(() => undefined))?.mtimeMs ?? 0}` : ""
    if (!fresh && listing && key && listing.key === key) return listing.meta
    const result = await omp(settings, ["list"])
    if (result.code !== 0) throw new HttpError(502, firstLine(result.stderr), "omp-failed")
    const meta = parseListing(result.stdout)
    listing = { key, meta }
    return meta
  }

  async function entries(settings: OmpSettings): Promise<OmpConfigEntry[]> {
    const [result, cached] = await Promise.all([omp(settings, ["list", "--json"]), metaFor(settings)])
    if (result.code !== 0) throw new HttpError(502, firstLine(result.stderr), "omp-failed")
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new HttpError(502, "omp returned a config listing that is not JSON", "omp-output")
    }
    if (!isRecord(parsed)) throw new HttpError(502, "omp returned an unexpected config listing", "omp-output")
    // omp has been seen to print its text listing only partway, exit 0 and no error, when the machine is busy. Cached, that
    // would hide groups and enum choices (and make `known` refuse real keys) until omp is upgraded. A setting the JSON listing
    // names and the text listing does not is the tell: ask for the text listing again, once.
    const meta = Object.keys(parsed).every((key) => cached.has(key)) ? cached : await metaFor(settings, true)
    return Object.entries(parsed).map(([key, raw]) => toEntry(key, raw, meta.get(key)))
  }

  async function known(settings: OmpSettings, key: string): Promise<ListingMeta> {
    // A key the cached listing lacks may be a listing that was cut short (see `entries`): look once more before refusing it.
    const found = (await metaFor(settings)).get(key) ?? (await metaFor(settings, true)).get(key)
    if (!found) throw new HttpError(404, `omp has no setting named ${key}`, "unknown-key")
    return found
  }

  async function reread(settings: OmpSettings, key: string): Promise<OmpConfigEntry> {
    const entry = (await entries(settings)).find((candidate) => candidate.key === key)
    if (!entry) throw new HttpError(502, `omp no longer lists ${key}`, "omp-output")
    return entry
  }

  /** The argv form of `value`, or the reason omp would refuse it. */
  function encode(key: string, meta: ListingMeta, value: unknown): string {
    if (isSensitiveKey(key)) throw new ValidationFailure("this setting holds a credential: set it in the terminal")
    if (meta.type === "array" || meta.type === "record")
      throw new ValidationFailure("this setting is a list or map: edit it in the terminal")
    if (meta.type === "boolean") {
      if (typeof value !== "boolean") throw new ValidationFailure("expected true or false")
      return String(value)
    }
    if (meta.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationFailure("expected a number")
      return String(value)
    }
    if (typeof value !== "string") throw new ValidationFailure("expected text")
    if (value.includes("\u0000") || value.length > 4096) throw new ValidationFailure("text is too long or contains a NUL character")
    if (meta.type === "enum" && meta.options && !meta.options.includes(value))
      throw new ValidationFailure(`must be one of ${meta.options.join(", ")}`)
    return value
  }

  return {
    list: entries,
    async set(settings, key, value) {
      const meta = await known(settings, key)
      const text = encode(key, meta, value)
      // `--` keeps a value such as `-1` from being read as a flag.
      const result = await omp(settings, ["set", key, "--", text])
      if (result.code !== 0) throw new ValidationFailure(firstLine(result.stderr))
      return reread(settings, key)
    },
    async reset(settings, key) {
      await known(settings, key)
      const result = await omp(settings, ["reset", key])
      if (result.code !== 0) throw new HttpError(502, firstLine(result.stderr), "omp-failed")
      return reread(settings, key)
    },
  }
}
