import { expect, test } from "bun:test"
import { createSseClient } from "../src/v2/gen/core/serverSentEvents.gen"

// Aborting a subscription must not leave a rejected promise without a handler.
// The abort handler used to call `reader.cancel()` inside a synchronous
// try/catch; cancel() rejects asynchronously with AbortError once the fetch
// is aborted, so every OpenFlow run ended with
// `[unhandledRejection] AbortError: The operation was aborted.`
// A real fetch against a real server: a mocked body did not reproduce it.
test("aborting an SSE stream leaves no unhandled rejection", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(new TextEncoder().encode('data: {"type":"hello"}\n\n'))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on("unhandledRejection", onRejection)
  try {
    const controller = new AbortController()
    const { stream } = createSseClient<{ type: string }>({
      url: `http://127.0.0.1:${server.port}/event`,
      signal: controller.signal,
      sseMaxRetryAttempts: 0,
    } as any)

    // Consumed the way OpenFlow's client consumes the bus: a for-await loop
    // that is parked on an idle stream when the run ends and aborts it.
    let events = 0
    const loop = (async () => {
      for await (const _ of stream) events++
    })().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await loop
    // Let the cancel() promise settle and the runtime report it if unhandled.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).toBe(1)
    expect(rejections.map(String)).toEqual([])
  } finally {
    process.off("unhandledRejection", onRejection)
    server.stop(true)
  }
})
