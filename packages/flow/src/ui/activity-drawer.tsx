import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { NodeEvent } from "../graph/types"
import { costLabel } from "../server/usage"
import { actions, runtimeOf, state } from "../state"
import { IconChevron, IconClose } from "./icons"

/** Half the window, which is what "expand the card" means here. */
const DEFAULT_HEIGHT = 0.5
const MIN_HEIGHT = 0.2
const MAX_HEIGHT = 0.9

/**
 * The expanded card: what the agent is actually doing, as it does it.
 *
 * A card can only say one thing at a time — "tool: grep" — and that is the
 * least interesting part of a run. This is the rest of it: the model's text as
 * it streams, every tool call with the arguments it was given and what came
 * back, and the subagents it spawned nested under the call that spawned them.
 *
 * It is a drawer rather than a modal because the graph above it is the point:
 * while one card talks, three others are running, and covering them to read one
 * of them would be a worse trade than the vertical space costs.
 */
export function ActivityDrawer() {
  const node = createMemo(() => state.pipeline.nodes.find((entry) => entry.id === state.expanded))
  const runtime = createMemo(() => (state.expanded ? runtimeOf(state.expanded) : undefined))
  const events = createMemo(() => runtime()?.events ?? [])
  const [height, setHeight] = createSignal(DEFAULT_HEIGHT)
  const [pinned, setPinned] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())
  let scroller!: HTMLDivElement

  // A running node needs a clock of its own: nothing else in the store changes
  // once it is between tool calls, so the elapsed time would freeze.
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    actions.expand(undefined)
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))

  // Follow the stream, but only while the reader is already at the bottom —
  // scrolling up to read something is a decision, and yanking them back down on
  // the next token would undo it.
  createEffect(() => {
    events().length
    events()[events().length - 1]?.body
    if (!pinned() || !scroller) return
    queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }))
  })

  function onScroll() {
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    setPinned(gap < 40)
  }

  function startResize(event: PointerEvent) {
    event.preventDefault()
    const move = (moved: PointerEvent) =>
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, 1 - moved.clientY / window.innerHeight)))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const elapsed = () => {
    const started = runtime()?.started
    if (!started) return undefined
    const end = runtime()?.finished ?? now()
    return `${Math.max(0, Math.round((end - started) / 1000))}s`
  }

  return (
    <Show when={node()}>
      {(selected) => (
        <section class="activity" style={{ height: `${Math.round(height() * 100)}vh` }}>
          <div class="activity-grip" onPointerDown={startResize} title="drag to resize" />

          <header class="activity-bar">
            <span class="activity-role">{selected().role}</span>
            <span class="badge" data-status={runtime()?.status ?? "idle"}>
              {runtime()?.status ?? "idle"}
            </span>
            <span class="hint mono">{selected().agent.model || "default model"}</span>
            <Show when={elapsed()}>
              <span class="hint">{elapsed()}</span>
            </Show>
            <Show when={runtime()?.usage?.steps}>
              <span class="hint">{costLabel(runtime()!.usage!)}</span>
            </Show>
            <Show when={runtime()?.activity}>
              <span class="activity-now">{runtime()!.activity}</span>
            </Show>
            <span class="activity-spacer" />
            <Show when={runtime()?.sessionID}>
              <span class="hint mono">{runtime()!.sessionID}</span>
            </Show>
            <button
              class="icon-btn"
              type="button"
              title="close (Esc)"
              aria-label="close activity"
              onClick={() => actions.expand(undefined)}
            >
              <IconClose />
            </button>
          </header>

          <div class="activity-stream" ref={scroller} onScroll={onScroll}>
            <Show
              when={events().length}
              fallback={
                <div class="empty-state">
                  {runtime()?.status === "running"
                    ? "waiting for the first step…"
                    : "no activity recorded for this card"}
                </div>
              }
            >
              <For each={events()}>{(event) => <Row event={event} />}</For>
            </Show>

            <Show when={runtime()?.error}>
              <pre class="transcript transcript-error activity-final">{runtime()!.error}</pre>
            </Show>
          </div>
        </section>
      )}
    </Show>
  )
}

/**
 * One row.
 *
 * Text and reasoning are the agent talking, so they are shown as they arrive.
 * Tool calls are folded to their name and arguments, because a run makes
 * dozens of them and an unfoldable wall of file contents is not a thought
 * process — clicking one opens what it was given and what it returned.
 */
function Row(props: { event: NodeEvent }) {
  const [open, setOpen] = createSignal(false)
  const event = () => props.event
  const foldable = () => event().kind === "tool" || event().kind === "reasoning" || !!event().body
  const streaming = () => event().kind === "text" && event().status === "running"

  return (
    <div
      class="activity-row"
      data-kind={event().kind}
      data-status={event().status}
      style={{ "padding-left": `${event().depth * 16}px` }}
    >
      <Show when={event().kind === "text"} fallback={null}>
        <pre class="activity-text" classList={{ streaming: streaming() }}>
          {event().body}
        </pre>
      </Show>

      <Show when={event().kind === "step"}>
        <div class="activity-step">
          <span class="activity-step-label">{event().title}</span>
        </div>
      </Show>

      <Show when={event().kind === "tool" || event().kind === "reasoning" || event().kind === "note"}>
        <button
          class="activity-head"
          type="button"
          disabled={!foldable()}
          onClick={() => setOpen(!open())}
          title={event().title}
        >
          <span class="activity-caret" classList={{ open: open() }}>
            <Show when={foldable()}>
              <IconChevron />
            </Show>
          </span>
          <Show when={event().depth > 0}>
            <span class="activity-nested" title="run by a subagent this card spawned">
              subagent
            </span>
          </Show>
          <span class="activity-title mono">{event().title}</span>
          <span class="activity-state" data-status={event().status} />
        </button>
        <Show when={open()}>
          <div class="activity-detail">
            <Show when={event().input}>
              <div class="hint">input</div>
              <pre class="transcript">{event().input}</pre>
            </Show>
            <Show when={event().body}>
              <div class="hint">{event().kind === "tool" ? "result" : "detail"}</div>
              <pre class="transcript" classList={{ "transcript-error": event().status === "error" }}>
                {event().body}
              </pre>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
