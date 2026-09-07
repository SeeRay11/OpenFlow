import { beforeEach, describe, expect, test } from "bun:test"
import { alertFor, announce, setAlerts, setWebhook, validWebhook } from "./alerts"
import type { RunLog } from "./graph/types"

const log = (patch: Partial<RunLog> = {}): RunLog => ({
  id: "run-1",
  pipeline: "nightly build",
  pipelineID: "p1",
  input: "do the thing",
  status: "done",
  started: 1_000,
  finished: 4 * 60_000 + 1_000,
  nodes: [
    { id: "a", role: "coder", status: "done" },
    { id: "b", role: "reviewer", status: "done" },
  ],
  ...patch,
})

beforeEach(() => {
  setAlerts(false)
  setWebhook("")
})

describe("alertFor", () => {
  test("the first line alone says which canvas and whether it worked", () => {
    expect(alertFor(log()).title).toBe("nightly build — finished")
    expect(alertFor(log({ status: "error" })).title).toBe("nightly build — failed")
    expect(alertFor(log({ status: "stopped" })).title).toBe("nightly build — stopped")
  })

  test("a failed verdict outranks the status word", () => {
    // `done` on a run its verifier failed is the same lie the verdict exists to
    // prevent, one layer further out.
    const failed = log({
      status: "error",
      verdict: { card: "reviewer", kind: "fail", reason: "the tests do not pass" },
    })
    expect(alertFor(failed).title).toBe("nightly build — failed its verifier")
    expect(alertFor(failed).body).toContain("the tests do not pass")
  })

  test("the body names the failed cards, the wall clock and the cost", () => {
    const body = alertFor(
      log({
        status: "error",
        nodes: [
          { id: "a", role: "coder", status: "error" },
          { id: "b", role: "reviewer", status: "done" },
        ],
        usage: {
          cost: 0.42,
          steps: 4,
          tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          models: [],
          unpriced: [],
        },
      }),
    ).body
    expect(body).toContain("1 card(s) failed: coder")
    expect(body).toContain("4m 00s")
    expect(body).toContain("$0.42")
  })

  test("a run nobody could price says nothing about money rather than $0", () => {
    expect(alertFor(log()).body).not.toContain("$")
  })
})

describe("validWebhook", () => {
  test("http is allowed — the obvious listener is on this machine", () => {
    expect(validWebhook("http://localhost:9000/hook")).toBe(true)
    expect(validWebhook("https://hooks.example.com/x")).toBe(true)
  })

  test("empty is valid — it means the channel is off", () => {
    expect(validWebhook("  ")).toBe(true)
  })

  test("a typo is refused rather than silently dropped", () => {
    // Believing you have alerts and having none is worse than having none.
    expect(validWebhook("hooks.example.com")).toBe(false)
    expect(validWebhook("file:///etc/passwd")).toBe(false)
  })
})

describe("announce", () => {
  test("says nothing at all until the user switches it on", async () => {
    const sent: string[] = []
    await announce(log(), { notify: async (a) => void sent.push(a.title), post: async () => {}, focused: () => false })
    expect(sent).toEqual([])
  })

  test("notifies when the page is not being watched", async () => {
    setAlerts(true)
    const sent: string[] = []
    await announce(log(), { notify: async (a) => void sent.push(a.title), post: async () => {}, focused: () => false })
    expect(sent).toEqual(["nightly build — finished"])
  })

  test("stays quiet on the desktop while somebody is looking at the canvas", async () => {
    setAlerts(true)
    const sent: string[] = []
    await announce(log(), { notify: async (a) => void sent.push(a.title), post: async () => {}, focused: () => true })
    expect(sent).toEqual([])
  })

  test("the webhook carries the run, its ending and what each card changed", async () => {
    setAlerts(true)
    setWebhook("https://hooks.example.com/x")
    const posts: { url: string; body: any }[] = []
    await announce(
      log({ nodes: [{ id: "a", role: "coder", status: "done", diff: { added: 12, removed: 3, files: 1 } }] }),
      { notify: async () => {}, post: async (url, body) => void posts.push({ url, body }), focused: () => true },
    )
    expect(posts[0].url).toBe("https://hooks.example.com/x")
    expect(posts[0].body.run).toBe("run-1")
    expect(posts[0].body.status).toBe("done")
    expect(posts[0].body.cards[0].diff).toEqual({ added: 12, removed: 3, files: 1 })
  })

  test("the webhook fires whether or not the page is focused", async () => {
    // Unlike the desktop channel: a webhook is somewhere else entirely, and
    // whoever reads it is not the person sitting in front of this tab.
    setAlerts(true)
    setWebhook("https://hooks.example.com/x")
    const posts: unknown[] = []
    await announce(log(), { notify: async () => {}, post: async () => void posts.push(1), focused: () => true })
    expect(posts).toHaveLength(1)
  })

  test("a refused webhook is never posted to", async () => {
    setAlerts(true)
    setWebhook("not a url")
    const posts: unknown[] = []
    await announce(log(), { notify: async () => {}, post: async () => void posts.push(1), focused: () => false })
    expect(posts).toEqual([])
  })

  test("a channel that throws does not become the run's failure", async () => {
    setAlerts(true)
    setWebhook("https://hooks.example.com/x")
    await announce(log(), {
      notify: async () => {
        throw new Error("notifications blocked")
      },
      post: async () => {
        throw new Error("500")
      },
      focused: () => false,
    })
    // Reaching here is the assertion: `announce` resolved rather than throwing
    // into the end of a run that had already succeeded.
    expect(true).toBe(true)
  })
})
