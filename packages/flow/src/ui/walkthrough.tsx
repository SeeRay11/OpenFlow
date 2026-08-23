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
  unlockedProviders: number
  nodes: number
  edges: number
  dismissed: boolean
}) {
  return {
    visible: input.nodes === 0 && !input.dismissed,
    steps: {
      provider: input.unlockedProviders > 0,
      node: input.nodes > 0,
      // A single node needs no edge to be "connected"; a bigger graph does.
      connect: input.nodes > 0 && (input.edges > 0 || input.nodes === 1),
    },
  }
}

function readDismissed() {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function Walkthrough(props: {
  unlockedProviders: number
  suggestedFree?: string
  onOpenProviders: () => void
  onUseFree?: () => void
}) {
  const [dismissed, setDismissed] = createSignal(readDismissed())
  const view = () =>
    walkthroughState({
      unlockedProviders: props.unlockedProviders,
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
            <li class="walkthrough-step" data-done={view().steps.provider ? true : undefined}>
              <span class="walkthrough-mark">
                <Show when={view().steps.provider}>
                  <IconCheck />
                </Show>
              </span>
              <div class="walkthrough-body">
                <span class="walkthrough-label">Add a provider key</span>
                <Show
                  when={props.suggestedFree}
                  fallback={<span class="hint">connect a provider so its models can run</span>}
                >
                  <span class="hint">or run a free model, no key needed</span>
                </Show>
                <div class="walkthrough-actions">
                  <button class="btn" type="button" onClick={props.onOpenProviders}>
                    open providers
                  </button>
                  <Show when={props.suggestedFree && props.onUseFree}>
                    <button class="btn" type="button" onClick={() => props.onUseFree!()}>
                      use a free model
                    </button>
                  </Show>
                </div>
              </div>
            </li>

            <li class="walkthrough-step" data-done={view().steps.node ? true : undefined}>
              <span class="walkthrough-mark">
                <Show when={view().steps.node}>
                  <IconCheck />
                </Show>
              </span>
              <div class="walkthrough-body">
                <span class="walkthrough-label">Add a node</span>
                <span class="hint">pick a template or drag a role from the palette</span>
              </div>
            </li>

            <li class="walkthrough-step" data-done={view().steps.connect ? true : undefined}>
              <span class="walkthrough-mark">
                <Show when={view().steps.connect}>
                  <IconCheck />
                </Show>
              </span>
              <div class="walkthrough-body">
                <span class="walkthrough-label">Connect nodes</span>
                <span class="hint">drag a node's right port onto another's left port</span>
              </div>
            </li>

            <li class="walkthrough-step">
              <span class="walkthrough-mark" />
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
