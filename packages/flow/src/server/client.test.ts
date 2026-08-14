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

  test("falls back to the status when the body is empty", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    expect(describe({}, response)).toBe("HTTP 502 Bad Gateway")
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
