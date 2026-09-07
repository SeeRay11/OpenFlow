import { setWebhook, validWebhook, webhook } from "../alerts"
import { IconClose } from "./icons"

/**
 * Where an ending is sent when nobody is watching the canvas.
 *
 * A dialog rather than a runbar field for the same reason the verifier's bar is
 * one: a URL is long, and the runbar is a row of one-line settings. Unlike the
 * bar, this is a *preference* — it belongs to whoever is sitting here, not to
 * the canvas, so it is not saved into the pipeline, exported with it, or undone
 * with it.
 */
export function AlertsDialog(props: { onClose: () => void }) {
  const bad = () => !validWebhook(webhook())
  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>When a run ends</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>
        <div class="oc-dialog-body">
          <p class="hint">
            A desktop notification is shown when the run finishes, fails, or is stopped by one of its caps — but only
            while this page is not the window you are looking at. Watching the canvas is already being told.
          </p>

          <label class="hint" for="alerts-webhook">
            Webhook — posted to as well, wherever you are
          </label>
          <input
            id="alerts-webhook"
            class="field"
            type="url"
            spellcheck={false}
            placeholder="https://hooks.example.com/openflow"
            value={webhook()}
            onInput={(event) => setWebhook(event.currentTarget.value)}
          />
          {bad() ? (
            <p class="hint danger">
              Not an http or https URL — nothing will be posted. Left as it is, this reads as alerts you do not have.
            </p>
          ) : (
            <p class="hint">
              Optional. One JSON POST per ending, carrying the run id, its status, the verifier's verdict and every
              card's line counts. <code>http://localhost:…</code> is allowed, since the usual listener is a script on
              this machine.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
