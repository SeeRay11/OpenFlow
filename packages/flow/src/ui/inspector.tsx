import { For, Show, createMemo } from "solid-js"
import { upstream } from "../graph/validate"
import { actions, runtimeOf, state } from "../state"

const TOOLS = ["read", "grep", "glob", "write", "edit", "bash", "webfetch", "task"]

export function Inspector(props: { agents: string[] }) {
  const node = createMemo(() => state.pipeline.nodes.find((entry) => entry.id === state.selected))
  const runtime = createMemo(() => (state.selected ? runtimeOf(state.selected) : undefined))

  return (
    <aside class="panel inspector">
      <Show when={node()} fallback={<p class="hint">select a node to edit it</p>}>
        {(selected) => (
          <>
            <h2>node</h2>
            <label>
              role
              <input
                value={selected().role}
                onInput={(event) => actions.updateNode(selected().id, { role: event.currentTarget.value })}
              />
            </label>

            <label>
              model
              <input
                list="openflow-models"
                placeholder="provider/model — blank uses the agent default"
                value={selected().agent.model ?? ""}
                onInput={(event) => actions.updateAgent(selected().id, { model: event.currentTarget.value })}
              />
            </label>

            <label>
              agent
              <select
                value={selected().agent.name ?? ""}
                onChange={(event) => actions.updateAgent(selected().id, { name: event.currentTarget.value })}
              >
                <option value="">(server default)</option>
                <For each={props.agents}>{(agent) => <option value={agent}>{agent}</option>}</For>
              </select>
            </label>

            <label>
              prompt
              <textarea
                rows="8"
                value={selected().agent.prompt}
                onInput={(event) => actions.updateAgent(selected().id, { prompt: event.currentTarget.value })}
              />
            </label>

            <div class="tools">
              <For each={TOOLS}>
                {(tool) => (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={selected().agent.tools?.[tool] ?? false}
                      onChange={(event) => actions.toggleTool(selected().id, tool, event.currentTarget.checked)}
                    />
                    {tool}
                  </label>
                )}
              </For>
            </div>

            <div class="row">
              <span class="hint">
                inputs: {upstream(state.pipeline, selected().id).length} · id {selected().id}
              </span>
              <button class="danger" onClick={() => actions.removeNode(selected().id)}>
                delete
              </button>
            </div>

            <Show when={runtime()?.sessionID}>
              <h2>session</h2>
              <div class="hint mono">{runtime()!.sessionID}</div>
            </Show>

            <Show when={runtime()?.prompt}>
              <h2>sent prompt</h2>
              <pre class="transcript">{runtime()!.prompt}</pre>
            </Show>

            <Show when={runtime()?.error}>
              <h2>error</h2>
              <pre class="transcript error">{runtime()!.error}</pre>
            </Show>

            <Show when={runtime()?.output}>
              <h2>output</h2>
              <pre class="transcript">{runtime()!.output}</pre>
            </Show>
          </>
        )}
      </Show>
    </aside>
  )
}
