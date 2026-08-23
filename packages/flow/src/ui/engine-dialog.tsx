import { Show, createSignal } from "solid-js"
import type { ServeStatus } from "../server/store"
import { IconClose } from "./icons"

/**
 * How to restart the engine, whoever owns it.
 *
 * OpenFlow only spawns `opencode serve` when asked to (`FLOW_MANAGE_SERVER=1`).
 * When it did, this offers the restart directly. When it did not — started from
 * a terminal or a launcher — no click here can reach that process, because the
 * server has no shutdown route, so the dialog names the owner and hands over
 * the exact command instead of pretending.
 */
export function EngineDialog(props: {
  status: ServeStatus
  /** Present when this host owns the engine — the dialog can then just do it. */
  onRestart?: () => void
  restarting?: boolean
  /** Why the dialog was opened, when it was not the button itself. */
  because?: string
  onClose: () => void
}) {
  const [copied, setCopied] = createSignal(false)

  async function copy() {
    await navigator.clipboard.writeText(props.status.command).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>Restart the engine</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>
        <div class="oc-dialog-body">
          <Show when={props.because}>
            <p class="hint">{props.because}</p>
          </Show>

          <Show when={props.status.managed}>
            <div class="row">
              <span class="hint">OpenFlow started this engine, so it can restart it for you.</span>
              <button class="btn btn-primary" type="button" disabled={props.restarting} onClick={props.onRestart}>
                {props.restarting ? "restarting…" : "restart now"}
              </button>
            </div>
          </Show>

          <p class="hint">
            <Show
              when={props.status.managed}
              fallback={
                <>
                  OpenFlow did not start <code>opencode serve</code>, so it cannot restart it —{" "}
                  {props.status.reason ?? "it belongs to whichever process launched it"}. Stop it where it is running —
                  Ctrl+C in that terminal — and start it again from the OpenFlow repo root with:
                </>
              }
            >
              Or run it yourself, from the OpenFlow repo root:
            </Show>
          </p>
          <pre class="transcript mono">{props.status.command}</pre>
          <div class="row">
            <span class="hint">
              engine {props.status.url} · {props.status.running ? "answering" : "not answering"}
            </span>
            <button class="btn" type="button" onClick={copy}>
              {copied() ? "copied" : "copy command"}
            </button>
          </div>
          <p class="hint">
            Use this exact command. A globally installed <code>opencode</code> on PATH can be a different version than
            this checkout, and an older engine answers the routes OpenFlow needs differently — which looks like a
            broken canvas rather than a version mismatch.
          </p>
          <p class="hint">
            To let OpenFlow own it — and make this a one-click restart — start the canvas with{" "}
            <code>FLOW_MANAGE_SERVER=1</code> and no engine already on that port.
          </p>
          {/* the 409 body repeats `reason` as `error`; showing both reads as two problems */}
          <Show when={props.status.error && props.status.error !== props.status.reason}>
            <p class="hint">last error: {props.status.error}</p>
          </Show>
        </div>
      </section>
    </div>
  )
}
