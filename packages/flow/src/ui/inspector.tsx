import { For, Show, createMemo, createSignal } from "solid-js"
import { upstream } from "../graph/validate"
import * as api from "../server/client"
import type { ProviderRow } from "../server/providers"
import { TOOLS } from "../server/store"
import { actions, runtimeOf, state } from "../state"
import { ModelPicker } from "./model-picker"

export function Inspector(props: {
  agents: string[]
  providers: ProviderRow[]
  onManageKeys?: (query?: string) => void
}) {
  const node = createMemo(() => state.pipeline.nodes.find((entry) => entry.id === state.selected))
  const runtime = createMemo(() => (state.selected ? runtimeOf(state.selected) : undefined))
  const [testing, setTesting] = createSignal(false)

  /**
   * Sends one throwaway prompt to the selected model.
   *
   * A model being listed does not mean the account may use it — the zen
   * catalog advertises models that answer `401 Model ... is not supported` —
   * and a stored key is never verified when it is saved. This is the only
   * thing that answers "does this actually work" short of a full run.
   */
  async function test(model: string) {
    setTesting(true)
    actions.notice("info", `testing ${model}…`)
    const result = await api.testModel(model)
    setTesting(false)
    if (result.ok) return actions.notice("info", `${model} answered in ${(result.ms / 1000).toFixed(1)}s`)
    actions.notice("error", `${model} failed — ${result.error}`)
  }

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
              <ModelPicker
                value={selected().agent.model ?? ""}
                rows={props.providers}
                onChange={(value) => actions.updateAgent(selected().id, { model: value })}
                onManage={props.onManageKeys}
              />
            </label>
            <div class="row">
              <span class="hint">blank runs on the agent's own default</span>
              <button
                disabled={!selected().agent.model || testing()}
                title="run one throwaway prompt against this model to see whether the key and entitlement are real"
                onClick={() => test(selected().agent.model!)}
              >
                test
              </button>
            </div>

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
