import { afterEach, describe, expect, test } from "bun:test"
import { PTY_CLOSE, PTY_HEADER, PTY_LIMITS, PTY_ROUTES } from "../../shared/terminal"
import type { PtyTicket } from "../../shared/terminal"
import { createTerminal } from "./index"
import type { TerminalModule } from "./index"
import { cleanScratch, collector, decodeControl, firstCursor, goneWithin, resizeFrame, scratch, stub } from "./test-harness"
import type { Collector } from "./test-harness"
import { bunWebSocket } from "./ws-bun"

// Real PTYs, `/bin/sh` and POSIX process groups: nothing in this file runs on Windows.
const suite = describe.skipIf(process.platform === "win32")

/**
 * The Bun transport over a real `Bun.serve` on port 0 and the real WebSocket
 * client: framing, tickets, Origin, replay, and that nothing outlives the host.
 */

const terminals: TerminalModule[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) await server.stop(true)
  await Promise.all(terminals.splice(0).map((terminal) => terminal.dispose()))
  await cleanScratch()
})

async function boot(body: string) {
  const dir = await scratch()
  const plan = await stub(dir, body)
  const terminal = createTerminal({
    project: () => dir,
    env: { PATH: process.env.PATH },
    omp: async () => ({ argv: [plan.file, ...plan.args] }),
    shells: [],
  })
  terminals.push(terminal)
  const transport = bunWebSocket(terminal)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const upgraded = transport.fetch(request, server)
      if (upgraded instanceof Response) return upgraded
      if (upgraded) return undefined
      return (await terminal.handle(request)) ?? new Response("not found", { status: 404 })
    },
    websocket: transport.websocket,
  })
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  return { terminal, base, origin: base }
}

async function ticket(base: string, body: unknown, origin = base): Promise<PtyTicket> {
  const response = await fetch(`${base}${PTY_ROUTES.ticket}`, {
    method: "POST",
    headers: { [PTY_HEADER]: "1", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as PtyTicket
}

function connect(base: string, granted: PtyTicket, options: { origin?: string | null; cursor?: number; ticket?: string } = {}) {
  const url = `${base.replace("http", "ws")}${granted.wsPath}?ticket=${options.ticket ?? granted.ticket}${options.cursor === undefined ? "" : `&cursor=${options.cursor}`}`
  const origin = options.origin === undefined ? base : options.origin
  // Bun's WebSocket takes upgrade headers; lib.dom's constructor options do not know them.
  const socket = new WebSocket(url, { headers: origin === null ? {} : { Origin: origin } } as unknown as string[])
  sockets.push(socket)
  socket.binaryType = "arraybuffer"
  const received = collector()
  const state = { open: false }
  socket.onopen = () => {
    state.open = true
  }
  socket.onmessage = (event) => {
    if (typeof event.data === "string") received.text(event.data)
    else received.control(decodeControl(new Uint8Array(event.data as ArrayBuffer)))
  }
  socket.onclose = (event) => received.close(event.code, event.reason)
  return { socket, received, state }
}

const closedBeforeOpen = async (received: Collector, state: { open: boolean }) => {
  await received.until(() => received.closed !== undefined, "close")
  expect(state.open).toBe(false)
}

suite("Bun.serve transport", () => {
  test("create, type, resize, exit: text out, binary controls both ways, clean close", async () => {
    const { base } = await boot("stty size; read x; echo got:$x; stty size; read y; exit 5")
    const granted = await ticket(base, { create: { kind: "omp", cols: 100, rows: 30 } })
    const { socket, received, state } = connect(base, granted)
    await received.until(() => received.output.includes("30 100"), "initial size")
    expect(state.open).toBe(true)
    // The stub may have printed before the socket attached: replay text comes first, then the cursor frame.
    await received.until(() => received.controls.length > 0, "cursor frame")
    expect(received.resume()).toBe(received.output.length)

    socket.send(resizeFrame(130, 45))
    socket.send("hello\n")
    await received.until(() => received.output.includes("got:hello"), "echo")
    await received.until(() => received.output.includes("45 130"), "resized")

    socket.send("bye\n")
    await received.until(() => received.closed !== undefined, "close after exit")
    expect(received.controls.at(-1)).toEqual({ exit: { code: 5, signal: null } })
    expect(received.closed?.code).toBe(PTY_CLOSE.normal)
  })

  test("reconnecting with a fresh ticket and the cursor replays exactly what was missed", async () => {
    const { base } = await boot("echo alpha; read x; echo beta; read y; echo gamma; read z")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const first = connect(base, granted)
    await first.received.until(() => first.received.output.includes("alpha"), "alpha")
    first.socket.send("1\n")
    await first.received.until(() => first.received.output.includes("beta"), "beta")
    const cursor = first.received.resume()
    first.socket.close(1000)
    await first.received.until(() => first.received.closed !== undefined, "first closed")

    const again = await ticket(base, { id: granted.id })
    const second = connect(base, again, { cursor })
    await second.received.until(() => second.received.controls.some((frame) => "cursor" in frame), "cursor frame")
    expect(second.received.output).toBe("")
    expect(firstCursor(second.received)).toBeGreaterThanOrEqual(cursor)
    second.socket.send("2\n")
    await second.received.until(() => second.received.output.includes("gamma"), "gamma")
    expect(second.received.output).not.toContain("alpha")
    expect(second.received.output).not.toContain("beta")

    // Cursor omitted: the whole retained scrollback.
    const full = connect(base, await ticket(base, { id: granted.id }))
    await full.received.until(() => full.received.output.includes("gamma"), "full replay")
    expect(full.received.output).toContain("alpha")
  })

  test("an exited session reconnects to its output and exit, then closes", async () => {
    const { base } = await boot("echo done-now; exit 2")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const live = connect(base, granted)
    await live.received.until(() => live.received.closed !== undefined, "exit close")

    const later = connect(base, await ticket(base, { id: granted.id }))
    await later.received.until(() => later.received.closed !== undefined, "replay close")
    expect(later.received.output).toContain("done-now")
    expect(later.received.controls.at(-1)).toEqual({ exit: { code: 2, signal: null } })
    expect(later.received.closed?.code).toBe(PTY_CLOSE.normal)
  })

  test.each([
    ["wrong origin", { origin: "https://evil.example" }],
    ["no origin", { origin: null }],
    ["origin on another port", { origin: "http://127.0.0.1:1" }],
    ["a bogus ticket", { ticket: "bogus" }],
  ])("refused: %s", async (_name, options) => {
    const { base } = await boot("read x")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const refused = connect(base, granted, options)
    await closedBeforeOpen(refused.received, refused.state)
  })

  test("a ticket is single-use at the socket too; so is one for another session", async () => {
    const { base } = await boot("read x")
    const a = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const b = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const good = connect(base, a)
    await good.received.until(() => good.state.open && good.received.controls.length > 0, "first connection")

    const reused = connect(base, a)
    await closedBeforeOpen(reused.received, reused.state)

    const crossed = connect(base, { ...a, ticket: b.ticket })
    await closedBeforeOpen(crossed.received, crossed.state)
  })

  test("an unknown session and a non-terminal path are not upgraded", async () => {
    const { base } = await boot("read x")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const missing = connect(base, { ...granted, wsPath: PTY_ROUTES.ws("nope") })
    await closedBeforeOpen(missing.received, missing.state)

    const other = connect(base, { ...granted, wsPath: "/flow/something-else" })
    await closedBeforeOpen(other.received, other.state)
  })

  test("an input frame past the cap closes the socket and the session survives", async () => {
    const { base, terminal } = await boot("read x; echo got:$x; read y")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const { socket, received } = connect(base, granted)
    await received.until(() => received.controls.length > 0, "attached")
    socket.send("a".repeat(PTY_LIMITS.inputFrameBytes + 1))
    await received.until(() => received.closed !== undefined, "closed for the oversize frame")
    expect(received.output).not.toContain("got:")

    const info = await terminal.handle(
      new Request(`${base}${PTY_ROUTES.list}`, { headers: { [PTY_HEADER]: "1", origin: base } }),
    )
    expect(((await info!.json()) as { state: string }[])[0]?.state).toBe("running")
  })

  test("closing the socket leaves the process; dispose then takes it and its children", async () => {
    const { base, terminal } = await boot("sleep 300 & echo CHILD:$!; wait")
    const granted = await ticket(base, { create: { kind: "omp", cols: 80, rows: 24 } })
    const { socket, received } = connect(base, granted)
    await received.until(() => /CHILD:\d+/.test(received.output), "grandchild pid")
    const grandchild = Number(/CHILD:(\d+)/.exec(received.output)![1])
    socket.close(1000)
    await received.until(() => received.closed !== undefined, "socket closed")
    expect(await goneWithin(grandchild, 200)).toBe(false)

    await terminal.dispose()
    expect(await goneWithin(grandchild)).toBe(true)
  })
})
