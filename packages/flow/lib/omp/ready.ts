import { HttpError } from "../host/respond"
import type { OmpProcess } from "./rpc-types"

/** How long a freshly spawned omp may take to answer its first steps (`ready`, `open_session`). */
export const READY_TIMEOUT_MS = 60_000

/**
 * Races one startup step against a deadline. An omp that hangs before it is
 * ready would otherwise hold the caller (and, for the model catalog, every later
 * caller behind the single flight) forever, so on expiry the process group is
 * killed and the step fails with the 502 every route can show as is.
 */
export async function withDeadline<T>(proc: OmpProcess, work: Promise<T>, timeoutMs: number): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    // The failure first: killing the process settles `work` too, and the deadline is the reason that matters.
    expired.reject(
      new HttpError(502, `omp did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s of starting; run omp in the terminal to see what it waits on, or check the binary and profile in Omp settings.`, "omp-not-ready"),
    )
    proc.kill()
  }, timeoutMs)
  try {
    return await Promise.race([work, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}
