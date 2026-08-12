import { Show } from "solid-js"
import { roleColor } from "../graph/roles"
import type { FlowNode } from "../graph/types"
import { actions, runtimeOf, state } from "../state"
import { NODE_WIDTH } from "./geometry"

export function NodeCard(props: {
  node: FlowNode
  onDragStart: (event: PointerEvent, id: string) => void
  onPortDown: (event: PointerEvent, id: string) => void
}) {
  const runtime = () => runtimeOf(props.node.id)
  const selected = () => state.selected === props.node.id

  return (
    <div
      class="node"
      classList={{ selected: selected(), [`status-${runtime().status}`]: true }}
      style={{
        left: `${props.node.position.x}px`,
        top: `${props.node.position.y}px`,
        width: `${NODE_WIDTH}px`,
        "--role-color": roleColor(props.node.role),
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
        actions.select(props.node.id)
      }}
    >
      <div class="node-header" onPointerDown={(event) => props.onDragStart(event, props.node.id)}>
        <span class="node-role">{props.node.role}</span>
        <span class="badge" data-status={runtime().status}>
          {runtime().status}
        </span>
      </div>

      <div class="node-body">
        <div class="node-line">{props.node.agent.model || "default model"}</div>
        <Show when={props.node.agent.name}>
          <div class="node-line dim">agent: {props.node.agent.name}</div>
        </Show>
        <Show when={runtime().activity}>
          <div class="node-line accent">{runtime().activity}</div>
        </Show>
        <Show when={runtime().error}>
          <div class="node-line error">{runtime().error}</div>
        </Show>
        <Show when={!runtime().error && runtime().output}>
          <div class="node-line dim clamp">{runtime().output}</div>
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
