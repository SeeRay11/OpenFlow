import { For } from "solid-js"
import { ROLES } from "../graph/roles"
import { actions, state } from "../state"

export function Palette() {
  return (
    <aside class="panel palette">
      <h2>roles</h2>
      <p class="hint">drag onto the canvas, or click to drop one in</p>
      <For each={ROLES}>
        {(role) => (
          <div
            class="role-card"
            style={{ "--role-color": role.color }}
            draggable="true"
            onDragStart={(event) => {
              event.dataTransfer?.setData("application/openflow-role", role.id)
              event.dataTransfer!.effectAllowed = "copy"
            }}
            onClick={() => {
              const count = state.pipeline.nodes.length
              actions.addNode(role.id, { x: 40 + (count % 3) * 300, y: 40 + Math.floor(count / 3) * 200 })
            }}
          >
            <span class="dot" />
            <span>{role.label}</span>
          </div>
        )}
      </For>

      <h2>graph</h2>
      <div class="stat">
        {state.pipeline.nodes.length} nodes · {state.pipeline.edges.length} edges
      </div>
      <p class="hint">
        drag a node header to move it · drag the right port onto a left port to connect · click an edge to delete ·
        Delete key removes the selected node
      </p>
    </aside>
  )
}
