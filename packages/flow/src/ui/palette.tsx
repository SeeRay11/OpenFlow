import { For, Show, createSignal } from "solid-js"
import { allRoles, isCustomRole, removeCustomRole, type Role } from "../graph/roles"
import { TEMPLATES, type Template } from "../graph/templates"
import { actions, state } from "../state"
import { IconEdit, IconPlus, IconTrash } from "./icons"
import { RoleEditor } from "./role-editor"

export function Palette() {
  // undefined = closed, "new" = blank editor, a Role = editing that saved role
  const [editing, setEditing] = createSignal<Role | "new">()

  /** Loads a template, replacing the graph — guarded when there is work to lose. */
  function loadTemplate(template: Template) {
    if (state.pipeline.nodes.length && !window.confirm("Replace the current pipeline?")) return
    actions.load(template.build())
  }

  return (
    <aside class="panel palette">
      <div class="panel-section">
        <h2 class="panel-title">templates</h2>
        <p class="hint">start from a ready-made pipeline</p>
        <div class="template-list">
          <For each={TEMPLATES}>
            {(template) => (
              <button
                class="template-card"
                type="button"
                title={template.description}
                onClick={() => loadTemplate(template)}
              >
                <span class="template-name">{template.name}</span>
                <span class="template-desc">{template.description}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="panel-section roles-section">
        <div class="row">
          <h2 class="panel-title">roles</h2>
          <button
            class="icon-btn"
            type="button"
            title="save a new custom role"
            aria-label="save a new custom role"
            onClick={() => setEditing("new")}
          >
            <IconPlus />
          </button>
        </div>
        <p class="hint">drag onto the canvas, or click to drop one in</p>
        <div class="role-list">
          <For each={allRoles()}>
            {(role) => {
              const drop = () => {
                const count = state.pipeline.nodes.length
                actions.addNode(role.id, { x: 40 + (count % 3) * 300, y: 40 + Math.floor(count / 3) * 200 })
              }
              const custom = () => isCustomRole(role.id)
              return (
                <div
                  class="role-card"
                  style={{ "--role-color": role.color }}
                  draggable="true"
                  role="button"
                  tabindex={0}
                  title={`add a ${role.label} node`}
                  onDragStart={(event) => {
                    event.dataTransfer?.setData("application/openflow-role", role.id)
                    event.dataTransfer!.effectAllowed = "copy"
                  }}
                  onClick={drop}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    drop()
                  }}
                >
                  <span class="role-dot" />
                  <span class="role-label">{role.label}</span>
                  <Show when={custom()}>
                    <span class="role-card-actions">
                      <button
                        class="icon-btn icon-btn-tiny"
                        type="button"
                        title={`edit ${role.label}`}
                        aria-label={`edit ${role.label}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setEditing(role)
                        }}
                      >
                        <IconEdit />
                      </button>
                      <button
                        class="icon-btn icon-btn-tiny"
                        type="button"
                        title={`delete ${role.label}`}
                        aria-label={`delete ${role.label}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeCustomRole(role.id)
                        }}
                      >
                        <IconTrash />
                      </button>
                    </span>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      <div class="panel-section">
        <h2 class="panel-title">graph</h2>
        <div class="stat">
          {state.pipeline.nodes.length} nodes · {state.pipeline.edges.length} edges
        </div>
        {/* one line per gesture: as a single paragraph these four run together and nobody reads past the first. */}
        <p class="hint">drag a node header to move it</p>
        <p class="hint">drag the right port onto a left port to connect</p>
        <p class="hint">click an edge to delete it</p>
        <p class="hint">Delete key removes the selected node</p>
      </div>

      <Show when={editing() !== undefined}>
        <RoleEditor
          role={editing() === "new" ? undefined : (editing() as Role)}
          onClose={() => setEditing(undefined)}
          onSaved={() => {}}
        />
      </Show>
    </aside>
  )
}
