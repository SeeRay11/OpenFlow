import { base64Encode } from "@opencode-ai/core/util/encode"
import type { NextMoveCard } from "@/pages/session/loop/controller"

/**
 * Prefill target for the [Apply] action (spec §2): the session ROOT route
 * (directory slug, no session ID) plus the step as `?prompt=` — the composer
 * consumes it, the user still sends themselves (no auto-send). The root route
 * is the one route both layouts prefill from: the legacy session page consumes
 * `?prompt=` directly, and the new layout turns it into a prefilled draft tab
 * (SessionRoute in app.tsx). Pure so the browser tests can verify the href
 * without DOM rendering (bun transforms solid TSX as React JSX, so this
 * suite cannot mount the component).
 */
export function nextMoveHref(input: Pick<NextMoveCard, "schritt"> & { directory: string }): string {
  const prompt = encodeURIComponent(input.schritt)
  return `/${base64Encode(input.directory)}/session?prompt=${prompt}`
}
