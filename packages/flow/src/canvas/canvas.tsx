import { For, Show, createSignal, onCleanup } from "solid-js"
import { actions, state } from "../state"
import { bezier, inPort, outPort, type Point } from "./geometry"
import { NodeCard } from "./node-card"

type View = { x: number; y: number; k: number }

export function Canvas() {
  let surface!: HTMLDivElement
  const [view, setView] = createSignal<View>({ x: 60, y: 60, k: 1 })
  const [linking, setLinking] = createSignal<{ source: string; to: Point } | undefined>()

  const toGraph = (clientX: number, clientY: number): Point => {
    const rect = surface.getBoundingClientRect()
    const { x, y, k } = view()
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k }
  }

  const node = (id: string) => state.pipeline.nodes.find((entry) => entry.id === id)

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    const rect = surface.getBoundingClientRect()
    const current = view()
    const next = Math.min(2.5, Math.max(0.2, current.k * Math.exp(-event.deltaY * 0.0015)))
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    // Keep the graph point under the cursor pinned while zooming.
    setView({
      k: next,
      x: px - ((px - current.x) / current.k) * next,
      y: py - ((py - current.y) / current.k) * next,
    })
  }

  function startPan(event: PointerEvent) {
    if (event.button !== 0 && event.button !== 1) return
    actions.select(undefined)
    const start = { ...view() }
    const origin = { x: event.clientX, y: event.clientY }
    const move = (moved: PointerEvent) =>
      setView({ ...start, x: start.x + (moved.clientX - origin.x), y: start.y + (moved.clientY - origin.y) })
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function startDrag(event: PointerEvent, id: string) {
    event.stopPropagation()
    if (event.button !== 0) return
    const target = node(id)
    if (!target) return
    const start = { ...target.position }
    const origin = { x: event.clientX, y: event.clientY }
    const scale = view().k
    const move = (moved: PointerEvent) =>
      actions.moveNode(id, {
        x: Math.round(start.x + (moved.clientX - origin.x) / scale),
        y: Math.round(start.y + (moved.clientY - origin.y) / scale),
      })
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function startLink(event: PointerEvent, source: string) {
    event.stopPropagation()
    event.preventDefault()
    setLinking({ source, to: toGraph(event.clientX, event.clientY) })
    const move = (moved: PointerEvent) => setLinking({ source, to: toGraph(moved.clientX, moved.clientY) })
    const up = (released: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setLinking(undefined)
      const element = document.elementFromPoint(released.clientX, released.clientY)
      const target = element?.closest("[data-port-in]")?.getAttribute("data-port-in")
      if (target) actions.connect(source, target)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    const role = event.dataTransfer?.getData("application/openflow-role")
    if (!role) return
    const point = toGraph(event.clientX, event.clientY)
    actions.addNode(role, { x: Math.round(point.x - 120), y: Math.round(point.y - 20) })
  }

  const onKey = (event: KeyboardEvent) => {
    // Matched by ancestor rather than by tag name: the native `<select>`s are
    // gone, so a menu that is open (or a dialog on top) is a button, and a
    // tag-name test would let Backspace delete the selected node underneath it.
    // The same guard keeps Ctrl+Z inside a field as the browser's own undo.
    const target = event.target as HTMLElement | null
    if (target?.closest("input, textarea, select, [contenteditable], .oc-picker, .oc-backdrop")) return
    // Deleting a card takes its prompt, model and allowlists with it, so the
    // way back is undo rather than a confirm on every keypress. Shift is left
    // alone so a redo binding can be added without stealing it.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault()
      actions.undo()
      return
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return
    if (state.selected) actions.removeNode(state.selected)
  }
  window.addEventListener("keydown", onKey)
  onCleanup(() => window.removeEventListener("keydown", onKey))

  return (
    <div
      class="canvas"
      ref={surface}
      onWheel={onWheel}
      onPointerDown={startPan}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div
        class="viewport"
        style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k})` }}
      >
        <svg class="edges" width="1" height="1">
          <For each={state.pipeline.edges}>
            {(edge) => {
              const from = () => node(edge.source)
              const to = () => node(edge.target)
              return (
                <Show when={from() && to()}>
                  <g class="edge">
                    <path d={bezier(outPort(from()!.position), inPort(to()!.position))} class="edge-line" />
                    <path
                      d={bezier(outPort(from()!.position), inPort(to()!.position))}
                      class="edge-hit"
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        actions.disconnect(edge.id)
                      }}
                    />
                  </g>
                </Show>
              )
            }}
          </For>
          <Show when={linking()}>
            {(link) => (
              <Show when={node(link().source)}>
                <path d={bezier(outPort(node(link().source)!.position), link().to)} class="edge-line pending" />
              </Show>
            )}
          </Show>
        </svg>

        <For each={state.pipeline.nodes}>
          {(entry) => <NodeCard node={entry} onDragStart={startDrag} onPortDown={startLink} />}
        </For>
      </div>

      {/* The hud is a floating pill over the canvas, so its reset control uses
          the ghost button primitive rather than a bare browser button. */}
      <div class="canvas-hud">
        <button class="btn btn-ghost" onClick={() => setView({ x: 60, y: 60, k: 1 })}>
          reset view
        </button>
        <span title="zoom">{Math.round(view().k * 100)}%</span>
      </div>

      {/* This block covers the whole canvas, so its rule must keep
          `pointer-events: none` or it would swallow drops and panning. */}
      <Show when={!state.pipeline.nodes.length}>
        <div class="canvas-empty">
          <div>no nodes yet</div>
          <div class="dim">drag a role card from the palette</div>
        </div>
      </Show>
    </div>
  )
}
