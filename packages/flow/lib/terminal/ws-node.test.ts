import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import type { ViteDevServer } from "vite"
import { WebSocket } from "ws"
import { PTY_CLOSE, PTY_HEADER, PTY_LIMITS, PTY_ROUTES } from "../../shared/terminal"
import type { PtyTicket } from "../../shared/terminal"
import { flowPty } from "../../vite/flow-pty"
import { createTerminal } from "./index"
import type { TerminalModule } from "./index"
import { cleanScratch, collector, decodeControl, goneWithin, resizeFrame, scratch, stub } from "./test-harness"
import { attachNodeUpgrade } from "./ws-node"

// Real PTYs, `/bin/sh` and POSIX process groups: nothing in this file runs on Windows.
const suite = describe.skipIf(process.platform === "win32")

/**
 * The vite dev host's transport: a plain `node:http` server standing in for
 * vite's, the `ws` package as the client, and `flowPty` wired the way vite wires
 * a plugin. Runs on whatever runtime executes the test; the Node-only PTY
 * backend has its own test (`pty-node.test.ts`).
 */

const servers: Server[] = []
const terminals: TerminalModule[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    const closing = Promise.withResolvers<void>()
    server.close(() => closing.resolve())
    await closing.promise
  }
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()))
  await cleanScratch()
})

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** `via` picks how the upgrade is attached: the raw function or the vite plugin. */
async function boot(script: string, via: "attach" | "plugin", extraUpgrade?: (url: string) => void) {
  const dir = await scratch()
  const plan = await stub(dir, script)
  const terminal = createTerminal({
    project: () => dir,
    env: { PATH: process.env.PATH },
    omp: async () => ({ argv: [plan.file, ...plan.args] }),
    shells: [],
  })
  terminals.push(terminal)

  const server = createServer(async (request, response) => {
    const payload = await body(request)
    const handled = await terminal.handle(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)])),
        body: payload.length ? new Uint8Array(payload) : undefined,
      }),
    )
    response.statusCode = handled?.status ?? 404
    response.end(handled ? await handled.text() : "")
  })
  servers.push(server)
  // Vite's own HMR upgrade listener: it must keep receiving what is not ours.
  server.on("upgrade", (request, socket) => {
    if (!request.url?.startsWith("/flow/pty/")) {
      extraUpgrade?.(request.url ?? "")
      socket.destroy()
    }
  })
  if (via === "attach") attachNodeUpgrade(server, terminal)
  else (flowPty(terminal).configureServer as (server: ViteDevServer) => void)({ httpServer: server } as unknown as ViteDevServer)

  const listening = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { terminal, server, base: `http://127.0.0.1:${address.port}` }
}

async function ticket(base: string, payload: unknown): Promise<PtyTicket> {
  const response = await fetch(`${base}${PTY_ROUTES.ticket}`, {
    method: "POST",
    headers: { [PTY_HEADER]: "1", origin: base, "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as PtyTicket
}

function connect(base: string, granted: PtyTicket, options: { origin?: string | null; cursor?: number } = {}) {
  const origin = options.origin === undefined ? base : options.origin
  const url = `${base.replace("http", "ws")}${granted.wsPath}?ticket=${granted.ticket}${options.cursor === undefined ? "" : `&cursor=${options.cursor}`}`
  const socket = new WebSocket(url, { headers: origin === null ? {} : { Origin: origin } })
  clients.push(socket)
  const received = collector()
  const state: { open: boolean; status?: number } = { open: false }
  socket.on("open", () => {
    state.open = true
  })
  socket.on("unexpected-response", (_request, response) => {
    state.status = response.statusCode
    response.resume()
    received.close(0, "refused")
  })
  socket.on("error", () => {})
  socket.on("message", (data, binary) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (binary) received.control(decodeControl(new Uint8Array(bytes)))
    else received.text(bytes.toString("utf8"))
  })
  socket.on("close", (code, reason) => {
    if (received.closed === undefined) received.close(code, reason.toString())
  })
  return { socket, received, state }
}

suite.each(["attach", "plugin"] as const)("node transport (%s)", (via) => {
  test("create, type, resize, exit over a real socket", async () => {
    const { base } = await boot("stty size; read x; echo got:$x; stty size; read y; exit 6", via)
    const granted = await ticket(base, { create: { kind: "omp", cols: 100, rows: 30 } })
    const { socket, received } = connect(base, granted)
    await received.until(() => received.output.includes("30 100"), "initial size")
    socket.send(resizeFrame(140, 50), { binary: true })
    socket.send("hello\n")
    await received.until(() => received.output.includes("got:hello") && received.output.includes("50 140"), "echo and resize")
    socket.send("bye\n")
    await received.until(() => received.closed !== undefined, "close after exit")
    expect(received.controls.at(-1)).toEqual({ exit: { code: 6, signal: null } })
    expect(received.closed?.code).toBe(PTY_CLOSE.normal)
  })

  test("reconnect with a new ticket and a cursor", async () => {
    const { base } = await boot("echo alpha; read x; echo beta; read y", via)
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const first = connect(base, granted)
    await first.received.until(() => first.received.output.includes("alpha"), "alpha")
    const cursor = first.received.resume()
    first.socket.close(1000)
    await first.received.until(() => first.received.closed !== undefined, "closed")

    const second = connect(base, await ticket(base, { id: granted.id }), { cursor })
    await second.received.until(() => second.received.controls.length > 0, "cursor frame")
    second.socket.send("go\n")
    await second.received.until(() => second.received.output.includes("beta"), "beta")
    expect(second.received.output).not.toContain("alpha")
  })

  test("refusals are HTTP statuses before any upgrade: Origin, missing Origin, reused ticket, unknown session", async () => {
    const { base } = await boot("read x", via)
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })

    const wrong = connect(base, granted, { origin: "https://evil.example" })
    await wrong.received.until(() => wrong.received.closed !== undefined, "wrong origin refused")
    expect(wrong.state).toEqual({ open: false, status: 403 })

    const none = connect(base, granted, { origin: null })
    await none.received.until(() => none.received.closed !== undefined, "no origin refused")
    expect(none.state).toEqual({ open: false, status: 403 })

    const good = connect(base, granted)
    await good.received.until(() => good.received.controls.length > 0, "first use")
    const reused = connect(base, granted)
    await reused.received.until(() => reused.received.closed !== undefined, "reuse refused")
    expect(reused.state).toEqual({ open: false, status: 403 })

    const missing = connect(base, { ...granted, wsPath: PTY_ROUTES.ws("nope") })
    await missing.received.until(() => missing.received.closed !== undefined, "unknown refused")
    expect(missing.state).toEqual({ open: false, status: 404 })
  })

  test("upgrades that are not /flow/pty/<id>/ws are left to the other listeners", async () => {
    const seen: string[] = []
    const { base } = await boot("read x", via, (url) => seen.push(url))
    const other = new WebSocket(`${base.replace("http", "ws")}/__vite_hmr`, { headers: { Origin: base } })
    clients.push(other)
    const closed = Promise.withResolvers<void>()
    other.on("error", () => closed.resolve())
    other.on("close", () => closed.resolve())
    await closed.promise
    expect(seen).toEqual(["/__vite_hmr"])
  })

  // Under real Node `ws` closes the socket itself (1009, maxPayload); Bun's `ws`
  // shim does not enforce maxPayload, so the module's own cap is what holds. Either
  // way the oversize frame must never reach the pty and the session must survive.
  test("an oversize input frame never reaches the pty; the session survives", async () => {
    const { base } = await boot("read x; echo got:$x; read y", via)
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const first = connect(base, granted)
    await first.received.until(() => first.received.controls.length > 0, "attached")
    first.socket.send("a".repeat(PTY_LIMITS.inputFrameBytes + 1))
    first.socket.close(1000)
    await first.received.until(() => first.received.closed !== undefined, "first socket closed")

    const second = connect(base, await ticket(base, { id: granted.id }))
    await second.received.until(() => second.received.controls.length > 0, "reattached")
    second.socket.send("ok\n")
    await second.received.until(() => second.received.output.includes("got:ok"), "later input still works")
    expect(second.received.output).not.toContain("got:aaa")
  })
})

suite("vite plugin lifecycle", () => {
  test("closing the http server disposes the terminal: no shell, no grandchild left", async () => {
    const { base, server } = await boot("sleep 300 & echo CHILD:$!; wait", "plugin")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const { received } = connect(base, granted)
    await received.until(() => /CHILD:\d+/.test(received.output), "grandchild pid")
    const grandchild = Number(/CHILD:(\d+)/.exec(received.output)![1])

    server.closeAllConnections()
    const closing = Promise.withResolvers<void>()
    server.close(() => closing.resolve())
    await closing.promise
    expect(await goneWithin(grandchild, 5000)).toBe(true)
  })
})

test("a plugin on a server with no http server does nothing", () => {
  const terminal = createTerminal({ project: () => "/", omp: async () => ({ error: "unused" }) })
  terminals.push(terminal)
  expect(() => (flowPty(terminal).configureServer as (server: ViteDevServer) => void)({ httpServer: null } as unknown as ViteDevServer)).not.toThrow()
})
