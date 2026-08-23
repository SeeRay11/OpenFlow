import { describe as suite, expect, test } from "bun:test"
import { describe, parseModel, formatModel } from "./client"

suite("describe", () => {
  test("prefers a message field over the raw body", () => {
    expect(describe({ message: "Model glm-4.7-free is not supported" })).toBe(
      "Model glm-4.7-free is not supported",
    )
  })

  test("reads the nested message the opencode server nests under data", () => {
    expect(describe({ data: { message: "no such agent" } })).toBe("no such agent")
  })

  test("reads an error field, which is the key the flow store answers with", () => {
    expect(describe({ error: "pipeline not found" })).toBe("pipeline not found")
  })

  test("prefers message over error when a body carries both", () => {
    expect(describe({ message: "engine is down", error: "engine is down" })).toBe("engine is down")
  })

  test("ignores a non-string error field rather than printing [object Object]", () => {
    expect(describe({ error: { code: 500 } })).toBe('{"error":{"code":500}}')
  })

  // Both hosts proxy `/api` to `opencode serve`, and both must render an
  // unreachable engine as a sentence. These are the literal bodies they emit;
  // a brace in the output means describe() fell through to JSON.stringify.
  test("renders both hosts' proxy failures as prose, never as JSON", () => {
    const bodies = [
      // server.ts, 502
      { message: "cannot reach opencode serve at http://127.0.0.1:4096: fetch failed" },
      // server.ts, 504
      {
        message:
          "opencode serve at http://127.0.0.1:4096 did not answer within 30s — it may have been restarted; retry",
      },
      // vite.config.ts, 502
      {
        message:
          "cannot reach opencode serve at http://127.0.0.1:4096 — start it with `bun openflow.ts` from the repo root",
      },
      // the shape server.ts used to emit, in case a host ever drifts back
      { error: "cannot reach opencode serve at http://127.0.0.1:4096: fetch failed" },
    ]
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    for (const body of bodies) {
      const rendered = describe(body, response)
      expect(rendered).not.toContain("{")
      expect(rendered).not.toContain("}")
      expect(rendered).toContain("opencode serve")
      expect(rendered).toEndWith("(HTTP 502 Bad Gateway)")
    }
  })

  test("falls back to the status when the body is empty", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    expect(describe({}, response)).toBe("HTTP 502 Bad Gateway")
  })

  test("names the effect failure tag when that is all the body carries", () => {
    expect(describe({ _tag: "ProviderAuthError" })).toBe("ProviderAuthError")
  })

  test("serializes a shape it does not recognise rather than losing it", () => {
    expect(describe({ reason: "nope", attempts: 2 })).toBe('{"reason":"nope","attempts":2}')
  })

  test("never renders an empty body as the string {}", () => {
    expect(describe({})).toBe("unknown error")
    expect(describe(undefined)).toBe("unknown error")
  })

  test("keeps both the reason and the status when both are known", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" })
    expect(describe({ message: "bad key" }, response)).toBe("bad key (HTTP 401 Unauthorized)")
  })

  test("a 2xx response contributes no status noise", () => {
    const response = new Response(null, { status: 200 })
    expect(describe("boom", response)).toBe("boom")
  })

  test("unwraps an Error's message", () => {
    expect(describe(new Error("network error"))).toBe("network error")
  })
})

suite("model refs", () => {
  test("splits on the first slash only", () => {
    expect(parseModel("opencode/glm-5.2")).toEqual({ providerID: "opencode", id: "glm-5.2" })
    expect(parseModel("openrouter/z-ai/glm-4.6")).toEqual({ providerID: "openrouter", id: "z-ai/glm-4.6" })
  })

  test("rejects values with no provider", () => {
    expect(parseModel("/glm-5.2")).toBeUndefined()
    expect(parseModel("glm-5.2")).toBeUndefined()
    expect(parseModel("")).toBeUndefined()
  })

  test("round-trips", () => {
    expect(formatModel(parseModel("opencode/glm-5.2"))).toBe("opencode/glm-5.2")
    expect(formatModel(undefined)).toBe("")
  })
})
