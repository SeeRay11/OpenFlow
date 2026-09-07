import { createSignal } from "solid-js"
import type { RunLog } from "./graph/types"
import { costLabel } from "./server/usage"

/**
 * Telling somebody the run ended.
 *
 * Every mode here is designed to be left alone — a gauntlet is bounded in hours
 * and spend rather than in turns — and nothing anywhere said so when one
 * finished, failed, or was stopped by a cap. A run that ends at 02:40 and is
 * noticed at 09:00 has spent the difference doing nothing, and the ending that
 * matters most (a card failed, the spend cap fired) is exactly the one the
 * canvas cannot report to somebody who is not looking at it.
 *
 * Two channels, both off by default and both the user's own decision: a desktop
 * notification, and a webhook the user pastes in. Nothing is sent anywhere
 * until one is switched on — an ending posted to a URL is data leaving the
 * machine, and this is not the code that decides that on someone's behalf.
 */

const ENABLED_KEY = "openflow.alerts.v1"
const WEBHOOK_KEY = "openflow.alerts.webhook.v1"

/**
 * The signal is the source of truth and localStorage is best-effort, the same
 * shape `default-model.ts` uses — `bun test` has no `localStorage`, and a
 * preference that reads it directly cannot be tested without a global polyfill.
 */
function load(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function save(key: string, value: string | undefined) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // storage disabled — the session still alerts, it just forgets next reload.
  }
}

const [alertsOn, setAlertsOn] = createSignal(load(ENABLED_KEY) === "on")
const [webhook, setWebhookURL] = createSignal(load(WEBHOOK_KEY) ?? "")
export { alertsOn, webhook }

export function setAlerts(on: boolean) {
  setAlertsOn(on)
  save(ENABLED_KEY, on ? "on" : undefined)
}

export function setWebhook(url: string) {
  setWebhookURL(url)
  save(WEBHOOK_KEY, url.trim() || undefined)
}

/**
 * Whether a webhook URL is one this will actually post to.
 *
 * `http` is allowed because the obvious use is a script on the same machine,
 * and a localhost listener has no certificate. Anything that is not an http
 * URL is refused rather than quietly ignored — a typo that silently stops
 * every alert is worse than no alerts, since the user believes they have them.
 */
export function validWebhook(url: string) {
  if (!url.trim()) return true
  try {
    return ["http:", "https:"].includes(new URL(url.trim()).protocol)
  } catch {
    return false
  }
}

/**
 * What the alert says.
 *
 * Written so the first line alone is worth waking up for: which canvas, and
 * whether the thing succeeded. A phone notification is read in a lock screen's
 * worth of space, so the body carries the three facts that decide whether to
 * get up — what ended it, how long it took, what it cost — and nothing else.
 *
 * A verdict outranks the status word. `done` on a run whose verifier failed it
 * would be the same lie the verdict was added to prevent, one layer further
 * out.
 */
export function alertFor(log: RunLog) {
  const failed = log.nodes.filter((node) => node.status === "error")
  const headline =
    log.verdict && log.verdict.kind !== "pass"
      ? log.verdict.kind === "fail"
        ? `${log.pipeline} — failed its verifier`
        : `${log.pipeline} — the verdict could not be read`
      : log.status === "done"
        ? `${log.pipeline} — finished`
        : log.status === "stopped"
          ? `${log.pipeline} — stopped`
          : `${log.pipeline} — failed`
  const parts = [
    failed.length ? `${failed.length} card(s) failed: ${failed.map((node) => node.role).join(", ")}` : "",
    log.verdict?.reason?.trim() ? log.verdict.reason.trim().split("\n")[0] : "",
    elapsed(log),
    // Steps, not cost: a priced run that genuinely cost nothing is not the same
    // as a run nobody could price, and neither should be printed as `$0`.
    log.usage?.steps ? costLabel(log.usage) : "",
  ].filter(Boolean)
  return { title: headline, body: parts.join(" · ") }
}

function elapsed(log: RunLog) {
  if (!log.started || !log.finished) return ""
  const seconds = Math.max(0, Math.round((log.finished - log.started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * Whether the desktop channel can fire without asking anybody anything.
 *
 * Permission has to be requested from a user gesture, so it is asked for when
 * the toggle is switched on and only read here. A browser that has no
 * `Notification` at all — or a page not on a secure origin — simply has no
 * desktop channel, and the webhook still works.
 */
export function desktopReady() {
  return typeof Notification !== "undefined" && Notification.permission === "granted"
}

/** Asked from the click that switches alerts on, because a prompt needs a gesture behind it. */
export async function askDesktop() {
  if (typeof Notification === "undefined") return false
  if (Notification.permission === "granted") return true
  if (Notification.permission === "denied") return false
  return (await Notification.requestPermission()) === "granted"
}

/**
 * Sends the ending on both channels, as far as each one is available.
 *
 * Never throws and never blocks the run: this is called from the end of a run,
 * and an alert that fails must not be the thing that turns a finished run into
 * a failed one. A webhook that 500s, a notification a browser refuses — both
 * are dropped, because there is nowhere to report a failed report to.
 *
 * The desktop notification is skipped while the page has focus. Somebody
 * watching the canvas has already been told by the canvas, and the whole point
 * of this is the case where nobody is watching.
 */
export async function announce(log: RunLog, deps: AlertDeps = {}) {
  if (!alertsOn()) return
  const alert = alertFor(log)
  const notify = deps.notify ?? defaultNotify
  const post = deps.post ?? defaultPost
  const focused = deps.focused ?? (() => typeof document !== "undefined" && document.hasFocus())
  if (!focused()) await notify(alert).catch(() => {})
  const url = webhook().trim()
  if (url && validWebhook(url))
    await post(url, {
      ...alert,
      run: log.id,
      pipeline: log.pipeline,
      status: log.status,
      verdict: log.verdict,
      started: log.started,
      finished: log.finished,
      cards: log.nodes.map((node) => ({ id: node.id, role: node.role, status: node.status, diff: node.diff })),
    }).catch(() => {})
}

export type AlertDeps = {
  notify?: (alert: { title: string; body: string }) => Promise<void>
  post?: (url: string, body: unknown) => Promise<void>
  focused?: () => boolean
}

async function defaultNotify(alert: { title: string; body: string }) {
  if (!desktopReady()) return
  new Notification(alert.title, { body: alert.body, tag: "openflow-run" })
}

async function defaultPost(url: string, body: unknown) {
  // `keepalive` so an alert fired as the tab is closing still leaves.
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  })
}
