import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { accessSync, constants, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { PTY_CONTROL, PTY_HEADER, PTY_LIMITS, clampSize } from "../../shared/terminal"
import type { PtyClientControl, PtyKind, PtyServerControl, PtyTicketRequest } from "../../shared/terminal"
import { hostOf, loopbackHost, sameOrigin } from "../host/gate"
import type { Refusal } from "../host/gate"

/**
 * Everything the terminal decides before a process exists: who may ask, what
 * they may ask for, and what the child is allowed to see. Pure functions and a
 * ticket store, so the whole policy is one table-driven test.
 */

// The Host / Origin rules are the host gate's: one implementation for every route.

/**
 * The gate for the HTTP routes. The custom header cannot be sent cross-origin
 * without a CORS preflight this host never answers; Origin + Host close the
 * rest. A bodiless GET may legitimately arrive without an Origin (browsers omit
 * it same-origin), so only a *wrong* one is refused there.
 */
export function httpRefusal(request: Request, enabled: boolean): Refusal | undefined {
  if (!enabled) {
    return { status: 403, error: "the terminal is disabled while FLOW_ALLOW_REMOTE=1", code: "terminal-disabled" }
  }
  if (request.headers.get(PTY_HEADER) !== "1") {
    return { status: 403, error: `missing ${PTY_HEADER} header`, code: "missing-header" }
  }
  const host = hostOf(request)
  if (!loopbackHost(host)) return { status: 403, error: "the terminal only answers on a loopback host", code: "bad-host" }
  const origin = request.headers.get("origin")
  if (origin === null && request.method === "GET") return undefined
  if (!sameOrigin(origin, host)) return { status: 403, error: "cross-origin request refused", code: "bad-origin" }
  return undefined
}

/** The gate for a WebSocket upgrade: browsers cannot set headers there, so Origin + Host (and the ticket, checked after). */
export function upgradeRefusal(request: Request, enabled: boolean): Refusal | undefined {
  if (!enabled) return { status: 403, error: "the terminal is disabled while FLOW_ALLOW_REMOTE=1", code: "terminal-disabled" }
  const host = hostOf(request)
  if (!loopbackHost(host)) return { status: 403, error: "the terminal only answers on a loopback host", code: "bad-host" }
  if (!sameOrigin(request.headers.get("origin"), host)) {
    return { status: 403, error: "cross-origin request refused", code: "bad-origin" }
  }
  return undefined
}

/**
 * One-shot upgrade tickets. A ticket is bound to a session id, expires, and is
 * consumed by the first attempt to use it — successful or not — so a leaked URL
 * is worth one connection at most. The per-launch `secret` signs the ticket, so
 * a string made up by a client cannot even reach the lookup.
 */
export class TicketStore {
  #issued = new Map<string, { id: string; expiresAt: number }>()
  readonly #secret: Buffer
  readonly #now: () => number
  readonly #ttl: number

  constructor(secret: string, now: () => number = Date.now, ttl: number = PTY_LIMITS.ticketTtlMs) {
    this.#secret = Buffer.from(secret)
    this.#now = now
    this.#ttl = ttl
  }

  #sign(id: string, nonce: string) {
    return createHmac("sha256", this.#secret).update(`${id}.${nonce}`).digest("base64url")
  }

  issue(id: string): { ticket: string; expiresAt: number } {
    const at = this.#now()
    for (const [ticket, entry] of this.#issued) if (entry.expiresAt <= at) this.#issued.delete(ticket)
    const nonce = randomBytes(18).toString("base64url")
    const ticket = `${nonce}.${this.#sign(id, nonce)}`
    const expiresAt = at + this.#ttl
    this.#issued.set(ticket, { id, expiresAt })
    return { ticket, expiresAt }
  }

  /** Atomic: the entry is deleted before it is judged, so two upgrades racing on one ticket cannot both win. */
  consume(ticket: string | null, id: string): boolean {
    if (!ticket) return false
    const entry = this.#issued.get(ticket)
    if (!entry) return false
    this.#issued.delete(ticket)
    if (entry.id !== id || entry.expiresAt <= this.#now()) return false
    const [nonce, signature] = ticket.split(".")
    if (!nonce || !signature) return false
    const expected = Buffer.from(this.#sign(id, nonce))
    const given = Buffer.from(signature)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  revoke(id: string) {
    for (const [ticket, entry] of this.#issued) if (entry.id === id) this.#issued.delete(ticket)
  }
}

const CREATE_KEYS: Record<string, true> = { kind: true, cols: true, rows: true }

/** The browser's whole vocabulary: attach to an id, or create `{kind, cols, rows}`. Anything else is a refusal message. */
export function parseTicketRequest(body: unknown): PtyTicketRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "expected a JSON object"
  const { id, create } = body as { id?: unknown; create?: unknown }
  if (id !== undefined && create !== undefined) return "send either id or create, not both"
  if (id !== undefined) {
    if (typeof id !== "string" || !id || id.length > 64) return "id must be a session id"
    return { id }
  }
  if (typeof create !== "object" || create === null || Array.isArray(create)) return "send an id to attach or create to start one"
  for (const key of Object.keys(create)) if (!Object.hasOwn(CREATE_KEYS, key)) return `create takes only kind, cols and rows (got ${key})`
  const { kind, cols, rows } = create as { kind?: unknown; cols?: unknown; rows?: unknown }
  if (kind !== "omp" && kind !== "shell") return 'kind must be "omp" or "shell"'
  if (typeof cols !== "number" || typeof rows !== "number") return "cols and rows must be numbers"
  return { create: { kind, ...clampSize(cols, rows) } }
}

/**
 * What the child inherits. An allowlist, deliberately: the host's own
 * environment carries the Substrate token, the swarm signing key and provider
 * keys, and a terminal is a place where a user (or a page that got past the
 * gate) types `env`. `PI_*` / `OMP_*` are omp's own knobs, minus anything that
 * names a secret.
 */
const EXACT: Record<string, true> = { HOME: true, USER: true, LOGNAME: true, PATH: true, SHELL: true, LANG: true, TMPDIR: true }
const PREFIXES = ["LC_", "XDG_", "PI_", "OMP_"]
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE)/i
/** Windows needs these to start anything; names compare upper-cased there. Not exercised on this platform. */
const WINDOWS: Record<string, true> = {
  SYSTEMROOT: true,
  COMSPEC: true,
  PATHEXT: true,
  USERPROFILE: true,
  APPDATA: true,
  LOCALAPPDATA: true,
  TEMP: true,
  TMP: true,
  WINDIR: true,
  PROGRAMFILES: true,
  PROGRAMDATA: true,
}

export function terminalEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const key = platform === "win32" ? name.toUpperCase() : name
    if (SECRETISH.test(key)) continue
    if (Object.hasOwn(EXACT, key) || PREFIXES.some((prefix) => key.startsWith(prefix)) || (platform === "win32" && Object.hasOwn(WINDOWS, key))) {
      env[name] = value
    }
  }
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

function readShells(): string[] {
  try {
    return readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  } catch {
    return []
  }
}

function canonical(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/**
 * `$SHELL` only when it is an absolute, executable path the system lists in
 * `/etc/shells` (the env can be set by anything that launched the host); else
 * `/bin/sh`. Windows has no `/etc/shells`: it gets `%ComSpec%` (untested here).
 */
export function resolveShell(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; shells?: string[] } = {},
): { file: string; args: string[] } {
  if ((options.platform ?? process.platform) === "win32") return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: [] }
  const wanted = env.SHELL
  if (wanted && path.isAbsolute(wanted)) {
    try {
      accessSync(wanted, constants.X_OK)
      const listed = new Set((options.shells ?? readShells()).flatMap((shell) => [shell, canonical(shell)]))
      if (listed.has(wanted) || listed.has(canonical(wanted))) return { file: wanted, args: ["-l"] }
    } catch {}
  }
  return { file: "/bin/sh", args: ["-l"] }
}

export type SpawnPlan = { file: string; args: string[]; cwd: string; env: Record<string, string> }

export type PlanDeps = {
  project(): string
  env: NodeJS.ProcessEnv
  omp(): Promise<{ argv: string[] } | { error: string }>
  shells?: string[]
  platform?: NodeJS.Platform
}

export class PlanError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Argv, cwd and env for a `kind`: always host-derived, never browser-supplied. */
export async function spawnPlan(kind: PtyKind, deps: PlanDeps): Promise<SpawnPlan> {
  let cwd: string
  try {
    cwd = realpathSync(deps.project())
  } catch {
    throw new PlanError(409, "no-project", "the project directory does not exist")
  }
  const env = terminalEnv(deps.env, deps.platform)
  if (kind === "shell") {
    const shell = resolveShell(deps.env, { platform: deps.platform, shells: deps.shells })
    return { ...shell, cwd, env }
  }
  const omp = await deps.omp()
  if ("error" in omp) throw new PlanError(409, "omp-unavailable", omp.error)
  const [file, ...args] = omp.argv
  if (!file) throw new PlanError(409, "omp-unavailable", "omp has no launch command")
  return { file, args, cwd, env }
}

/** A binary control frame: `0x00` then JSON. */
export function encodeControl(frame: PtyServerControl): Uint8Array {
  const json = Buffer.from(JSON.stringify(frame))
  const out = new Uint8Array(json.length + 1)
  out[0] = PTY_CONTROL
  out.set(json, 1)
  return out
}

export type ClientFrame = { input: string } | { resize: { cols: number; rows: number } }

const CONTROL_MAX_BYTES = 1024

/**
 * One inbound WebSocket message. Text is keystrokes, capped; a binary `0x00`
 * frame is a control message. Everything unparseable or oversize is dropped
 * rather than answered: a client that sends it is not one this host wrote.
 */
export function decodeClientFrame(data: string | Uint8Array): ClientFrame | undefined {
  if (typeof data === "string") {
    if (!data || Buffer.byteLength(data) > PTY_LIMITS.inputFrameBytes) return undefined
    return { input: data }
  }
  if (data.length < 2 || data.length > CONTROL_MAX_BYTES || data[0] !== PTY_CONTROL) return undefined
  let control: Partial<PtyClientControl>
  try {
    control = JSON.parse(Buffer.from(data.subarray(1)).toString("utf8"))
  } catch {
    return undefined
  }
  if (control?.t !== "resize" || typeof control.cols !== "number" || typeof control.rows !== "number") return undefined
  return { resize: clampSize(control.cols, control.rows) }
}
