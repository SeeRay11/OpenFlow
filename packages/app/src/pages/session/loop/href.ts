import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import type { NextMoveCard } from "@/pages/session/loop/controller"

/**
 * Prefill target for the [Apply] action (spec §2): the session route plus the
 * step as `?prompt=` — the composer consumes it, the user still sends
 * themselves (no auto-send). Pure so the browser tests can verify the href
 * without DOM rendering (bun transforms solid TSX as React JSX, so this
 * suite cannot mount the component).
 */
export function nextMoveHref(input: Pick<NextMoveCard, "sessionID" | "schritt"> & { serverKey?: string; directory: string }): string {
  const prompt = encodeURIComponent(input.schritt)
  const base = input.serverKey
    ? sessionHref(requireServerKey(input.serverKey), input.sessionID)
    : legacySessionHref(input.directory, input.sessionID)
  return `${base}?prompt=${prompt}`
}
