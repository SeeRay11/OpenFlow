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

  // The command is relative (`--cwd packages/opencode`), so it only resolves from
  // the repo root; and `serve` refuses to bind a port another process still holds.
  // Both are the usual reasons a copy-pasted restart fails, so spell them out and
  // hand over ready-to-run `cd` + port-kill lines for either shell.
  const port = () => {
    const parsed = Number.parseInt(new URL(props.status.url).port, 10)
    return Number.isNaN(parsed) ? 4096 : parsed
  }
  const killPowershell = () =>
    `Get-NetTCPConnection -LocalPort ${port()} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
  const killCmd = () =>
    `for /f "tokens=5" %P in ('netstat -ano ^| findstr :${port()} ^| findstr LISTENING') do taskkill /PID %P /F`
  const killUnix = () => `lsof -ti tcp:${port()} | xargs kill`

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
                  {props.status.reason ?? "it belongs to whichever process launched it"}. Restart it yourself with the
                  three steps below.
                </>
              }
            >
              Or run it yourself, with the three steps below:
            </Show>
          </p>

          <p class="hint">
            1. Go to the OpenFlow repo root (the command is relative and only resolves there):
          </p>
          <pre class="transcript mono">cd OpenFlow</pre>

          <p class="hint">
            2. Stop the engine still on port {port()} — <code>Ctrl+C</code> in the terminal that owns it, or, if you
            cannot find it, free the port with the line for your shell:
          </p>
          <pre class="transcript mono">{killPowershell()}</pre>
          <pre class="transcript mono">{killCmd()}</pre>
          <pre class="transcript mono">{killUnix()}</pre>
          <p class="hint">
            First line is Windows PowerShell, second is Windows cmd, third is macOS/Linux. Skipping this leaves the old
            engine bound to the port and <code>serve</code> fails to start.
          </p>

          <p class="hint">3. Start it again:</p>
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
