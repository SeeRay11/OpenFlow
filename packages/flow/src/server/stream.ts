import type { EngineApi } from "../../shared/engine"

/**
 * Keeps the run's event stream attached. The host closes a subscriber that falls
 * behind, and a network blip or a host restart ends the stream just the same;
 * without a new one, later permission and question requests reach nobody while
 * the card keeps running. The host replays what is still pending to each new
 * subscriber, so reconnecting is the whole recovery on this side.
 */

export type StreamRetry = {
  /** First delay, in milliseconds; each further failure in a row doubles it. */
  base: number
  /** The delay never grows past this. */
  cap: number
  /** Replaces the timer, for tests: resolves when the delay is over or `signal` aborts. */
  wait?(ms: number, signal: AbortSignal): Promise<void>
}

export const DEFAULT_STREAM_RETRY: StreamRetry = { base: 250, cap: 8_000 }

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * Subscribes, and subscribes again whenever the stream ends or fails, until
 * `signal` aborts. The delay doubles up to `retry.cap` while attempts keep
 * failing and starts over once one stayed attached for a full `cap` or
 * delivered an event.
 */
export async function keepSubscribed(
  subscribe: EngineApi["subscribe"],
  onEvent: Parameters<EngineApi["subscribe"]>[0],
  signal: AbortSignal,
  retry: StreamRetry = DEFAULT_STREAM_RETRY,
) {
  let failures = 0
  while (!signal.aborted) {
    const started = Date.now()
    let delivered = false
    await subscribe((event) => {
      delivered = true
      onEvent(event)
    }, signal).catch(() => undefined)
    if (signal.aborted) return
    if (delivered || Date.now() - started >= retry.cap) failures = 0
    await (retry.wait ?? pause)(Math.min(retry.cap, retry.base * 2 ** failures), signal)
    failures++
  }
}
