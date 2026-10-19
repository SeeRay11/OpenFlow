import { Show, createSignal } from "solid-js"
import { state } from "../state"
import { IconCheck } from "./icons"

/**
 * The first-run overlay. The blank canvas tells a new user what to do, in
 * order, and each step ticks itself as the app state satisfies it — nothing is
 * stored per step, the done-states are derived live.
 *
 * It sits over the empty canvas the way `.canvas-empty` does: the container is
 * click-through (`pointer-events: none`) so palette drag-to-create and panning
 * never die, and only the buttons re-enable pointer events.
 */
const KEY = "openflow.walkthroughDone.v1"

/**
 * Pure derivation of what is done and whether the overlay shows. Kept free of
 * storage and the DOM so it can be unit-tested directly; the component passes
 * live counts and the stored `dismissed` flag in.
 */
export function walkthroughState(input: {
  hostReachable: boolean
  ompReady: boolean
  modelCount: number
  /** True once the first catalog read has settled (listed models or not); false while it is in flight. */
  modelsLoaded: boolean
  nodes: number
  edges: number
  dismissed: boolean
}) {
  return {
    visible: input.nodes === 0 && !input.dismissed,
    steps: {
      // First, because nothing else in this list can succeed without it: with
      // the host down or omp missing there are no models to list and nothing to
      // run a card on.
      omp: input.hostReachable && input.ompReady,
      models: input.modelCount > 0,
      node: input.nodes > 0,
      // A single node needs no edge to be "connected"; a bigger graph does.
      connect: input.nodes > 0 && (input.edges > 0 || input.nodes === 1),
    },
    // The catalog takes seconds to arrive; until it does, "no models" is not an answer yet.
    loadingModels: input.hostReachable && input.ompReady && !input.modelsLoaded && input.modelCount === 0,
  }
}

function readDismissed() {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

/** The tick beside a step, with its state as text: the icon and `data-done` mean nothing to a screen reader. */
function StepMark(props: { done: boolean }) {
  return (
    <span class="walkthrough-mark">
      <span class="walkthrough-state">{props.done ? "done: " : "to do: "}</span>
      <Show when={props.done}>
        <IconCheck />
      </Show>
    </span>
  )
}

export function Walkthrough(props: {
  ompReady: boolean
  ompMessage?: string
  modelCount: number
  modelsLoaded: boolean
  onOpenOmp: () => void
  onOpenTerminal: () => void
}) {
  const [dismissed, setDismissed] = createSignal(readDismissed())
  const view = () =>
    walkthroughState({
      hostReachable: state.hostReachable,
      ompReady: props.ompReady,
      modelCount: props.modelCount,
      modelsLoaded: props.modelsLoaded,
      nodes: state.pipeline.nodes.length,
      edges: state.pipeline.edges.length,
      dismissed: dismissed(),
    })

  function skip() {
    setDismissed(true)
    try {
      localStorage.setItem(KEY, "1")
    } catch {
      // storage disabled — it just won't stay skipped across reloads.
    }
  }

  return (
    <Show when={view().visible}>
      <div class="walkthrough">
        <div class="walkthrough-card">
          <div class="walkthrough-head">
            <h2 class="walkthrough-title">Build your first pipeline</h2>
            <button class="walkthrough-skip" type="button" onClick={skip}>
              Skip
            </button>
          </div>

          <ol class="walkthrough-steps">
            <li class="walkthrough-step" data-done={view().steps.omp ? true : undefined}>
              <StepMark done={view().steps.omp} />
              <div class="walkthrough-body">
                <span class="walkthrough-label">Check Omp</span>
                <Show
                  when={view().steps.omp}
                  fallback={
                    <span class="hint">
                      {state.hostReachable
                        ? (props.ompMessage ?? "Omp is not ready — open its settings to see why")
                        : "the OpenFlow host is not answering — run `bun openflow.ts` from the repo root, then reload"}
                    </span>
                  }
                >
                  <span class="hint">{props.ompMessage ?? "Omp is ready — every card runs its own Omp session"}</span>
                </Show>
                <div class="walkthrough-actions">
                  <button class="btn" type="button" onClick={props.onOpenOmp}>
                    Open Omp settings
                  </button>
                  <button class="btn" type="button" onClick={props.onOpenTerminal}>
                    Open terminal
                  </button>
                </div>
              </div>
            </li>

            <li class="walkthrough-step" data-done={view().steps.models ? true : undefined}>
              <StepMark done={view().steps.models} />
              <div class="walkthrough-body">
                <span class="walkthrough-label">Have a model to run</span>
                <Show
                  when={view().steps.models}
                  fallback={
                    <span class="hint">
                      {view().loadingModels ? "Loading models…" : "Omp lists no models yet — log in to a provider from the terminal"}
                    </span>
                  }
                >
                  <span class="hint">
                    {props.modelCount} {props.modelCount === 1 ? "model" : "models"} available
                  </span>
                </Show>
              </div>
            </li>

            <li class="walkthrough-step" data-done={view().steps.node ? true : undefined}>
              <StepMark done={view().steps.node} />
              <div class="walkthrough-body">
                <span class="walkthrough-label">Add a node</span>
                <span class="hint">pick a template or drag a role from the palette</span>
              </div>
            </li>

            <li class="walkthrough-step" data-done={view().steps.connect ? true : undefined}>
              <StepMark done={view().steps.connect} />
              <div class="walkthrough-body">
                <span class="walkthrough-label">Connect nodes</span>
                <span class="hint">drag a node's right port onto another's left port</span>
              </div>
            </li>

            <li class="walkthrough-step">
              <StepMark done={false} />
              <div class="walkthrough-body">
                <span class="walkthrough-label">Run</span>
                <span class="hint">type a task above and press Run</span>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </Show>
  )
}
