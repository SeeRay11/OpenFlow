// Read-Retry on hold — effect@4.0.0-beta.83 Stream-Semantik, Design in docs (Auto-Resume-Anleihe); Benign-Skip deckt 9/16 FAIL-Ursachen.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMError } from "../../src"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { deltaChunk } from "../lib/openai-chunks"
import { sseEvents, sseRaw } from "../lib/sse"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const request = LLM.request({
  id: "req_robust",
  model,
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("stream robustness", () => {
  it.effect("T1: skips benign JSON frames (no choices, no error) mid-stream", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        {},
        { choices: null },
        deltaChunk({ content: "!" }),
        deltaChunk({}, "stop"),
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.text).toBe("Hello!")
      expect(response.events.filter((event) => event.type === "text-delta").map((event: any) => event.text)).toEqual([
        "Hello",
        "!",
      ])
    }),
  )

  it.effect("T2: frames carrying an error field fail as classified provider error, not as protocol error", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hi" }),
        { error: { message: "boom", type: "server_error" } },
      )
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).not.toContain("stream event")
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status: 500 })
      expect(error.retryable).toBe(true)
      expect(error.message).toContain("server_error")
      expect(error.message).toContain("boom")
    }),
  )

  it.effect("T2b: router mid-stream error packet after content deltas is a retryable provider error (dharma 0.6.18)", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Teil" }),
        deltaChunk({ content: " eins" }),
        deltaChunk({ content: " zwei" }),
        { error: { message: "list index out of range", code: 500 } },
      )
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).not.toContain("Invalid openai/openai-chat stream event")
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status: 500 })
      expect(error.retryable).toBe(true)
      expect(error.message).toBe("ProviderShared.stream: Provider stream error (500): list index out of range")
    }),
  )

  it.effect("T2c: error packet classification follows status and type", () =>
    Effect.gen(function* () {
      const run = (packet: unknown) =>
        LLMClient.generate(request).pipe(
          Effect.provide(fixedResponse(sseEvents(deltaChunk({ role: "assistant", content: "x" }), packet))),
          Effect.flip,
        )
      const limited = yield* run({ error: { message: "slow down", type: "rate_limit_exceeded", code: 429 } })
      expect(limited.reason._tag).toBe("RateLimit")
      expect(limited.retryable).toBe(true)
      const overloaded = yield* run({ error: { message: "busy", type: "overloaded_error" } })
      expect(overloaded.reason._tag).toBe("ProviderInternal")
      expect(overloaded.retryable).toBe(true)
      const invalid = yield* run({ error: { message: "bad tool schema", type: "invalid_request_error", code: 400 } })
      expect(invalid.reason._tag).toBe("InvalidRequest")
      expect(invalid.retryable).toBe(false)
      const quota = yield* run({ error: { message: "no credit", type: "insufficient_quota", code: 429 } })
      expect(quota.reason._tag).toBe("QuotaExceeded")
      expect(quota.retryable).toBe(false)
      const unknown = yield* run({ error: { message: "weird" } })
      expect(unknown.reason._tag).toBe("UnknownProvider")
      expect(unknown.retryable).toBe(false)
    }),
  )

  it.effect("T3: fails on non-JSON frames", () =>
    Effect.gen(function* () {
      const body = sseRaw(
        `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hi" }))}`,
        "data: {not json",
      )
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )
})
