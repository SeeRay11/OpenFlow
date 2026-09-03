import { Show } from "solid-js"
import { roleColor } from "../graph/roles"
import type { FlowNode, NodeStatus } from "../graph/types"
import { actions, runtimeOf, state } from "../state"
import { NODE_WIDTH } from "./geometry"

/** One line explaining what a card's status word means, for the badge tooltip. */
function statusHelp(status: NodeStatus) {
  const help: Record<NodeStatus, string> = {
    idle: "idle — waiting to be run",
    queued: "queued — waiting for its turn in the run",
    running: "running — this card's session is active",
    done: "done — the session finished",
    error: "error — the session failed",
    skipped: "skipped — an upstream node failed, so this never ran",
    stopped: "stopped — the run was stopped before this finished",
  }
  return help[status]
}

export function NodeCard(props: {
  node: FlowNode
  onDragStart: (event: PointerEvent, id: string) => void
  onPortDown: (event: PointerEvent, id: string) => void
}) {
  const runtime = () => runtimeOf(props.node.id)
  const selected = () => state.selection.includes(props.node.id)
  /** A card is worth expanding once it has a session — live or finished. */
  const hasActivity = () => !!runtime().events?.length || !!runtime().sessionID
  const expanded = () => state.expanded === props.node.id

  /**
   * Opens the activity drawer.
   *
   * Bound to `click` rather than `pointerdown` so it cannot fire at the start
   * of a header drag, and ignored for the header and the ports, which own their
   * own gestures.
   */
  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null
    if (target?.closest(".node-header, .port")) return
    if (!hasActivity()) return
    actions.expand(expanded() ? undefined : props.node.id)
  }

  // The card is focusable so a keyboard can reach it, but selection is bound to
  // Enter rather than to focus. Pressing on the header focuses the card as a
  // browser side effect, and selecting from focus would silently change what a
  // header drag does today.
  return (
    <div
      class="node"
      classList={{ selected: selected(), expanded: expanded(), [`status-${runtime().status}`]: true }}
      style={{
        left: `${props.node.position.x}px`,
        top: `${props.node.position.y}px`,
        width: `${NODE_WIDTH}px`,
        "--role-color": roleColor(props.node.role),
      }}
      tabindex={0}
      data-node-id={props.node.id}
      onPointerDown={(event) => {
        event.stopPropagation()
        // Ctrl/Cmd adds one card, Shift takes the whole chain, and a plain
        // press on a card that is already selected leaves the selection alone
        // — otherwise dragging a group by one of its cards would collapse the
        // selection to that card before the drag started.
        if (event.ctrlKey || event.metaKey) return actions.toggleSelect(props.node.id)
        if (event.shiftKey) return actions.selectPath(props.node.id)
        if (selected()) return
        actions.select(props.node.id)
      }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) return actions.toggleSelect(props.node.id)
        if (event.shiftKey) return actions.selectPath(props.node.id)
        actions.select(props.node.id)
        if (hasActivity()) actions.expand(expanded() ? undefined : props.node.id)
      }}
    >
      <div
        class="node-header"
        title="drag to move this card"
        onPointerDown={(event) => props.onDragStart(event, props.node.id)}
      >
        <span class="node-role">{props.node.role}</span>
        <span class="badge" data-status={runtime().status} title={statusHelp(runtime().status)}>
          {runtime().status}
        </span>
      </div>

      <div class="node-body">
        <div class="node-line" title="runs on the agent's own default when blank">
          {props.node.agent.model || "default model"}
        </div>
        <Show when={props.node.agent.name}>
          <div class="node-meta">agent: {props.node.agent.name}</div>
        </Show>
        <Show when={runtime().activity}>
          <div class="node-line accent">{runtime().activity}</div>
        </Show>
        <Show when={runtime().error}>
          <div class="node-error">{runtime().error}</div>
        </Show>
        {/* The preview is one class now, so the three-line clamp lives on
            `.node-output` instead of a separate `.clamp` modifier. */}
        <Show when={!runtime().error && runtime().output}>
          <div class="node-output">{runtime().output}</div>
        </Show>

        {/* The card itself is the affordance, but a card that can be opened
            should say so — and the count is the only place the size of what is
            hidden shows up. `stopPropagation` keeps the card's own click from
            toggling the drawer a second time. */}
        <Show when={hasActivity()}>
          <button
            class="node-activity"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              actions.expand(expanded() ? undefined : props.node.id)
            }}
          >
            {expanded() ? "hide activity" : "show activity"}
            <Show when={runtime().events?.length}>
              <span class="dim">{runtime().events!.length}</span>
            </Show>
          </button>
        </Show>
      </div>

      <div class="port port-in" data-port-in={props.node.id} title="input" />
      <div
        class="port port-out"
        data-port-out={props.node.id}
        title="drag to an input port to connect"
        onPointerDown={(event) => props.onPortDown(event, props.node.id)}
      />
    </div>
  )
}
