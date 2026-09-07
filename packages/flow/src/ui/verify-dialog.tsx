import type { Pipeline, Verify } from "../graph/types"
import { IconClose } from "./icons"

/**
 * The bar a verified run is judged against.
 *
 * A dialog for the same reason the gauntlet's is one: the bar is prose, often a
 * paragraph, and the runbar is a row of one-line settings. It is a property of
 * the document, so it is saved, exported and undone with the graph.
 */
export function VerifyDialog(props: { pipeline: Pipeline; onChange: (patch: Verify) => void; onClose: () => void }) {
  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>Verification</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>
        <div class="oc-dialog-body">
          <p class="hint">
            When the cards have finished, every card with the <strong>reviewer</strong> role runs once more in a new
            session, looks at what the run actually produced, and ends on a pass or a fail. The run reports what it
            decided — so a run that did nothing cannot report success.
          </p>

          <label class="hint" for="verify-bar">
            The bar — what the verifier holds the result against
          </label>
          <textarea
            id="verify-bar"
            class="field"
            rows={5}
            placeholder="what finished work looks like here: the tests pass, the page renders, the numbers match the reference"
            value={props.pipeline.verify?.bar ?? ""}
            onInput={(event) => props.onChange({ bar: event.currentTarget.value })}
          />
          <p class="hint">
            Optional. With no bar the verifier judges the result against the run's own task, which answers the question
            that matters most often: did this do what was asked. Unlike a gauntlet, nothing loops — one pass, one
            verdict.
          </p>
        </div>
      </section>
    </div>
  )
}
