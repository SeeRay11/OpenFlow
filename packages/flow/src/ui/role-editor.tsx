import { For, Show, createSignal } from "solid-js"
import { allRoles, removeCustomRole, saveCustomRole, type Role } from "../graph/roles"
import { TOOLS } from "../server/store"
import { IconClose, IconTrash } from "./icons"

const DEFAULT_COLOR = "#9ad1f0"

/**
 * Create or edit a reusable role. Saved roles are global — not part of the
 * pipeline — so the same "design planner" built once shows up in every
 * workflow's palette, the way the built-in presets already do.
 */
export function RoleEditor(props: { role?: Role; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = createSignal(props.role?.label ?? "")
  const [color, setColor] = createSignal(props.role?.color ?? DEFAULT_COLOR)
  const [prompt, setPrompt] = createSignal(props.role?.agent.prompt ?? "")
  const [tools, setTools] = createSignal<Record<string, boolean>>({ ...(props.role?.agent.tools ?? {}) })
  const [error, setError] = createSignal<string>()

  function toggleTool(tool: string, enabled: boolean) {
    setTools((current) => ({ ...current, [tool]: enabled }))
  }

  function save(event: Event) {
    event.preventDefault()
    const name = label().trim()
    if (!name) return setError("Name this role.")
    const taken = allRoles().some((entry) => entry.label === name && entry.id !== props.role?.id)
    if (taken) return setError(`A role named "${name}" already exists.`)
    const saved = saveCustomRole({
      id: props.role?.id,
      label: name,
      color: color(),
      agent: { prompt: prompt(), tools: tools() },
    })
    props.onSaved()
    // The role is live either way — only the write-through failed. Stay open so
    // the prompt can be copied out before a reload takes it.
    if (!saved.persisted)
      return setError(
        "Saved for this session only — the browser refused to store it. Copy your prompt somewhere safe before reloading.",
      )
    props.onClose()
  }

  function remove() {
    if (!props.role) return
    if (!window.confirm(`Delete the role "${props.role.label}"? Its prompt, tools and color are gone for good.`)) return
    const persisted = removeCustomRole(props.role.id)
    props.onSaved()
    if (!persisted)
      return setError(
        "Deleted for this session only — the browser refused to store the change, so the role comes back on reload.",
      )
    props.onClose()
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>{props.role ? "Edit role" : "New role"}</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <form class="oc-form" onSubmit={save}>
          <label>
            name
            <input
              autofocus
              value={label()}
              placeholder="e.g. design planner"
              spellcheck={false}
              autocomplete="off"
              onInput={(event) => setLabel(event.currentTarget.value)}
            />
          </label>

          <label class="role-color-field">
            color
            <input
              type="color"
              class="role-color-input"
              value={color()}
              onInput={(event) => setColor(event.currentTarget.value)}
            />
          </label>

          <label>
            prompt
            <textarea
              rows="6"
              value={prompt()}
              placeholder="What this role should do, and what it's not allowed to do."
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </label>

          <div class="field-row">
            <span class="field-label">tools</span>
            <div class="tools">
              <For each={TOOLS}>
                {(tool) => (
                  <label class="tool-check">
                    <input
                      type="checkbox"
                      checked={tools()[tool] ?? false}
                      onChange={(event) => toggleTool(tool, event.currentTarget.checked)}
                    />
                    {tool}
                  </label>
                )}
              </For>
            </div>
          </div>

          <Show when={error()}>{(text) => <p class="oc-error">{text()}</p>}</Show>

          <div class="oc-form-actions">
            <button type="submit" class="oc-button oc-primary">
              {props.role ? "Save" : "Create role"}
            </button>
            <Show when={props.role}>
              <button type="button" class="oc-button oc-danger" onClick={remove}>
                <IconTrash />
                Delete
              </button>
            </Show>
          </div>
        </form>
      </section>
    </div>
  )
}
