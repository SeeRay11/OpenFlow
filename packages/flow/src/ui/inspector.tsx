import { For, Show, createMemo, createSignal } from "solid-js"
import { upstream } from "../graph/validate"
import * as api from "../server/client"
import type { ProviderRow } from "../server/providers"
import { TOOLS, TOOL_HELP } from "../server/store"
import { actions, primary, runtimeOf, state } from "../state"
import { Attachments, readFiles } from "./attachments"
import { IconTrash } from "./icons"
import { ModelPicker } from "./model-picker"
import { Select } from "./select"
import { costLabel, formatCost, formatTokens } from "../server/usage"

export function Inspector(props: {
  agents: string[]
  providers: ProviderRow[]
  /** MCP servers the project configures, by name. */
  mcpServers: string[]
  onManageKeys?: (query?: string) => void
  onManageMcp?: () => void
}) {
  // With several cards selected the fields show the primary card's values —
  // somebody's have to be shown — and an edit lands on all of them.
  const node = createMemo(() => state.pipeline.nodes.find((entry) => entry.id === primary()))
  const runtime = createMemo(() => (primary() ? runtimeOf(primary()) : undefined))
  const many = () => state.selection.length > 1
  const [testing, setTesting] = createSignal(false)

  /**
   * Sends one throwaway prompt to the selected model.
   *
   * A model being listed does not mean the account may use it — the zen
   * catalog advertises models that answer `401 Model ... is not supported` —
   * and a stored key is never verified when it is saved. This is the only
   * thing that answers "does this actually work" short of a full run.
   */
  /** Reads picked files into data URLs and pins them to the node. */
  async function attach(id: string, files: File[]) {
    const { attachments, errors } = await readFiles(files)
    actions.addNodeAttachments(id, attachments)
    for (const failure of errors) actions.notice("error", `${failure.name}: ${failure.reason}`)
  }

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
      <Show when={node()} fallback={<div class="empty-state">select a node to edit it</div>}>
        {(selected) => (
          <>
            <div class="panel-section">
              <h2 class="panel-title">node</h2>

              <Show when={many()}>
                <div class="hint">
                  {state.selection.length} cards selected — role, model, agent, prompt and tools apply to
                  all of them
                </div>
              </Show>

              {/*
                native controls keep their wrapping <label> so clicking the caption
                still focuses the input; the two pickers below are buttons, not form
                controls, so they get a plain row and a <span> caption instead.
              */}
              <label class="field-row">
                <span class="field-label" title="this card's label and colour — also the role text runs read in the pipeline">
                  role
                </span>
                <input
                  class="field"
                  value={selected().role}
                  onInput={(event) => actions.updateSelected({ role: event.currentTarget.value })}
                />
              </label>

              <div class="field-row">
                <span class="field-label" title="which model runs this card — blank uses the agent's own default">
                  model
                </span>
                <ModelPicker
                  value={selected().agent.model ?? ""}
                  rows={props.providers}
                  onChange={(value) => actions.updateSelectedAgent({ model: value })}
                  onManage={props.onManageKeys}
                />
              </div>
              <div class="row">
                <span class="hint">blank runs on the agent's own default</span>
                <button
                  class="btn"
                  disabled={!selected().agent.model || testing()}
                  title="run one throwaway prompt against this model to see whether the key and entitlement are real"
                  onClick={() => test(selected().agent.model!)}
                >
                  test
                </button>
              </div>

              <div class="field-row">
                <span class="field-label" title="the opencode agent whose tool allowlist this card runs under">
                  agent
                </span>
                <Select
                  value={selected().agent.name ?? ""}
                  options={[
                    { value: "", label: "(server default)" },
                    ...props.agents.map((agent) => ({ value: agent, label: agent })),
                  ]}
                  onChange={(value) => actions.updateSelectedAgent({ name: value })}
                />
              </div>

              <label class="field-row">
                <span class="field-label" title="role instructions prepended to every prompt this card sends">
                  prompt
                </span>
                <textarea
                  class="field"
                  rows="8"
                  value={selected().agent.prompt}
                  onInput={(event) => actions.updateSelectedAgent({ prompt: event.currentTarget.value })}
                />
              </label>

              <div class="tools">
                <For each={TOOLS}>
                  {(tool) => (
                    <label class="tool-check" title={TOOL_HELP[tool] ?? tool}>
                      <input
                        type="checkbox"
                        checked={selected().agent.tools?.[tool] ?? false}
                        onChange={(event) => actions.toggleSelectedTool(tool, event.currentTarget.checked)}
                      />
                      {tool}
                    </label>
                  )}
                </For>
              </div>

              <div class="field-row field-row-stack">
                <span class="field-label">mcp servers</span>
                <Show
                  when={props.mcpServers.length}
                  fallback={
                    <div class="row">
                      <span class="hint">none configured for this project</span>
                      <Show when={props.onManageMcp}>
                        <button class="btn" type="button" onClick={() => props.onManageMcp!()}>
                          add one
                        </button>
                      </Show>
                    </div>
                  }
                >
                  <div class="tools">
                    <For each={props.mcpServers}>
                      {(server) => (
                        <label class="tool-check">
                          <input
                            type="checkbox"
                            // No list on the node means "inherit everything",
                            // which is what a graph authored before per-node
                            // MCP existed asked for. Ticking any box writes an
                            // explicit list from then on.
                            checked={selected().agent.mcp?.includes(server) ?? true}
                            onChange={(event) =>
                              actions.toggleMcp(
                                selected().id,
                                server,
                                event.currentTarget.checked,
                                props.mcpServers,
                              )
                            }
                          />
                          {server}
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="field-row field-row-stack">
                <span class="field-label">files</span>
                <Attachments
                  compact
                  label="attach to this card"
                  files={selected().agent.attachments ?? []}
                  onAdd={(files) => void attach(selected().id, files)}
                  onRemove={(id) => actions.removeNodeAttachment(selected().id, id)}
                />
                <span class="hint">sent with every run of this card, on top of the run's own files</span>
              </div>

              <div class="row">
                <span class="hint">
                  inputs: {upstream(state.pipeline, selected().id).length} · id {selected().id}
                </span>
                <button class="btn btn-danger" type="button" onClick={() => actions.removeSelected()}>
                  <IconTrash />
                  {many() ? `delete ${state.selection.length}` : "delete"}
                </button>
              </div>
            </div>

            <Show when={runtime()?.sessionID}>
              <div class="panel-section">
                <h2 class="panel-title">session</h2>
                <div class="hint mono">{runtime()!.sessionID}</div>
              </div>
            </Show>

            {/*
              Per-card spend, from the tokens the provider reported for this
              card's session. A model with no published price shows its tokens
              and says so instead of showing a zero.
            */}
            <Show when={runtime()?.usage?.steps}>
              <div class="panel-section">
                <h2 class="panel-title">cost</h2>
                <div class="row">
                  <span class="spend-total-value">{costLabel(runtime()!.usage!)}</span>
                  <span class="hint">
                    {formatTokens(
                      runtime()!.usage!.tokens.input +
                        runtime()!.usage!.tokens.output +
                        runtime()!.usage!.tokens.reasoning +
                        runtime()!.usage!.tokens.cacheRead +
                        runtime()!.usage!.tokens.cacheWrite,
                    )}{" "}
                    tokens · {runtime()!.usage!.steps} steps
                  </span>
                </div>
                <For each={runtime()!.usage!.models}>
                  {(model) => (
                    <div class="spend-row">
                      <span class="spend-name mono dim">{model.model}</span>
                      <span class="spend-cost" classList={{ dim: !model.priced }}>
                        {model.priced ? formatCost(model.cost ?? 0) : "no published price"}
                      </span>
                    </div>
                  )}
                </For>
                <span class="hint">
                  input {runtime()!.usage!.tokens.input} · output {runtime()!.usage!.tokens.output} · reasoning{" "}
                  {runtime()!.usage!.tokens.reasoning} · cache read {runtime()!.usage!.tokens.cacheRead} · cache write{" "}
                  {runtime()!.usage!.tokens.cacheWrite}
                </span>
              </div>
            </Show>

            <Show when={runtime()?.prompt}>
              <div class="panel-section">
                <h2 class="panel-title">sent prompt</h2>
                <pre class="transcript">{runtime()!.prompt}</pre>
              </div>
            </Show>

            <Show when={runtime()?.error}>
              <div class="panel-section">
                <h2 class="panel-title">error</h2>
                <pre class="transcript transcript-error">{runtime()!.error}</pre>
              </div>
            </Show>

            <Show when={runtime()?.output}>
              <div class="panel-section">
                <h2 class="panel-title">output</h2>
                <pre class="transcript">{runtime()!.output}</pre>
              </div>
            </Show>
          </>
        )}
      </Show>
    </aside>
  )
}
