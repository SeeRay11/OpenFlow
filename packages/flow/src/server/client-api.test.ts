import { expect, test } from "bun:test"
import type { EngineApi } from "../../shared/engine"
import {
  accepts,
  createSession,
  describe,
  interrupt,
  models,
  prompt,
  rejectQuestion,
  release,
  replyPermission,
  replyQuestion,
  sessionCalls,
  sessionSteps,
  subscribe,
  transcript,
  waitForIdle,
} from "./client"

/** Compile-time proof that the client's exports make a complete `EngineApi`. */
export const engineApi: EngineApi = {
  subscribe,
  createSession,
  prompt,
  waitForIdle,
  transcript,
  interrupt,
  release,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  accepts,
  models,
  describe,
  sessionSteps,
  sessionCalls,
}

// `describe` is the client's own export here, so these are plain tests rather than a bun `describe` group.

test("describe: prefers a message field over the raw body", () => {
  expect(describe({ message: "Model claude-opus-5 is not supported" })).toBe("Model claude-opus-5 is not supported")
})

test("describe: reads a message nested under data", () => {
  expect(describe({ data: { message: "no such agent" } })).toBe("no such agent")
})

test("describe: reads the error field of an engine wire body", () => {
  expect(describe({ error: "session not found: ses_9" })).toBe("session not found: ses_9")
})

test("describe: prefers message over error when a body carries both", () => {
  expect(describe({ message: "engine is down", error: "engine is down" })).toBe("engine is down")
})

test("describe: ignores a non-string error field rather than printing [object Object]", () => {
  expect(describe({ error: { code: 500 } })).toBe('{"error":{"code":500}}')
})

test("describe: an empty body renders as the status, never as {}", () => {
  const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
  expect(describe({}, response)).toBe("HTTP 502 Bad Gateway")
  expect(describe(undefined, response)).toBe("HTTP 502 Bad Gateway")
})

test("describe: appends the status to a body that does say something", () => {
  const response = new Response(null, { status: 503, statusText: "Service Unavailable" })
  expect(describe({ error: "omp is not installed" }, response)).toBe("omp is not installed (HTTP 503 Service Unavailable)")
})

test("describe: a successful response adds nothing", () => {
  expect(describe(new Error("boom"), new Response(null, { status: 200 }))).toBe("boom")
})

test("describe: falls back to the _tag, then to unknown", () => {
  expect(describe({ _tag: "ProviderAuthError" })).toBe("ProviderAuthError")
  expect(describe(undefined)).toBe("unknown error")
})
