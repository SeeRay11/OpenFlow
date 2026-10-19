import { describe, expect, test } from "bun:test"
import { PTY_HEADER, PTY_LIMITS } from "../../shared/terminal"
import { decodeServerFrame, encodeResize, readProblem, socketUrl, ticketInit } from "./terminal-frames"

const control = (value: unknown) => Uint8Array.from([0, ...new TextEncoder().encode(JSON.stringify(value))])

describe("decodeServerFrame", () => {
  test("text is output, verbatim", () => {
    expect(decodeServerFrame("ls\r\n\u001b[31mred")).toEqual({ kind: "output", text: "ls\r\n\u001b[31mred" })
    expect(decodeServerFrame("")).toEqual({ kind: "output", text: "" })
  })

  test("binary 0x00 + JSON is a cursor or an exit, from an ArrayBuffer or a view", () => {
    expect(decodeServerFrame(control({ cursor: 1234 }).buffer)).toEqual({ kind: "control", control: { cursor: 1234 } })
    expect(decodeServerFrame(control({ exit: { code: 3, signal: null } }))).toEqual({
      kind: "control",
      control: { exit: { code: 3, signal: null } },
    })
    expect(decodeServerFrame(control({ exit: { code: null, signal: "SIGHUP" } }))).toEqual({
      kind: "control",
      control: { exit: { code: null, signal: "SIGHUP" } },
    })
    // A view into a larger buffer must be read at its own offset.
    const padded = new Uint8Array(40)
    padded.set(control({ cursor: 7 }), 5)
    expect(decodeServerFrame(padded.subarray(5, 5 + control({ cursor: 7 }).length))).toEqual({ kind: "control", control: { cursor: 7 } })
  })

  test.each([
    ["a binary frame that is not a control", Uint8Array.from([1, 2, 3])],
    ["an empty binary frame", new Uint8Array(0)],
    ["bad JSON", Uint8Array.from([0, ...new TextEncoder().encode("{nope")])],
    ["JSON null", control(null)],
    ["an array", control([1])],
    ["an unknown control", control({ hello: "world" })],
    ["a non-numeric cursor", control({ cursor: "9" })],
    ["a non-finite cursor", Uint8Array.from([0, ...new TextEncoder().encode('{"cursor":1e999}')])],
    ["a malformed exit", control({ exit: { code: "3", signal: null } })],
    ["an exit without a signal field", control({ exit: { code: 1 } })],
    ["not a frame at all", 42],
    ["undefined", undefined],
  ])("ignores %s", (_name, data) => {
    expect(decodeServerFrame(data)).toEqual({ kind: "ignored" })
  })
})

describe("encodeResize", () => {
  test("0x00 + JSON, the shape the host decodes", () => {
    const bytes = encodeResize(120, 40)
    expect(bytes[0]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))).toEqual({ t: "resize", cols: 120, rows: 40 })
  })

  test("clamps to the host's limits and truncates fractions", () => {
    const decode = (cols: number, rows: number) => JSON.parse(new TextDecoder().decode(encodeResize(cols, rows).subarray(1)))
    expect(decode(5000, 5000)).toEqual({ t: "resize", cols: PTY_LIMITS.maxCols, rows: PTY_LIMITS.maxRows })
    expect(decode(1, 1)).toEqual({ t: "resize", cols: PTY_LIMITS.minCols, rows: PTY_LIMITS.minRows })
    expect(decode(80.9, 24.9)).toEqual({ t: "resize", cols: 80, rows: 24 })
    expect(decode(Number.NaN, Number.NaN)).toEqual({ t: "resize", cols: PTY_LIMITS.minCols, rows: PTY_LIMITS.minRows })
  })
})

describe("socketUrl", () => {
  const granted = { wsPath: "/flow/pty/abc-123/ws", ticket: "t.o/k+en=" }

  test("ws on http, wss on https, ticket encoded", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:5173" }, granted, 0)).toBe(
      "ws://127.0.0.1:5173/flow/pty/abc-123/ws?ticket=t.o%2Fk%2Ben%3D",
    )
    expect(socketUrl({ protocol: "https:", host: "localhost:4097" }, granted, 0)).toStartWith("wss://localhost:4097/")
  })

  test("a cursor resumes; zero replays everything", () => {
    const page = { protocol: "http:", host: "localhost:5173" }
    expect(socketUrl(page, granted, 0)).not.toContain("cursor")
    expect(socketUrl(page, granted, 4096)).toEndWith("&cursor=4096")
    expect(socketUrl(page, granted, 12.7)).toEndWith("&cursor=12")
  })
})

describe("ticketInit", () => {
  test("POST with the custom header and a JSON body", () => {
    const init = ticketInit({ create: { kind: "omp", cols: 100, rows: 30 } })
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ [PTY_HEADER]: "1", "content-type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual({ create: { kind: "omp", cols: 100, rows: 30 } })
    expect(JSON.parse(ticketInit({ id: "abc" }).body as string)).toEqual({ id: "abc" })
  })
})

describe("readProblem", () => {
  test("reads the host's {error, code}", async () => {
    const response = Response.json({ error: "omp is not installed", code: "omp-unavailable" }, { status: 409 })
    expect(await readProblem(response)).toEqual({ status: 409, message: "omp is not installed", code: "omp-unavailable" })
  })

  test("a body that is not that shape still gives an honest message", async () => {
    expect(await readProblem(new Response("<html>", { status: 502 }))).toEqual({ status: 502, message: "the host answered 502", code: undefined })
    expect(await readProblem(Response.json({ error: "", code: 5 }, { status: 500 }))).toEqual({
      status: 500,
      message: "the host answered 500",
      code: undefined,
    })
  })
})
