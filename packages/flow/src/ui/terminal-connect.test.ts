import { describe, expect, test } from "bun:test"
import type { PtyTicket } from "../../shared/terminal"
import { createRemembered, requestTicket, singleFlight } from "./terminal-connect"

const ticket: PtyTicket = { id: "pty-1", ticket: "t", kind: "shell", expiresAt: 1, wsPath: "/flow/pty/pty-1/ws" }

describe("remembered sessions", () => {
  test("a session is found again only in the project and kind it was started for", () => {
    const remembered = createRemembered()
    remembered.set("/work/a", "shell", "pty-a")
    remembered.set("/work/a", "omp", "pty-a-omp")

    expect(remembered.get("/work/a", "shell")).toBe("pty-a")
    expect(remembered.get("/work/a", "omp")).toBe("pty-a-omp")
    // Switching to another project must not reattach project a's shell.
    expect(remembered.get("/work/b", "shell")).toBeUndefined()
  })

  test("projects whose names would collide when joined stay apart, and forgetting touches one entry", () => {
    const remembered = createRemembered()
    remembered.set("/work/shell", "omp", "one")
    remembered.set("/work", "shell", "two")
    remembered.forget("/work", "shell")

    expect(remembered.get("/work", "shell")).toBeUndefined()
    expect(remembered.get("/work/shell", "omp")).toBe("one")
  })
})

describe("requestTicket", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  test("a current reply is granted", async () => {
    expect(await requestTicket(async () => json(ticket), () => true)).toEqual({ type: "granted", ticket })
  })

  test("a reply that arrives after the attempt was replaced changes nothing", async () => {
    expect(await requestTicket(async () => json(ticket), () => false)).toEqual({ type: "stale" })
  })

  test("a ticket that finished parsing after the switch is handed back, for the caller to dispose of", async () => {
    // Current after the fetch, superseded while the body was being read: the old code installed this one.
    let checks = 0
    const outcome = await requestTicket(async () => json(ticket), () => ++checks === 1)

    expect(outcome).toEqual({ type: "stale", ticket })
  })

  test("an error body read after the attempt was replaced is dropped", async () => {
    let checks = 0
    const outcome = await requestTicket(async () => json({ error: "gone", code: "gone" }, 404), () => ++checks === 1)

    expect(outcome).toEqual({ type: "stale" })
  })

  test("a refusal reports the host's status and code", async () => {
    expect(await requestTicket(async () => json({ error: "no such session", code: "gone" }, 404), () => true)).toEqual({
      type: "failed",
      status: 404,
      message: "no such session",
      code: "gone",
    })
  })

  test("a network failure is the host being unreachable only while the attempt is current", async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError("fetch failed")
    }

    expect(await requestTicket(down, () => true)).toEqual({ type: "network" })
    expect(await requestTicket(down, () => false)).toEqual({ type: "stale" })
  })
})

describe("singleFlight", () => {
  test("callers arriving while the load runs share it", async () => {
    let starts = 0
    const gate = Promise.withResolvers<string>()
    const load = singleFlight(() => {
      starts++
      return gate.promise
    })

    const first = load()
    const second = load()
    gate.resolve("emulator")

    expect(await Promise.all([first, second])).toEqual(["emulator", "emulator"])
    expect(starts).toBe(1)
  })

  test("a failed load can be tried again", async () => {
    let starts = 0
    const load = singleFlight(async () => {
      starts++
      if (starts === 1) throw new Error("wasm failed to load")
      return "emulator"
    })

    await expect(load()).rejects.toThrow("wasm failed to load")
    expect(await load()).toBe("emulator")
    expect(starts).toBe(2)
  })
})
