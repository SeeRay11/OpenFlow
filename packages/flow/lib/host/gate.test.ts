import { describe, expect, test } from "bun:test"
import { apiRefusal, createGate, loopbackHost, rawPathRefusal, sameOrigin } from "./gate"
import { isJsonContentType } from "./respond"

function request(host: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers = { host, ...init.headers, ...(init.body === undefined ? {} : { "content-length": String(init.body.length) }) }
  return new Request("http://127.0.0.1:9/flow/api/anything", { method: init.method ?? "GET", headers, body: init.body })
}

const JSON_BODY = { "content-type": "application/json" }

describe("loopbackHost", () => {
  test.each([
    ["localhost", true],
    ["localhost:5173", true],
    ["LOCALHOST:5173", true],
    ["127.0.0.1", true],
    ["127.0.0.1:4097", true],
    ["[::1]", true],
    ["[::1]:4097", true],
    ["example.com", false],
    ["localhost.evil.com", false],
    ["127.0.0.1.evil.com", false],
    ["evil.com:80@localhost", false],
    ["localhost@evil.example", false],
    ["localhost:80@evil.example", false],
    ["192.168.1.5:5173", false],
    ["0.0.0.0:5173", false],
    ["localhost:notaport", false],
    ["localhost:123456", false],
    ["localhost:99999", false],
    ["localhost:65535", true],
    ["localhost%00.evil.example", false],
    ["evil.example#localhost", false],
    ["::1", false],
    ["", false],
  ])("%s", (host, expected) => expect(loopbackHost(host)).toBe(expected))

  test("a missing host is not loopback", () => expect(loopbackHost(null)).toBe(false))
})

describe("sameOrigin", () => {
  test.each([
    ["http://localhost:5173", "localhost:5173", true],
    ["https://localhost:5173", "localhost:5173", true],
    ["HTTP://LOCALHOST:5173", "localhost:5173", true],
    ["http://[::1]:5173", "[::1]:5173", true],
    ["http://localhost:5174", "localhost:5173", false],
    ["http://localhost", "localhost:5173", false],
    ["http://localhost:5173/", "localhost:5173", false],
    ["http://localhost:5173/x", "localhost:5173", false],
    ["http://localhost@evil.example", "localhost", false],
    ["http://localhost:5173@evil.example", "localhost:5173", false],
    ["http://evil.example", "localhost:5173", false],
    ["ftp://localhost:5173", "localhost:5173", false],
    ["null", "localhost:5173", false],
    ["", "localhost:5173", false],
  ])("%s against %s", (origin, host, expected) => expect(sameOrigin(origin, host)).toBe(expected))

  test("no origin is not a match", () => expect(sameOrigin(null, "localhost")).toBe(false))
})

describe("isJsonContentType", () => {
  test.each([
    ["application/json", true],
    ["Application/JSON", true],
    ["application/json; charset=utf-8", true],
    ["application/json;charset=UTF-8", true],
    [" application/json ", true],
    ["text/plain", false],
    ["application/x-www-form-urlencoded", false],
    ["multipart/form-data; boundary=x", false],
    ["application/jsonp", false],
    ["application/ld+json", false],
    ["text/plain; application/json", false],
    ["", false],
  ])("%s", (type, expected) => expect(isJsonContentType(type)).toBe(expected))

  test("a missing header is not JSON", () => expect(isJsonContentType(null)).toBe(false))
})

describe("apiRefusal: Host", () => {
  test.each(["localhost", "localhost:5173", "127.0.0.1:5174", "[::1]:5174", "LOCALHOST:5173"])("%s passes", (host) => {
    expect(apiRefusal(request(host), false)).toBeUndefined()
  })

  test.each(["evil.example", "evil.example:5174", "localhost@evil.example", "localhost.evil.example:5173", "192.168.1.5:5174", "0.0.0.0:5174"])(
    "%s is refused as forbidden-host",
    (host) => expect(apiRefusal(request(host), false)).toMatchObject({ status: 403, code: "forbidden-host" }),
  )

  test("a rebinding Host is refused even with a matching Origin, as a GET", () => {
    expect(apiRefusal(request("evil.example", { headers: { origin: "http://evil.example" } }), false)).toMatchObject({ code: "forbidden-host" })
  })

  test("FLOW_ALLOW_REMOTE lifts the Host rule only; the other rules still hold", () => {
    expect(apiRefusal(request("openflow.lan:5174"), true)).toBeUndefined()
    expect(apiRefusal(request("openflow.lan:5174", { headers: { origin: "http://openflow.lan:5174" } }), true)).toBeUndefined()
    expect(apiRefusal(request("openflow.lan:5174", { headers: { origin: "http://evil.example" } }), true)).toMatchObject({ code: "forbidden-origin" })
    expect(apiRefusal(request("openflow.lan:5174", { headers: { "sec-fetch-site": "cross-site" } }), true)).toMatchObject({ code: "forbidden-origin" })
  })

  test("a request with no Host header is judged by its URL's host", () => {
    expect(apiRefusal(new Request("http://localhost:5173/flow/api/x"), false)).toBeUndefined()
    // The URL names a non-loopback host, so the rule applies even with no Host header.
    expect(apiRefusal(new Request("http://evil.example/flow/api/x"), false)).toMatchObject({ code: "forbidden-host" })
  })
})

describe("apiRefusal: Origin", () => {
  test.each(["http://localhost:5173", "https://localhost:5173", "HTTP://localhost:5173"])("%s on Host localhost:5173 passes", (origin) => {
    expect(apiRefusal(request("localhost:5173", { headers: { origin } }), false)).toBeUndefined()
  })

  test.each([
    ["another site", "https://evil.example"],
    ["another loopback port", "http://localhost:5999"],
    ["another loopback name", "http://127.0.0.1:5173"],
    ["a missing port", "http://localhost"],
    ["userinfo in front of the real host", "http://localhost:5173@evil.example"],
    ["userinfo in front of a bare localhost", "http://localhost@evil.example"],
    ["a trailing path", "http://localhost:5173/"],
    ["a sandboxed frame", "null"],
    ["an empty value", ""],
  ])("%s is refused as forbidden-origin", (_name, origin) => {
    expect(apiRefusal(request("localhost:5173", { headers: { origin } }), false)).toMatchObject({ status: 403, code: "forbidden-origin" })
  })

  test("a request without an Origin passes: curl, scripts, the eval tooling", () => {
    expect(apiRefusal(request("localhost:5173", { method: "POST", headers: JSON_BODY, body: "{}" }), false)).toBeUndefined()
  })
})

describe("apiRefusal: Sec-Fetch-Site", () => {
  test.each(["same-origin", "none"])("%s passes", (site) => {
    expect(apiRefusal(request("localhost:5173", { headers: { "sec-fetch-site": site } }), false)).toBeUndefined()
  })

  test.each(["cross-site", "same-site", "", "weird"])("%j is refused", (site) => {
    expect(apiRefusal(request("localhost:5173", { headers: { "sec-fetch-site": site } }), false)).toMatchObject({ status: 403, code: "forbidden-origin" })
  })

  test("a same-site sibling port is refused even though its Origin header is absent", () => {
    // Browsers omit Origin on same-origin GETs, so Sec-Fetch-Site is the only signal on a cross-port GET (e.g. an <img>/fetch no-cors).
    expect(apiRefusal(request("localhost:5173", { headers: { "sec-fetch-site": "same-site" } }), false)).toMatchObject({ code: "forbidden-origin" })
  })
})

describe("apiRefusal: Content-Type", () => {
  const post = (headers: Record<string, string>, body = '{"a":1}') => request("localhost:5173", { method: "POST", headers, body })

  test("a JSON body passes, with or without a charset", () => {
    expect(apiRefusal(post(JSON_BODY), false)).toBeUndefined()
    expect(apiRefusal(post({ "content-type": "application/json; charset=utf-8" }), false)).toBeUndefined()
  })

  test.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])("a body typed %j is refused", (type) => {
    expect(apiRefusal(post(type ? { "content-type": type } : {}), false)).toMatchObject({ status: 403, code: "forbidden-content-type" })
  })

  test("a chunked body without a type is refused", () => {
    expect(apiRefusal(request("localhost:5173", { method: "POST", headers: { "transfer-encoding": "chunked" } }), false)).toMatchObject({
      code: "forbidden-content-type",
    })
  })

  test("a bodiless POST or PUT passes the content-type rule (Origin and Sec-Fetch protect it)", () => {
    expect(apiRefusal(request("localhost:5173", { method: "POST" }), false)).toBeUndefined()
    expect(apiRefusal(request("localhost:5173", { method: "POST", headers: { "content-length": "0" } }), false)).toBeUndefined()
    expect(apiRefusal(request("localhost:5173", { method: "POST", headers: { origin: "https://evil.example" } }), false)).toMatchObject({
      code: "forbidden-origin",
    })
  })

  test("refusals are ordered host, origin, then content type", () => {
    const hostile = { origin: "https://evil.example", "content-type": "text/plain" }
    expect(apiRefusal(post(hostile), false)).toMatchObject({ code: "forbidden-origin" })
    expect(apiRefusal(request("evil.example", { method: "POST", headers: hostile, body: "{}" }), false)).toMatchObject({ code: "forbidden-host" })
  })
})

describe("createGate", () => {
  const gate = createGate(false)

  test("answers a refusal as a JSON 403 with a sentence and a code, and never echoes the attacker's Origin", async () => {
    const response = await gate(request("localhost:5173", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }))
    expect(response?.status).toBe(403)
    expect(response?.headers.get("content-type")).toContain("application/json")
    const body = (await response?.json()) as { error: string; code: string }
    expect(body.code).toBe("forbidden-origin")
    expect(body.error.length).toBeGreaterThan(20)
    expect(body.error).not.toContain("evil.example")
  })

  test("lets an acceptable request on, and ignores paths outside /flow/api", async () => {
    expect(await gate(request("localhost:5173", { headers: { origin: "http://localhost:5173" } }))).toBeUndefined()
    const elsewhere = new Request("http://evil.example/index.html", { headers: { origin: "https://evil.example" } })
    expect(await gate(elsewhere)).toBeUndefined()
    expect(await gate(new Request("http://evil.example/flow/api"))).toMatchObject({ status: 403 })
  })

  const rebound = { origin: "https://evil.example", "sec-fetch-site": "cross-site" }

  // Connect (vite) mounts a prefix case-insensitively and lets a dot follow it, so every one of these reaches
  // the store handlers on the dev host; the gate must be at least as broad as the router.
  test.each(["/FLOW/API/x", "/Flow/Api/x", "/flow/api./x", "/flow/API", "/flow", "/flow/", "/flow.", "/FLOW/pty/1/ws", "/flow/apix/y"])(
    "%s is gated",
    async (path) => {
      const response = await gate(new Request(`http://localhost:5173${path}`, { headers: rebound }))
      expect(response?.status).toBe(403)
      expect(await response?.json()).toMatchObject({ code: "forbidden-origin" })
    },
  )

  test.each(["/", "/index.html", "/assets/x.js", "/@vite/client", "/src/main.tsx", "/flowers", "/api/flow/x", "/x/flow/api"])(
    "%s is not gated",
    async (path) => {
      expect(await gate(new Request(`http://localhost:5173${path}`, { headers: rebound }))).toBeUndefined()
    },
  )

  test("a same-origin request on a case variant passes", async () => {
    const headers = { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" }
    expect(await gate(new Request("http://localhost:5173/FLOW/API/x", { headers }))).toBeUndefined()
  })
})

describe("a malformed Host", () => {
  const gate = createGate(false)

  // The request URL is what a server builds from the Host header: an unparseable one must not throw out of the gate.
  test("a Host the URL parser rejects is a JSON 403 forbidden-host, not an exception", async () => {
    const request = { url: "http://localhost:99999/flow/api/x", headers: new Headers({ host: "localhost:99999" }) } as unknown as Request
    const response = await gate(request)
    expect(response?.status).toBe(403)
    expect(response?.headers.get("content-type")).toContain("application/json")
    expect(await response?.json()).toMatchObject({ code: "forbidden-host" })
  })

  test.each(["localhost@evil.example", "evil.example#localhost", "localhost:99999", "localhost%00.evil.example"])(
    "%s is refused as forbidden-host when the URL does parse",
    async (host) => {
      const response = await gate(new Request("http://127.0.0.1:9/flow/api/x", { headers: { host } }))
      expect(response?.status).toBe(403)
      expect(await response?.json()).toMatchObject({ code: "forbidden-host" })
    },
  )
})

describe("rawPathRefusal", () => {
  test.each([
    "/flow/api/../../pipelines/x",
    "/flow/api/./pipelines/x",
    "/flow/api/%2e%2e/%2e%2e/pipelines/x",
    "/flow/api/.%2e/pipelines/x",
    "/flow/api/%2E%2E/pipelines/x",
    "/FLOW/api/../x",
    "/flow/api./../x",
    "/flow/api/..",
    "/flow/api/pipelines/x;a=b",
    "/flow/api\\pipelines\\x",
    "/flow/api/%5Cpipelines",
    "/flow%00/api/x",
    "/flow/api/x%00",
    "/flow/api/x/../?q=1",
    // Absolute form, as a request line may carry it.
    "http://localhost:5174/flow/api/../../x",
    // Not under /flow in the raw line, but a parser folds the backslashes into one.
    "\\flow\\api\\..\\x",
    "//flow/api/../x",
  ])("%s is a 400 forbidden-path", (target) => {
    expect(rawPathRefusal(target)).toEqual({ status: 400, error: expect.any(String), code: "forbidden-path" })
  })

  test.each([
    "/flow/api/pipelines/x",
    "/flow/api/pipelines/a.b",
    "/flow/api/pipelines/..x",
    "/flow/api/pipelines/x...",
    "/flow/api/env?names=HOME;PATH",
    "/flow/api/x?next=../../y",
    "/flow/api/x#../y",
    "/flow/api/pipelines/a%20b",
    "/assets/../x.js",
    "/src/%2e%2e/main.tsx",
    "/index.html;x",
    "/",
  ])("%s is not the gate's business", (target) => {
    expect(rawPathRefusal(target)).toBeUndefined()
  })

  test("the gate refuses the spellings a normalised Request still carries, before any other rule", async () => {
    const gate = createGate(false)
    for (const url of ["http://localhost:5174/flow%00/api/x", "http://localhost:5174/flow/api/x;a=b"]) {
      const response = await gate(new Request(url))
      expect(response?.status).toBe(400)
      expect(await response?.json()).toMatchObject({ code: "forbidden-path" })
    }
  })
})
