import { For, Show, createSignal, onMount } from "solid-js"
import { Canvas } from "./canvas/canvas"
import type { Pipeline, RunLog } from "./graph/types"
import { layer } from "./graph/validate"
import * as api from "./server/client"
import { start, type PermissionPolicy, type PipeMode, type Run } from "./server/engine"
import { agentBlock, agentKey, store, type PipelineEntry, type RunEntry } from "./server/store"
import { actions, state } from "./state"
import { Inspector } from "./ui/inspector"
import { Palette } from "./ui/palette"

export function App() {
  const [status, setStatus] = createSignal("connecting…")
  const [agents, setAgents] = createSignal<string[]>([])
  const [models, setModels] = createSignal<string[]>([])
  const [pipelines, setPipelines] = createSignal<PipelineEntry[]>([])
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [project, setProject] = createSignal("")
  const [pipe, setPipe] = createSignal<PipeMode>("ancestors")
  const [policy, setPolicy] = createSignal<PermissionPolicy>("auto")
  let current: Run | undefined

  onMount(async () => {
    try {
      const { context } = await api.connect()
      setProject(context.project)
      await api.health()
      setStatus("connected")
      const [agentList, modelList] = await Promise.all([api.agents(), api.models()])
      setAgents(agentList.filter((agent) => !agent.hidden).map((agent) => agent.id))
      setModels(modelList.map((model) => `${model.providerID}/${model.id}`))
    } catch (error) {
      setStatus(`offline — ${api.describe(error)}`)
      actions.notice("error", `cannot reach opencode serve: ${api.describe(error)}`)
    }
    await refresh()
  })

  async function refresh() {
    setPipelines(await store.pipelines().catch(() => []))
    setRuns(await store.runs().catch(() => []))
  }

  async function save() {
    const check = layer(state.pipeline)
    if (!check.ok) return actions.notice("error", check.error)
    try {
      const saved = await store.savePipeline(state.pipeline)
      const generated = await store.saveAgents(state.pipeline.name, agentBlock(state.pipeline))
      actions.notice("info", `saved ${saved.path} · agents ${generated.path}`)
      await refresh()
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  async function load(name: string) {
    if (!name) return
    try {
      const pipeline = (await store.pipeline(name)) as Pipeline
      actions.load(pipeline)
      actions.notice("info", `loaded ${name}`)
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  /**
   * Folds the generated agent defs into the project's opencode.json (after a
   * .bak) and points every node at its own agent, so the per-node tool
   * allowlist actually applies at runtime — sessions can only pick tools
   * through a named agent.
   */
  async function mergeAgents() {
    try {
      const result = await store.saveAgents(state.pipeline.name, agentBlock(state.pipeline), true)
      for (const node of state.pipeline.nodes) actions.updateAgent(node.id, { name: agentKey(state.pipeline, node) })
      setAgents([...new Set([...agents(), ...state.pipeline.nodes.map((node) => agentKey(state.pipeline, node))])])
      actions.notice("info", `merged into ${result.path}${result.backup ? ` (backup ${result.backup})` : ""}`)
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  async function run() {
    const check = layer(state.pipeline)
    if (!check.ok) return actions.notice("error", check.error)
    actions.resetRuntime(Object.fromEntries(state.pipeline.nodes.map((node) => [node.id, "queued" as const])))
    actions.setRunning(true)
    actions.clearNotice()
    try {
      current = start(
        state.pipeline,
        state.input,
        {
          onNode: (id, patch) => actions.patchRuntime(id, patch),
          onRun: (log) => actions.setRun(clone(log)),
          onNotice: actions.notice,
          onPermission: (request) =>
            actions.askPermission({
              requestID: request.requestID,
              nodeID: request.nodeID,
              role: request.role,
              action: request.action,
              resources: request.resources,
            }),
        },
        { pipe: pipe(), permissions: policy() },
      )
      const log = await current.done
      const failure = log.nodes.find((node) => node.status === "error")
      actions.notice(
        log.status === "error" ? "error" : "info",
        failure ? `run ${log.id} error — ${failure.role}: ${failure.error}` : `run ${log.id} ${log.status}`,
      )
    } catch (error) {
      actions.notice("error", api.describe(error))
    } finally {
      actions.setRunning(false)
      actions.rejectPermissions()
      current = undefined
      await refresh()
    }
  }

  async function stop() {
    actions.rejectPermissions()
    await current?.stop()
    actions.notice("info", "stopping run…")
  }

  async function openRun(id: string) {
    try {
      const log = await store.run(id)
      actions.setRun(log)
      actions.resetRuntime({})
      for (const node of log.nodes) {
        actions.patchRuntime(node.id, {
          status: node.status,
          output: node.output,
          error: node.error,
          prompt: node.prompt,
          sessionID: node.sessionID,
        })
      }
      actions.notice("info", `loaded run ${id}`)
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  return (
    <div class="app">
      <header class="toolbar">
        <strong class="brand">OpenFlow</strong>
        <input
          class="name"
          value={state.pipeline.name}
          onInput={(event) => actions.rename(event.currentTarget.value)}
          title="pipeline name"
        />
        <button onClick={() => actions.reset()}>new</button>
        <button onClick={save}>save</button>
        <select
          onChange={(event) => {
            void load(event.currentTarget.value)
            event.currentTarget.value = ""
          }}
        >
          <option value="">load…</option>
          <For each={pipelines()}>
            {(entry) => (
              <option value={entry.name}>
                {entry.name} ({entry.nodes})
              </option>
            )}
          </For>
        </select>
        <button onClick={mergeAgents} title="merge generated agent defs into the project opencode.json">
          merge agents
        </button>

        <select
          class="pipe"
          value={pipe()}
          title="how much upstream output each node receives"
          onChange={(event) => setPipe(event.currentTarget.value as PipeMode)}
        >
          <option value="ancestors">pipe: ancestors</option>
          <option value="direct">pipe: direct</option>
        </select>
        <select
          class="pipe"
          value={policy()}
          title="what happens when an agent asks for permission mid-run"
          onChange={(event) => setPolicy(event.currentTarget.value as PermissionPolicy)}
        >
          <option value="auto">permissions: auto</option>
          <option value="manual">permissions: ask me</option>
        </select>
        <input
          class="task"
          placeholder="task for this run"
          value={state.input}
          onInput={(event) => actions.setInput(event.currentTarget.value)}
        />
        <button class="primary" disabled={state.running} onClick={run}>
          run
        </button>
        <button class="danger" disabled={!state.running} onClick={stop}>
          stop
        </button>
        <span class="status" classList={{ bad: status().startsWith("offline") }}>
          {status()}
        </span>
      </header>

      <Show when={state.notice}>
        {(notice) => (
          <div class="notice" classList={{ bad: notice().kind === "error" }} onClick={actions.clearNotice}>
            {notice().text}
          </div>
        )}
      </Show>

      <Show when={state.permissions.length}>
        <div class="permissions">
          <For each={state.permissions}>
            {(request) => (
              <div class="permission">
                <span class="permission-what">
                  <strong>{request.role}</strong> wants <code>{request.action}</code>
                  <Show when={request.resources.length}>
                    <span class="dim"> on {request.resources.slice(0, 3).join(", ")}</span>
                  </Show>
                </span>
                <span class="permission-actions">
                  <button onClick={() => actions.answerPermission(request.requestID, "once")}>allow once</button>
                  <button onClick={() => actions.answerPermission(request.requestID, "always")} title="persists to the project's saved permissions, beyond this run">
                    always
                  </button>
                  <button class="danger" onClick={() => actions.answerPermission(request.requestID, "reject")}>
                    reject
                  </button>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <main>
        <Palette />
        <Canvas />
        <Inspector agents={agents()} />
      </main>

      <footer class="runs">
        <div class="run-current">
          <Show when={state.run} fallback={<span class="hint">no run yet</span>}>
            {(log) => (
              <>
                <strong>{log().id}</strong>
                <span class="badge" data-status={log().status}>
                  {log().status}
                </span>
                <For each={log().nodes}>
                  {(node) => (
                    <span class="run-node" data-status={node.status} onClick={() => actions.select(node.id)}>
                      {node.role}
                      <span class="badge" data-status={node.status}>
                        {node.status}
                      </span>
                    </span>
                  )}
                </For>
              </>
            )}
          </Show>
        </div>
        <div class="run-history">
          <select
            onChange={(event) => {
              void openRun(event.currentTarget.value)
              event.currentTarget.value = ""
            }}
          >
            <option value="">run log…</option>
            <For each={runs()}>
              {(entry) => (
                <option value={entry.id}>
                  {entry.id} · {entry.pipeline} · {entry.status}
                </option>
              )}
            </For>
          </select>
          <span class="hint mono">{project()}</span>
        </div>
      </footer>

      <datalist id="openflow-models">
        <For each={models()}>{(model) => <option value={model} />}</For>
      </datalist>
    </div>
  )
}

function clone(log: RunLog): RunLog {
  return { ...log, nodes: log.nodes.map((node) => ({ ...node })) }
}
