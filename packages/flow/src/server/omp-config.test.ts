import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_OMP_SETTINGS, OMP_ROUTES } from "../../shared/omp"
import { createOmpClient, type OmpClient } from "./omp-config"

type Seen = { method: string; path: string; body: unknown }

let seen: Seen[]
let reply: (request: Request, path: string) => Response
let server: ReturnType<typeof Bun.serve>
let client: OmpClient

beforeEach(() => {
  seen = []
  reply = () => Response.json({})
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      const text = await request.text()
      seen.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined })
      return reply(request, path)
    },
  })
  client = createOmpClient({ base: `http://127.0.0.1:${server.port}` })
})

afterEach(async () => {
  await server.stop(true)
})

describe("omp client", () => {
  test("status and settings are returned as sent", async () => {
    reply = (_request, path) =>
      Response.json(
        path === OMP_ROUTES.status
          ? { available: true, problems: [], warnings: [], profile: "openflow", minVersion: "18.12.2", checkedAt: 1 }
          : { settings: DEFAULT_OMP_SETTINGS, effective: {}, warnings: [] },
      )
    const status = await client.status()
    expect(status.ok && status.value.profile).toBe("openflow")
    const settings = await client.settings()
    expect(settings.ok && settings.value.settings).toEqual(DEFAULT_OMP_SETTINGS)
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([`GET ${OMP_ROUTES.status}`, `GET ${OMP_ROUTES.settings}`])
  })

  test("saveSettings PUTs the patch as the body and resetSettings POSTs", async () => {
    reply = () => Response.json({ settings: DEFAULT_OMP_SETTINGS, effective: {}, warnings: [] })
    await client.saveSettings({ profile: "work", uplift: { hitl: true } })
    await client.resetSettings()
    expect(seen).toEqual([
      { method: "PUT", path: OMP_ROUTES.settings, body: { profile: "work", uplift: { hitl: true } } },
      { method: "POST", path: OMP_ROUTES.settingsReset, body: undefined },
    ])
  })

  test("a 422 carries the server's field errors", async () => {
    reply = () =>
      Response.json(
        { error: "settings were not saved", errors: [{ path: "uplift.timeoutMs", message: "too small" }, { nonsense: true }] },
        { status: 422 },
      )
    const result = await client.saveSettings({ uplift: { timeoutMs: 1 } })
    expect(result).toEqual({ ok: false, status: 422, errors: [{ path: "uplift.timeoutMs", message: "too small" }] })
  })

  test("an error body without a field list becomes one unattached error", async () => {
    reply = () => Response.json({ error: "omp was not found", code: "omp-unavailable" }, { status: 503 })
    expect(await client.config()).toEqual({ ok: false, status: 503, errors: [{ path: "", message: "omp was not found" }] })
  })

  test("a body that is not JSON still yields a readable error with the status", async () => {
    reply = () => new Response("<html>bad gateway</html>", { status: 502 })
    const result = await client.providers()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.errors[0]?.message).toContain("502")
    }
  })

  test("config unwraps the entries list", async () => {
    reply = () => Response.json({ entries: [{ key: "a", type: "boolean", description: "", value: true, editable: true }] })
    const result = await client.config()
    expect(result.ok && result.value.map((entry) => entry.key)).toEqual(["a"])
  })

  test("setConfig percent-encodes the key and sends { value }; resetConfig POSTs /reset", async () => {
    reply = () => Response.json({ entry: { key: "a b/c", type: "string", description: "", value: "x", editable: true } })
    const set = await client.setConfig("a b/c", "x")
    const reset = await client.resetConfig("a b/c")
    expect(set.ok && set.value.key).toBe("a b/c")
    expect(reset.ok).toBe(true)
    expect(seen).toEqual([
      { method: "PUT", path: `${OMP_ROUTES.config}/a%20b%2Fc`, body: { value: "x" } },
      { method: "POST", path: `${OMP_ROUTES.config}/a%20b%2Fc/reset`, body: undefined },
    ])
  })

  test("providers unwraps the rows", async () => {
    reply = () => Response.json({ providers: [{ id: "a", name: "A", available: true, authenticated: false }] })
    const result = await client.providers()
    expect(result.ok && result.value).toEqual([{ id: "a", name: "A", available: true, authenticated: false }])
  })

  test("importAuth POSTs without a body and returns the count and fresh status", async () => {
    const status = { available: true, problems: [], warnings: [], profile: "openflow", minVersion: "18.12.2", checkedAt: 1 }
    reply = () => Response.json({ imported: 2, status })
    const result = await client.importAuth()
    expect(result).toEqual({ ok: true, value: { imported: 2, status } })
    expect(seen).toEqual([{ method: "POST", path: OMP_ROUTES.authImport, body: undefined }])
  })

  test("importAuth carries the host's sentence when it refuses", async () => {
    reply = () => Response.json({ error: "Your default omp profile has no logins to copy. Run omp and use /login there first." }, { status: 400 })
    expect(await client.importAuth()).toEqual({
      ok: false,
      status: 400,
      errors: [{ path: "", message: "Your default omp profile has no logins to copy. Run omp and use /login there first." }],
    })
  })

  test("a host that is not listening is status 0, never a throw", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const base = `http://127.0.0.1:${closed.port}`
    await closed.stop(true)
    const result = await createOmpClient({ base }).status()
    expect(result).toEqual({ ok: false, status: 0, errors: [{ path: "", message: "The OpenFlow host did not answer." }] })
  })
})
