import type { Gauntlet, Pipeline } from "../graph/types"
import {
  DEFAULT_MAX_MINUTES,
  DEFAULT_MAX_SPEND,
  DEFAULT_STALL,
  MAX_MAX_MINUTES,
  MAX_MAX_SPEND,
  gauntletOf,
} from "../graph/types"
import { IconClose } from "./icons"
import { Select, type SelectOption } from "./select"

/**
 * A gauntlet's bar and its three bounds.
 *
 * They live in a dialog rather than in the runbar because the bar is prose —
 * the run's whole standard of quality, often a paragraph — and the runbar is a
 * row of one-line settings. Everything here is a property of the document, so
 * it is saved, exported and undone with the graph.
 */
export function GauntletDialog(props: { pipeline: Pipeline; onChange: (patch: Gauntlet) => void; onClose: () => void }) {
  const settings = () => gauntletOf(props.pipeline)

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>Gauntlet</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>
        <div class="oc-dialog-body">
          <p class="hint">
            The orchestrator keeps handing work to builders and the result to critics until it clears the bar. It stops
            when the bar is met, or when one of the bounds below fires — nothing counts dispatches.
          </p>

          <label class="hint" for="gauntlet-bar">
            The bar — what a critic holds the work against
          </label>
          <textarea
            id="gauntlet-bar"
            class="field"
            rows={5}
            placeholder="something concrete and inspectable: an existing product, a reference implementation, a test suite, a latency number"
            value={props.pipeline.gauntlet?.bar ?? ""}
            onInput={(event) => props.onChange({ bar: event.currentTarget.value })}
          />
          <p class="hint">
            Leave it empty and the orchestrator has to establish one before it builds anything, which costs a round. It
            does not have to be reachable — a bar nothing quite matches is what stops a run settling for "good enough".
          </p>

          <div class="row">
            <span class="hint">Stop at</span>
            <Select
              prefix="spend: "
              title="the run stops when it has spent this much — this build prices client-side, so a model the catalog cannot price stops the run instead"
              value={String(settings()?.maxSpend ?? DEFAULT_MAX_SPEND)}
              options={SPEND_OPTIONS}
              onChange={(value) => props.onChange({ maxSpend: Number(value) })}
            />
            <Select
              prefix="time: "
              title="wall clock from the moment the run starts"
              value={String(settings()?.maxMinutes ?? DEFAULT_MAX_MINUTES)}
              options={MINUTE_OPTIONS}
              onChange={(value) => props.onChange({ maxMinutes: Number(value) })}
            />
            <Select
              prefix="stall: "
              title="how many times the same work may be handed out in a row before the run reads as making no progress"
              value={String(settings()?.stall ?? DEFAULT_STALL)}
              options={STALL_OPTIONS}
              onChange={(value) => props.onChange({ stall: Number(value) })}
            />
          </div>
          <p class="hint">
            Whichever fires first ends the run: the orchestrator gets one turn to answer from what it has. A gauntlet is
            the one canvas that can run for hours, so these are the only things standing between it and the bill.
          </p>

          <p class="hint">
            Critics are <code>reviewer</code> cards. Every verdict runs in a new session — a critic that has watched the
            work improve grades the improvement, not the work — and a critic reads code, builds and tests, never
            screenshots: nothing in this fork can hand a card an image of what it made.
          </p>
        </div>
      </section>
    </div>
  )
}

const SPEND_OPTIONS: SelectOption[] = [1, 5, 10, 25, 50, 100, MAX_MAX_SPEND].map((amount) => ({
  value: String(amount),
  label: `$${amount}`,
}))

const MINUTE_OPTIONS: SelectOption[] = [15, 30, 60, 120, 240, 480, MAX_MAX_MINUTES].map((minutes) => ({
  value: String(minutes),
  label: minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`,
}))

const STALL_OPTIONS: SelectOption[] = [2, 3, 4, 5, 8].map((rounds) => ({
  value: String(rounds),
  label: `${rounds} rounds`,
}))
