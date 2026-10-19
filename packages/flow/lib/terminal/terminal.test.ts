import { afterEach, describe, expect, test } from "bun:test"
import { PTY_CLOSE, PTY_HEADER, PTY_LIMITS, PTY_ROUTES } from "../../shared/terminal"
import type { PtyInfo, PtyTicket } from "../../shared/terminal"
import { createTerminal } from "./index"
import type { TerminalDeps, TerminalModule } from "./index"
import { cleanScratch, collector, goneWithin, scratch, stub } from "./test-harness"

// Real PTYs, `/bin/sh` and POSIX process groups: nothing in this file runs on Windows.
const suite = describe.skipIf(process.platform === "win32")

/**
 * The module end to end without a socket: HTTP handler + upgrade policy over
 * real PTYs. The transports' own tests (`ws-bun`, `ws-node`) repeat the
 * interesting rows over a real WebSocket.
 */

const ORIGIN = "http://127.0.0.1:5173"
const GOOD = { [PTY_HEADER]: "1", origin: ORIGIN, "content-type": "application/json" }
const made: TerminalModule[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((terminal) => terminal.dispose()))
  await cleanScratch()
})

async function setup(body: string, overrides: Partial<TerminalDeps> = {}) {
  const dir = await scratch()
  const plan = await stub(dir, body)
  const terminal = createTerminal({
    project: () => dir,
    env: { HOME: dir, PATH: process.env.PATH, SUBSTRATE_TOKEN: "dummy-token", SWARM_ED25519_KEY: "dummy-key", OPENROUTER_API_KEY: "dummy-key" },
    omp: async () => ({ argv: [plan.file, ...plan.args] }),
    shells: [],
    ...overrides,
  })
  made.push(terminal)
  return { terminal, dir }
}

async function call(terminal: TerminalModule, method: string, route: string, body?: unknown, headers: Record<string, string> = GOOD, base = ORIGIN) {
  const response = await terminal.handle(
    new Request(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  )
  if (!response) throw new Error("handler declined")
  return response
}

async function create(terminal: TerminalModule, kind: "omp" | "shell" = "omp", cols = 100, rows = 30): Promise<PtyTicket> {
  const response = await call(terminal, "POST", PTY_ROUTES.ticket, { create: { kind, cols, rows } })
  expect(response.status).toBe(200)
  return (await response.json()) as PtyTicket
}

const wsRequest = (id: string, query: string, headers: Record<string, string> = { origin: ORIGIN }, base = ORIGIN) =>
  new Request(`${base}${PTY_ROUTES.ws(id)}${query}`, { method: "GET", headers })

suite("the whole route", () => {
  test("ticket -> upgrade -> output -> list -> kill, and the ticket is one-shot", async () => {
    const { terminal } = await setup("echo from-omp-stub; read x; echo got:$x; read y")
    const ticket = await create(terminal)
    expect(ticket).toMatchObject({ kind: "omp", wsPath: PTY_ROUTES.ws(ticket.id) })
    expect(ticket.expiresAt).toBeGreaterThan(Date.now())
    expect(ticket.ticket).not.toContain("dummy-token")

    const upgrade = terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)
    expect(upgrade.ok).toBe(true)
    if (!upgrade.ok) return
    const sink = collector()
    const connection = upgrade.attach(sink)
    await sink.until(() => sink.output.includes("from-omp-stub"), "stub output")
    connection.message("hi\n")
    await sink.until(() => sink.output.includes("got:hi"), "echoed input")

    const reused = terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)
    expect(reused).toEqual({ ok: false, status: 403 })

    const listed = (await (await call(terminal, "GET", PTY_ROUTES.list, undefined, { [PTY_HEADER]: "1" })).json()) as PtyInfo[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: ticket.id, kind: "omp", state: "running", cols: 100, rows: 30 })

    const pid = listed[0]!.pid!
    const killed = await call(terminal, "DELETE", PTY_ROUTES.session(ticket.id))
    expect(killed.status).toBe(204)
    expect(sink.closed?.code).toBe(PTY_CLOSE.gone)
    expect(await goneWithin(pid)).toBe(true)
    expect((await call(terminal, "DELETE", PTY_ROUTES.session(ticket.id))).status).toBe(404)
    const after = (await (await call(terminal, "GET", PTY_ROUTES.list, undefined, { [PTY_HEADER]: "1" })).json()) as PtyInfo[]
    expect(after).toEqual([])
  })

  test("a second ticket attaches to the same session and resumes from the cursor in the URL", async () => {
    const { terminal } = await setup("echo one; read x; echo two; read y")
    const first = await create(terminal)
    const up1 = terminal.upgrade(wsRequest(first.id, `?ticket=${first.ticket}`), first.id)
    if (!up1.ok) throw new Error("upgrade refused")
    const a = collector()
    const connection = up1.attach(a)
    await a.until(() => a.output.includes("one"), "first part")
    const cursor = a.resume()
    connection.detach()

    const again = (await (await call(terminal, "POST", PTY_ROUTES.ticket, { id: first.id })).json()) as PtyTicket
    expect(again.id).toBe(first.id)
    expect(again.ticket).not.toBe(first.ticket)
    const up2 = terminal.upgrade(wsRequest(first.id, `?ticket=${again.ticket}&cursor=${cursor}`), first.id)
    if (!up2.ok) throw new Error("reattach refused")
    const b = collector()
    const second = up2.attach(b)
    expect(b.output).toBe("")
    second.message("go\n")
    await b.until(() => b.output.includes("two"), "second part")
    expect(a.output + b.output).toContain("one\r\n")
  })

  test("the child's environment holds no secret and has TERM", async () => {
    const { terminal } = await setup("env; read x")
    const ticket = await create(terminal)
    const up = terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)
    if (!up.ok) throw new Error("upgrade refused")
    const sink = collector()
    up.attach(sink)
    await sink.until(() => sink.output.includes("COLORTERM=truecolor"), "env listing")
    expect(sink.output).toContain("TERM=xterm-256color")
    expect(sink.output).toContain("HOME=")
    for (const secret of ["dummy-token", "dummy-key", "SUBSTRATE", "SWARM", "OPENROUTER"]) expect(sink.output).not.toContain(secret)
  })

  test("shell kind starts a real interactive shell in the project directory", async () => {
    const { terminal, dir } = await setup("")
    const ticket = await create(terminal, "shell")
    const up = terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)
    if (!up.ok) throw new Error("upgrade refused")
    const sink = collector()
    const connection = up.attach(sink)
    connection.message("echo ans=$((6*7)); pwd\n")
    await sink.until(() => sink.output.includes("ans=42"), "shell arithmetic")
    await sink.until(() => sink.output.includes(dir), "shell cwd")
    connection.message("exit 4\n")
    await sink.until(() => sink.controls.some((frame) => "exit" in frame), "exit frame")
    expect(sink.controls.at(-1)).toEqual({ exit: { code: 4, signal: null } })
  })

  test("the fifth terminal is refused with a 429 and its code", async () => {
    const { terminal } = await setup("read x")
    for (let i = 0; i < PTY_LIMITS.maxSessions; i++) await create(terminal)
    const refused = await call(terminal, "POST", PTY_ROUTES.ticket, { create: { kind: "omp", cols: 80, rows: 24 } })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: "limit" })
  })

  test("an unavailable omp is a 409 with an actionable message and starts nothing", async () => {
    const { terminal } = await setup("", { omp: async () => ({ error: "omp is not installed: put it on PATH or set its path in settings" }) })
    const response = await call(terminal, "POST", PTY_ROUTES.ticket, { create: { kind: "omp", cols: 80, rows: 24 } })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "omp is not installed: put it on PATH or set its path in settings", code: "omp-unavailable" })
    const listed = (await (await call(terminal, "GET", PTY_ROUTES.list)).json()) as PtyInfo[]
    expect(listed).toEqual([])
  })

  test("oversize cols/rows are clamped, not refused", async () => {
    const { terminal } = await setup("read x")
    const ticket = await create(terminal, "omp", 99_999, 99_999)
    const listed = (await (await call(terminal, "GET", PTY_ROUTES.list)).json()) as PtyInfo[]
    expect(listed.find((info) => info.id === ticket.id)).toMatchObject({ cols: PTY_LIMITS.maxCols, rows: PTY_LIMITS.maxRows })
  })
})

suite("policy table", () => {
  const create80 = { create: { kind: "omp", cols: 80, rows: 24 } }

  test.each([
    ["missing header", "POST", PTY_ROUTES.ticket, create80, { origin: ORIGIN }, ORIGIN, 403, "missing-header"],
    ["wrong origin", "POST", PTY_ROUTES.ticket, create80, { ...GOOD, origin: "https://evil.example" }, ORIGIN, 403, "bad-origin"],
    ["no origin on POST", "POST", PTY_ROUTES.ticket, create80, { [PTY_HEADER]: "1" }, ORIGIN, 403, "bad-origin"],
    ["non-loopback host", "POST", PTY_ROUTES.ticket, create80, { ...GOOD, origin: "http://evil.example" }, "http://evil.example", 403, "bad-host"],
    ["missing header on list", "GET", PTY_ROUTES.list, undefined, {}, ORIGIN, 403, "missing-header"],
    ["missing header on delete", "DELETE", PTY_ROUTES.session("x"), undefined, { origin: ORIGIN }, ORIGIN, 403, "missing-header"],
    ["unknown kind", "POST", PTY_ROUTES.ticket, { create: { kind: "bash", cols: 80, rows: 24 } }, GOOD, ORIGIN, 400, "bad-request"],
    ["argv in the body", "POST", PTY_ROUTES.ticket, { create: { kind: "shell", cols: 80, rows: 24, argv: ["id"] } }, GOOD, ORIGIN, 400, "bad-request"],
    ["not JSON", "POST", PTY_ROUTES.ticket, undefined, GOOD, ORIGIN, 400, "bad-request"],
    ["attach to nothing", "POST", PTY_ROUTES.ticket, { id: "nope" }, GOOD, ORIGIN, 404, "gone"],
    ["wrong method on ticket", "GET", PTY_ROUTES.ticket, undefined, GOOD, ORIGIN, 405, "method"],
    ["wrong method on list", "POST", PTY_ROUTES.list, create80, GOOD, ORIGIN, 405, "method"],
    ["wrong method on a session", "GET", PTY_ROUTES.session("x"), undefined, GOOD, ORIGIN, 405, "method"],
  ] as const)("%s", async (_name, method, route, body, headers, base, status, code) => {
    const { terminal } = await setup("read x")
    const response = await call(terminal, method, route, body, { ...headers }, base)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
    expect(((await (await call(terminal, "GET", PTY_ROUTES.list)).json()) as PtyInfo[]).length).toBe(0)
  })

  test("an oversize body is a 413", async () => {
    const { terminal } = await setup("read x")
    const response = await call(terminal, "POST", PTY_ROUTES.ticket, { id: "x".repeat(10_000) })
    expect(response.status).toBe(413)
  })

  test("FLOW_ALLOW_REMOTE=1 turns the whole terminal off, upgrade included", async () => {
    const { terminal } = await setup("read x", { allowRemote: true })
    const response = await call(terminal, "POST", PTY_ROUTES.ticket, create80)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "terminal-disabled" })
    expect((await call(terminal, "GET", PTY_ROUTES.list)).status).toBe(403)
    expect(terminal.upgrade(wsRequest("any", "?ticket=x"), "any")).toEqual({ ok: false, status: 403 })
  })

  test("routes that are not the terminal's are left to the next handler", async () => {
    const { terminal } = await setup("read x")
    for (const route of ["/flow/api/pipelines", "/flow/api/ptyx", "/other"]) {
      expect(await terminal.handle(new Request(`${ORIGIN}${route}`, { headers: GOOD }))).toBeUndefined()
    }
  })

  test("upgrade rows: bad, reused, wrong-session and absent tickets; wrong origin; non-loopback host; unknown session", async () => {
    const { terminal } = await setup("read x")
    const a = await create(terminal)
    const b = await create(terminal)

    expect(terminal.upgrade(wsRequest(a.id, "?ticket=bogus"), a.id)).toEqual({ ok: false, status: 403 })
    expect(terminal.upgrade(wsRequest(a.id, ""), a.id)).toEqual({ ok: false, status: 403 })
    expect(terminal.upgrade(wsRequest(a.id, `?ticket=${b.ticket}`), a.id)).toEqual({ ok: false, status: 403 })
    // b's ticket was spent by the attempt above, even against the wrong session.
    expect(terminal.upgrade(wsRequest(b.id, `?ticket=${b.ticket}`), b.id)).toEqual({ ok: false, status: 403 })
    expect(terminal.upgrade(wsRequest(a.id, `?ticket=${a.ticket}`, { origin: "https://evil.example" }), a.id)).toEqual({ ok: false, status: 403 })
    expect(terminal.upgrade(wsRequest(a.id, `?ticket=${a.ticket}`, {}), a.id)).toEqual({ ok: false, status: 403 })
    expect(
      terminal.upgrade(wsRequest(a.id, `?ticket=${a.ticket}`, { origin: "http://evil.example" }, "http://evil.example"), a.id),
    ).toEqual({ ok: false, status: 403 })
    expect(terminal.upgrade(new Request(`${ORIGIN}${PTY_ROUTES.ws(a.id)}?ticket=${a.ticket}`, { method: "POST", headers: { origin: ORIGIN } }), a.id)).toEqual({
      ok: false,
      status: 405,
    })
    expect(terminal.upgrade(wsRequest("missing", "?ticket=x"), "missing")).toEqual({ ok: false, status: 404 })

    // None of those refusals spent a's own ticket except the ones that consumed it: it is still good here.
    expect(terminal.upgrade(wsRequest(a.id, `?ticket=${a.ticket}`), a.id).ok).toBe(true)
  })

  test("an expired ticket is refused", async () => {
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const { terminal } = await setup("read x")
      const ticket = await create(terminal)
      now += PTY_LIMITS.ticketTtlMs + 1
      expect(terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)).toEqual({ ok: false, status: 403 })
    } finally {
      Date.now = realNow
    }
  })

  test("attaching to a session that was killed after the ticket was issued closes the sink as gone", async () => {
    const { terminal } = await setup("read x")
    const ticket = await create(terminal)
    const up = terminal.upgrade(wsRequest(ticket.id, `?ticket=${ticket.ticket}`), ticket.id)
    if (!up.ok) throw new Error("upgrade refused")
    await call(terminal, "DELETE", PTY_ROUTES.session(ticket.id))
    const sink = collector()
    up.attach(sink)
    expect(sink.closed?.code).toBe(PTY_CLOSE.gone)
  })
})
