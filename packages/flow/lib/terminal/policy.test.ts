import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PTY_HEADER, PTY_LIMITS } from "../../shared/terminal"
import {
  PlanError,
  TicketStore,
  decodeClientFrame,
  encodeControl,
  httpRefusal,
  parseTicketRequest,
  resolveShell,
  spawnPlan,
  terminalEnv,
  upgradeRefusal,
} from "./policy"
import { cleanScratch, scratch } from "./test-harness"

afterEach(cleanScratch)

function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(url, { method: init.method ?? "POST", headers: init.headers })
}

describe("httpRefusal", () => {
  const good = { [PTY_HEADER]: "1", origin: "http://127.0.0.1:5173" }
  const at = "http://127.0.0.1:5173/flow/api/pty/ticket"

  test("same-origin, header present, loopback host passes", () => {
    expect(httpRefusal(request(at, { headers: good }), true)).toBeUndefined()
    expect(httpRefusal(request("http://localhost:5173/x", { headers: { ...good, origin: "http://localhost:5173" } }), true)).toBeUndefined()
    expect(httpRefusal(request("http://[::1]:5173/x", { headers: { ...good, origin: "http://[::1]:5173" } }), true)).toBeUndefined()
  })

  test.each([
    ["remote enabled disables everything", at, good, false, "terminal-disabled"],
    ["missing header", at, { origin: good.origin }, true, "missing-header"],
    ["header with the wrong value", at, { ...good, [PTY_HEADER]: "0" }, true, "missing-header"],
    ["wrong origin", at, { ...good, origin: "https://evil.example" }, true, "bad-origin"],
    ["origin on another port", at, { ...good, origin: "http://127.0.0.1:9999" }, true, "bad-origin"],
    ["missing origin on a POST", at, { [PTY_HEADER]: "1" }, true, "bad-origin"],
    ["non-loopback host", "http://evil.example:5173/flow/api/pty/ticket", { ...good, origin: "http://evil.example:5173" }, true, "bad-host"],
    ["rebound host with a matching origin", "http://192.168.1.5:5173/x", { ...good, origin: "http://192.168.1.5:5173" }, true, "bad-host"],
  ])("%s", (_name, url, headers, enabled, code) => {
    const refusal = httpRefusal(request(url, { headers }), enabled)
    expect(refusal).toMatchObject({ status: 403, code })
  })

  test("a GET without an origin passes (browsers omit it same-origin) but a wrong one does not", () => {
    expect(httpRefusal(request(at, { method: "GET", headers: { [PTY_HEADER]: "1" } }), true)).toBeUndefined()
    expect(httpRefusal(request(at, { method: "GET", headers: { [PTY_HEADER]: "1", origin: "http://evil.example" } }), true)).toMatchObject({
      code: "bad-origin",
    })
    expect(httpRefusal(request(at, { method: "GET" }), true)).toMatchObject({ code: "missing-header" })
  })

  test("a refusal carries no secret material", () => {
    const refusal = httpRefusal(request(at, { headers: { ...good, origin: "http://evil.example" } }), true)
    expect(JSON.stringify(refusal)).not.toContain("evil.example")
  })
})

describe("upgradeRefusal", () => {
  const ws = "http://127.0.0.1:5173/flow/pty/abc/ws"

  test("needs a matching origin on a loopback host, and the terminal enabled", () => {
    expect(upgradeRefusal(request(ws, { method: "GET", headers: { origin: "http://127.0.0.1:5173" } }), true)).toBeUndefined()
    expect(upgradeRefusal(request(ws, { method: "GET" }), true)).toMatchObject({ code: "bad-origin" })
    expect(upgradeRefusal(request(ws, { method: "GET", headers: { origin: "http://evil.example" } }), true)).toMatchObject({ code: "bad-origin" })
    expect(upgradeRefusal(request(ws, { method: "GET", headers: { origin: "http://127.0.0.1:5173" } }), false)).toMatchObject({
      code: "terminal-disabled",
    })
    expect(
      upgradeRefusal(request("http://evil.example/flow/pty/abc/ws", { method: "GET", headers: { origin: "http://evil.example" } }), true),
    ).toMatchObject({ code: "bad-host" })
  })
})

describe("TicketStore", () => {
  test("a ticket works once, for its own session, before it expires", () => {
    let now = 1_000
    const store = new TicketStore("dummy-secret", () => now)
    const { ticket, expiresAt } = store.issue("session-a")
    expect(expiresAt).toBe(1_000 + PTY_LIMITS.ticketTtlMs)
    expect(store.consume(ticket, "session-a")).toBe(true)
    expect(store.consume(ticket, "session-a")).toBe(false)

    const other = store.issue("session-a")
    expect(store.consume(other.ticket, "session-b")).toBe(false)
    // A failed attempt still spent it: probing with the right id afterwards does not help.
    expect(store.consume(other.ticket, "session-a")).toBe(false)

    const late = store.issue("session-a")
    now += PTY_LIMITS.ticketTtlMs
    expect(store.consume(late.ticket, "session-a")).toBe(false)
  })

  test("garbage, missing and forged tickets are refused", () => {
    const store = new TicketStore("dummy-secret")
    const real = store.issue("a").ticket
    expect(store.consume(null, "a")).toBe(false)
    expect(store.consume("", "a")).toBe(false)
    expect(store.consume("not-a-ticket", "a")).toBe(false)
    expect(store.consume(`${real}x`, "a")).toBe(false)
    const forged = new TicketStore("another-secret")
    expect(store.consume(forged.issue("a").ticket, "a")).toBe(false)
    expect(store.consume(real, "a")).toBe(true)
  })

  test("revoke drops a session's tickets; expired ones are swept on issue", () => {
    let now = 0
    const store = new TicketStore("dummy-secret", () => now)
    const a = store.issue("a").ticket
    store.revoke("a")
    expect(store.consume(a, "a")).toBe(false)
    const stale = store.issue("b").ticket
    now = PTY_LIMITS.ticketTtlMs + 1
    store.issue("c")
    expect(store.consume(stale, "b")).toBe(false)
  })
})

describe("parseTicketRequest", () => {
  test("attach by id, create with clamped size", () => {
    expect(parseTicketRequest({ id: "abc" })).toEqual({ id: "abc" })
    expect(parseTicketRequest({ create: { kind: "omp", cols: 120, rows: 40 } })).toEqual({ create: { kind: "omp", cols: 120, rows: 40 } })
    expect(parseTicketRequest({ create: { kind: "shell", cols: 99_999, rows: 99_999 } })).toEqual({
      create: { kind: "shell", cols: PTY_LIMITS.maxCols, rows: PTY_LIMITS.maxRows },
    })
    expect(parseTicketRequest({ create: { kind: "shell", cols: 1, rows: -5 } })).toEqual({
      create: { kind: "shell", cols: PTY_LIMITS.minCols, rows: PTY_LIMITS.minRows },
    })
    expect(parseTicketRequest({ create: { kind: "shell", cols: 80.9, rows: 24.2 } })).toEqual({ create: { kind: "shell", cols: 80, rows: 24 } })
  })

  test.each([
    ["null", null],
    ["an array", []],
    ["neither id nor create", {}],
    ["both", { id: "a", create: { kind: "omp", cols: 80, rows: 24 } }],
    ["unknown kind", { create: { kind: "bash", cols: 80, rows: 24 } }],
    ["a missing kind", { create: { cols: 80, rows: 24 } }],
    ["string sizes", { create: { kind: "omp", cols: "80", rows: "24" } }],
    ["argv from the browser", { create: { kind: "shell", cols: 80, rows: 24, argv: ["rm"] } }],
    ["cwd from the browser", { create: { kind: "shell", cols: 80, rows: 24, cwd: "/" } }],
    ["env from the browser", { create: { kind: "shell", cols: 80, rows: 24, env: { A: "b" } } }],
    ["a numeric id", { id: 5 }],
    ["an empty id", { id: "" }],
    ["an oversize id", { id: "x".repeat(65) }],
  ])("refuses %s", (_name, body) => expect(typeof parseTicketRequest(body)).toBe("string"))
})

describe("terminalEnv", () => {
  test("passes the allowlist and nothing else; never a secret", () => {
    const env = terminalEnv({
      HOME: "/home/u",
      USER: "u",
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/cfg",
      TMPDIR: "/tmp",
      PI_CODING_AGENT_DIR: "/pi",
      OMP_PROFILE: "openflow",
      PI_API_KEY: "dummy",
      OMP_ACCESS_TOKEN: "dummy",
      OMP_X_API_KEY: "dummy",
      SUBSTRATE_TOKEN: "dummy-token",
      SWARM_ED25519_KEY: "dummy-key",
      ULTRATHINK_PLANNER_KEY: "dummy",
      OPENROUTER_API_KEY: "dummy-key",
      ANTHROPIC_API_KEY: "dummy-key",
      GITHUB_TOKEN: "dummy-token",
      TERM: "dumb",
      EDITOR: "vim",
    })
    expect(env).toEqual({
      HOME: "/home/u",
      USER: "u",
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/cfg",
      TMPDIR: "/tmp",
      PI_CODING_AGENT_DIR: "/pi",
      OMP_PROFILE: "openflow",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    })
  })

  test("windows names compare case-insensitively and bring what a process needs to start", () => {
    const env = terminalEnv({ Path: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", Home: "C:\\u", OPENAI_API_KEY: "dummy" }, "win32")
    expect(Object.keys(env).sort()).toEqual(["COLORTERM", "ComSpec", "Home", "Path", "SystemRoot", "TERM"].sort())
  })

  test("inherited object keys are not allowlist hits", () => {
    expect(terminalEnv({ constructor: "x", toString: "y" })).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor" })
  })
})

describe("resolveShell", () => {
  // `#!/bin/sh` fakes, `chmod` bits and `/bin/sh` itself: not on Windows (the %ComSpec% case below is portable).
  test.skipIf(process.platform === "win32")("uses $SHELL only when absolute, executable and listed; else /bin/sh -l", async () => {
    const dir = await scratch()
    const fake = path.join(dir, "fakesh")
    await fs.writeFile(fake, "#!/bin/sh\n", { mode: 0o755 })
    const unlisted = path.join(dir, "unlisted")
    await fs.writeFile(unlisted, "#!/bin/sh\n", { mode: 0o755 })
    const noexec = path.join(dir, "noexec")
    await fs.writeFile(noexec, "#!/bin/sh\n", { mode: 0o644 })
    const shells = [fake, noexec, "/bin/sh"]

    expect(resolveShell({ SHELL: fake }, { shells })).toEqual({ file: fake, args: ["-l"] })
    expect(resolveShell({ SHELL: unlisted }, { shells })).toEqual({ file: "/bin/sh", args: ["-l"] })
    expect(resolveShell({ SHELL: noexec }, { shells })).toEqual({ file: "/bin/sh", args: ["-l"] })
    expect(resolveShell({ SHELL: "fakesh" }, { shells })).toEqual({ file: "/bin/sh", args: ["-l"] })
    expect(resolveShell({ SHELL: path.join(dir, "missing") }, { shells })).toEqual({ file: "/bin/sh", args: ["-l"] })
    expect(resolveShell({}, { shells })).toEqual({ file: "/bin/sh", args: ["-l"] })
  })

  test.skipIf(process.platform === "win32")("a symlink to a listed shell is accepted (merged /usr)", async () => {
    const dir = await scratch()
    const real = path.join(dir, "real-sh")
    await fs.writeFile(real, "#!/bin/sh\n", { mode: 0o755 })
    const link = path.join(dir, "link-sh")
    await fs.symlink(real, link)
    expect(resolveShell({ SHELL: link }, { shells: [real] }).file).toBe(link)
  })

  test("windows runs %ComSpec% (not exercised on this platform)", () => {
    expect(resolveShell({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, { platform: "win32" })).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    })
  })
})

describe("spawnPlan", () => {
  // `/bin/sh` and a POSIX symlink: not on Windows.
  test.skipIf(process.platform === "win32")("shell: cwd is the real path of the project, env is filtered", async () => {
    const dir = await scratch()
    const link = path.join(dir, "link")
    await fs.mkdir(path.join(dir, "project"))
    await fs.symlink(path.join(dir, "project"), link)
    const plan = await spawnPlan("shell", {
      project: () => link,
      env: { HOME: "/h", SUBSTRATE_TOKEN: "dummy-token", PATH: "/usr/bin" },
      omp: async () => ({ error: "unused" }),
      shells: [],
    })
    expect(plan.cwd).toBe(path.join(dir, "project"))
    expect(plan.file).toBe("/bin/sh")
    expect(plan.env).not.toHaveProperty("SUBSTRATE_TOKEN")
    expect(plan.env.HOME).toBe("/h")
  })

  test("omp: argv comes from the injected resolver, split into file and args", async () => {
    const dir = await scratch()
    const plan = await spawnPlan("omp", {
      project: () => dir,
      env: {},
      omp: async () => ({ argv: ["/opt/omp", "--profile", "openflow"] }),
    })
    expect(plan).toMatchObject({ file: "/opt/omp", args: ["--profile", "openflow"], cwd: dir })
  })

  test("a missing omp and a missing project are 409s with a code the dock can act on", async () => {
    const dir = await scratch()
    const missing = await spawnPlan("omp", { project: () => dir, env: {}, omp: async () => ({ error: "omp is not installed" }) }).catch((e) => e)
    expect(missing).toBeInstanceOf(PlanError)
    expect(missing).toMatchObject({ status: 409, code: "omp-unavailable", message: "omp is not installed" })

    const empty = await spawnPlan("omp", { project: () => dir, env: {}, omp: async () => ({ argv: [] }) }).catch((e) => e)
    expect(empty).toMatchObject({ code: "omp-unavailable" })

    const gone = await spawnPlan("shell", { project: () => path.join(dir, "nope"), env: {}, omp: async () => ({ error: "x" }) }).catch((e) => e)
    expect(gone).toMatchObject({ status: 409, code: "no-project" })
  })
})

describe("frames", () => {
  const control = (value: unknown) => Uint8Array.from([0, ...Buffer.from(JSON.stringify(value))])

  test("text is keystrokes; the cap is in bytes", () => {
    expect(decodeClientFrame("ls\n")).toEqual({ input: "ls\n" })
    expect(decodeClientFrame("")).toBeUndefined()
    expect(decodeClientFrame("a".repeat(PTY_LIMITS.inputFrameBytes))).toEqual({ input: "a".repeat(PTY_LIMITS.inputFrameBytes) })
    expect(decodeClientFrame("a".repeat(PTY_LIMITS.inputFrameBytes + 1))).toBeUndefined()
    // 3 bytes each: well under the cap in characters, over it in bytes.
    expect(decodeClientFrame("€".repeat(PTY_LIMITS.inputFrameBytes / 2))).toBeUndefined()
  })

  test("binary 0x00 + JSON resize is clamped; everything else is dropped", () => {
    expect(decodeClientFrame(control({ t: "resize", cols: 120, rows: 40 }))).toEqual({ resize: { cols: 120, rows: 40 } })
    expect(decodeClientFrame(control({ t: "resize", cols: 5000, rows: 1 }))).toEqual({
      resize: { cols: PTY_LIMITS.maxCols, rows: PTY_LIMITS.minRows },
    })
    expect(decodeClientFrame(control({ t: "resize", cols: "x", rows: 1 }))).toBeUndefined()
    expect(decodeClientFrame(control({ t: "other" }))).toBeUndefined()
    expect(decodeClientFrame(control(null))).toBeUndefined()
    expect(decodeClientFrame(Uint8Array.from([0, ...Buffer.from("{nope")]))).toBeUndefined()
    expect(decodeClientFrame(Uint8Array.from([1, ...Buffer.from(JSON.stringify({ t: "resize", cols: 80, rows: 24 }))]))).toBeUndefined()
    expect(decodeClientFrame(Uint8Array.from([0]))).toBeUndefined()
    expect(decodeClientFrame(new Uint8Array(2048))).toBeUndefined()
  })

  test("server controls are 0x00 + JSON", () => {
    const bytes = encodeControl({ cursor: 42 })
    expect(bytes[0]).toBe(0)
    expect(JSON.parse(Buffer.from(bytes.subarray(1)).toString())).toEqual({ cursor: 42 })
    expect(JSON.parse(Buffer.from(encodeControl({ exit: { code: 1, signal: null } }).subarray(1)).toString())).toEqual({
      exit: { code: 1, signal: null },
    })
  })
})
