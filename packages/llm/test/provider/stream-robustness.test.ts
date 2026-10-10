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

  it.effect("T2: fails on frames carrying an error field", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hi" }),
        { error: { message: "boom", type: "server_error" } },
      )
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).toContain("Invalid openai/openai-chat stream event")
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
