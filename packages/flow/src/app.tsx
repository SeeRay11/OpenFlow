import { For, Show, createSignal, onMount } from "solid-js"
import { Canvas } from "./canvas/canvas"
import type { Pipeline, RunLog } from "./graph/types"
import { layer } from "./graph/validate"
import * as api from "./server/client"
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_NODE_TIMEOUT,
  start,
  type PermissionPolicy,
  type PipeMode,
  type Run,
} from "./server/engine"
import { providerRows, type ProviderRow } from "./server/providers"
import { agentBlock, agentKey, store, type PipelineEntry, type RunEntry } from "./server/store"
import { actions, state } from "./state"
import {
  IconAlert,
  IconClose,
  IconFlow,
  IconFolder,
  IconHistory,
  IconInfo,
  IconKey,
  IconLayers,
  IconPlay,
  IconPlus,
  IconSave,
  IconSliders,
  IconStop,
} from "./ui/icons"
import { Inspector } from "./ui/inspector"
import { Palette } from "./ui/palette"
import { ProjectPicker } from "./ui/project-picker"
import { ProvidersPanel } from "./ui/providers-panel"
import { SkillsPanel } from "./ui/skills-panel"
import { Select, type SelectOption } from "./ui/select"

// The four run settings are fixed lists, so they are built once here rather
// than rebuilt on every render. Each label is only the value — the trigger
// prints the name through the `prefix` prop, so a row reads "auto" while the
// bar reads "permissions: auto".
const PIPE_OPTIONS: SelectOption[] = [
  { value: "ancestors", label: "ancestors", hint: "every upstream node" },
  { value: "direct", label: "direct", hint: "immediate parents only" },
]
const POLICY_OPTIONS: SelectOption[] = [
  { value: "auto", label: "auto", hint: "answer for me" },
  { value: "manual", label: "ask me", hint: "prompt on the bar" },
]
const PARALLEL_OPTIONS: SelectOption[] = [1, 2, 4, 8].map((value) => ({
  value: String(value),
  label: String(value),
}))
const TIMEOUT_OPTIONS: SelectOption[] = [5, 15, 30, 60].map((minutes) => ({
  value: String(minutes * 60_000),
  label: `${minutes}m`,
}))

export function App() {
  const [status, setStatus] = createSignal("connecting…")
  const [agents, setAgents] = createSignal<string[]>([])
  const [providers, setProviders] = createSignal<ProviderRow[]>([])
  const [showProviders, setShowProviders] = createSignal(false)
  const [showSkills, setShowSkills] = createSignal(false)
  const [showProjectPicker, setShowProjectPicker] = createSignal(false)
  const [providerQuery, setProviderQuery] = createSignal("")
  const [pipelines, setPipelines] = createSignal<PipelineEntry[]>([])
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [project, setProject] = createSignal("")
  const [pipe, setPipe] = createSignal<PipeMode>("ancestors")
  const [policy, setPolicy] = createSignal<PermissionPolicy>("auto")
  const [parallel, setParallel] = createSignal(DEFAULT_MAX_PARALLEL)
  const [nodeTimeout, setNodeTimeout] = createSignal(DEFAULT_NODE_TIMEOUT)
  let current: Run | undefined

  /**
   * Connects (or reconnects, after a project switch) and reloads everything
   * that is scoped to the project directory: the agent list, the provider
   * catalog, saved pipelines, recorded runs.
   */
  async function bootstrap() {
    setStatus("connecting…")
    try {
      const { context } = await api.connect()
      setProject(context.project)
      await api.health()
      setStatus("connected")
      const agentList = await api.agents()
      setAgents(agentList.filter((agent) => !agent.hidden).map((agent) => agent.id))
      await refreshProviders()
    } catch (error) {
      // The dev proxy already names the server when it is the thing that is
      // down, so the prefix is only added when the message lacks it.
      const detail = api.describe(error)
      setStatus(`offline — ${detail}`)
      actions.notice("error", detail.includes("opencode serve") ? detail : `cannot reach opencode serve: ${detail}`)
    }
    await refresh()
  }

  onMount(bootstrap)

  async function switchProject(next: string) {
    setShowProjectPicker(false)
    await bootstrap()
    actions.notice("info", `switched project to ${next}`)
  }

  /**
   * Re-reads the catalog and the credential store together.
   *
   * They have to be read as a pair: a model list alone cannot say whether a
   * provider is missing because no key is stored or because the key stored is
   * wrong. The third read asks the host which provider environment variables
   * are set, which is the only way to tell an env-authenticated provider from
   * the free zen models the server hands out with no key at all. Called after
   * every key change, since a connected key changes the catalog immediately —
   * no server restart, unlike an agent merge.
   */
  async function refreshProviders() {
    const [integrationList, modelList] = await Promise.all([
      api.integrations().catch(() => []),
      api.models().catch(() => []),
    ])
    const names = [
      ...new Set(
        integrationList.flatMap((item) =>
          item.methods.flatMap((method) => (method.type === "env" ? (method.names ?? []) : [])),
        ),
      ),
    ]
    const [env, zen] = await Promise.all([
      store.envPresent(names).catch(() => ({ present: [] as string[] })),
      store.zenModels().catch(() => ({ ids: null })),
    ])
    // Only providers whose real model list could be read are constrained; the
    // rest stay as the catalog reports them.
    const serves = zen.ids ? new Map([["opencode", new Set(zen.ids)]]) : undefined
    setProviders(providerRows(integrationList, modelList, env.present, serves))
  }

  /** `query` carries a provider name the model search could not satisfy. */
  function openProviders(query?: string) {
    setProviderQuery(query ?? "")
    setShowProviders(true)
  }

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
      const keys = state.pipeline.nodes.map((node) => agentKey(state.pipeline, node))
      for (const node of state.pipeline.nodes) actions.updateAgent(node.id, { name: agentKey(state.pipeline, node) })
      setAgents([...new Set([...agents(), ...keys])])

      // The server caches a project's config, so a merge is invisible to a
      // server that is already running. Check rather than claim success.
      const live = new Set((await api.agents().catch(() => [])).map((agent) => agent.id))
      const invisible = keys.filter((key) => !live.has(key))
      if (invisible.length) {
        actions.notice(
          "error",
          `wrote ${result.path}, but the server has not loaded ${invisible.join(", ")} — restart \`opencode serve\`, then reload this page`,
        )
        return
      }
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
        { pipe: pipe(), permissions: policy(), maxParallel: parallel(), nodeTimeout: nodeTimeout() },
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

  /**
   * Enter in the task field starts the run, the way the prompt box in opencode
   * does. Guarded on `state.running` so a second press cannot open a parallel
   * run behind the disabled button, and on `isComposing` so an IME candidate
   * being accepted is not read as a submit.
   */
  function onTaskKey(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.isComposing || state.running) return
    event.preventDefault()
    void run()
  }

  return (
    <div class="app">
      <header class="titlebar">
        <span class="titlebar-brand">
          <IconFlow />
          OpenFlow
        </span>
        <span class="titlebar-sep" aria-hidden="true" />
        <input
          class="titlebar-name"
          value={state.pipeline.name}
          onInput={(event) => actions.rename(event.currentTarget.value)}
          title="pipeline name"
          aria-label="pipeline name"
        />
        <div class="titlebar-actions">
          <button
            class="icon-btn"
            type="button"
            title="new pipeline"
            aria-label="new pipeline"
            onClick={() => actions.reset()}
          >
            <IconPlus />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="save the pipeline and its generated agent defs"
            aria-label="save pipeline"
            onClick={save}
          >
            <IconSave />
          </button>
          <Select
            label="Open"
            leading={<IconFolder />}
            variant="ghost"
            align="end"
            width={320}
            title="open a saved pipeline"
            value=""
            options={pipelines().map((entry) => ({
              value: entry.name,
              label: entry.name,
              hint: `${entry.nodes} nodes`,
            }))}
            onChange={(name) => void load(name)}
            empty="No saved pipelines yet."
          />
          <button
            class="icon-btn"
            type="button"
            title="merge generated agent defs into the project opencode.json"
            aria-label="merge agents"
            onClick={mergeAgents}
          >
            <IconLayers />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="store provider api keys and see which models are usable"
            aria-label="api keys"
            onClick={() => openProviders()}
          >
            <IconKey />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="author skills your cards can use"
            aria-label="skills"
            onClick={() => setShowSkills(true)}
          >
            <IconSliders />
          </button>
        </div>
      </header>

      <div class="runbar">
        <input
          class="runbar-task"
          placeholder="task for this run — Enter to start"
          title="task for this run — Enter to start"
          aria-label="task for this run — Enter to start"
          value={state.input}
          onInput={(event) => actions.setInput(event.currentTarget.value)}
          onKeyDown={onTaskKey}
        />
        <div class="runbar-settings">
          <Select
            variant="ghost"
            prefix="pipe: "
            width={320}
            title="how much upstream output each node receives"
            value={pipe()}
            options={PIPE_OPTIONS}
            onChange={(value) => setPipe(value as PipeMode)}
          />
          <Select
            variant="ghost"
            prefix="permissions: "
            width={320}
            title="what happens when an agent asks for permission mid-run"
            value={policy()}
            options={POLICY_OPTIONS}
            onChange={(value) => setPolicy(value as PermissionPolicy)}
          />
          <Select
            variant="ghost"
            prefix="parallel: "
            title="how many nodes may run at once — every concurrent node is another live session against the provider"
            value={String(parallel())}
            options={PARALLEL_OPTIONS}
            onChange={(value) => setParallel(Number(value))}
          />
          <Select
            variant="ghost"
            prefix="timeout: "
            title="how long one node may run before the engine gives up on it"
            value={String(nodeTimeout())}
            options={TIMEOUT_OPTIONS}
            onChange={(value) => setNodeTimeout(Number(value))}
          />
        </div>
        <div class="runbar-actions">
          <button class="btn btn-primary" type="button" disabled={state.running} onClick={run}>
            <IconPlay />
            Run
          </button>
          <button class="btn btn-danger" type="button" disabled={!state.running} onClick={stop}>
            <IconStop />
            Stop
          </button>
        </div>
      </div>

      <Show when={state.notice}>
        {(notice) => (
          <div class="notice" data-kind={notice().kind} onClick={actions.clearNotice}>
            <span class="notice-icon">
              <Show when={notice().kind === "error"} fallback={<IconInfo />}>
                <IconAlert />
              </Show>
            </span>
            <span class="notice-text">{notice().text}</span>
            <button
              class="icon-btn notice-close"
              type="button"
              title="dismiss"
              aria-label="dismiss"
              onClick={actions.clearNotice}
            >
              <IconClose />
            </button>
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
                  <button class="btn" type="button" onClick={() => actions.answerPermission(request.requestID, "once")}>
                    allow once
                  </button>
                  <button
                    class="btn"
                    type="button"
                    onClick={() => actions.answerPermission(request.requestID, "always")}
                    title="persists to the project's saved permissions, beyond this run"
                  >
                    always
                  </button>
                  <button
                    class="btn btn-danger"
                    type="button"
                    onClick={() => actions.answerPermission(request.requestID, "reject")}
                  >
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
        <Inspector agents={agents()} providers={providers()} onManageKeys={openProviders} />
      </main>

      <Show when={showProviders()}>
        <ProvidersPanel
          rows={providers()}
          initialQuery={providerQuery()}
          onClose={() => setShowProviders(false)}
          onChanged={refreshProviders}
          onNotice={actions.notice}
        />
      </Show>

      <Show when={showSkills()}>
        <SkillsPanel onClose={() => setShowSkills(false)} onNotice={actions.notice} />
      </Show>

      <Show when={showProjectPicker()}>
        <ProjectPicker current={project()} onClose={() => setShowProjectPicker(false)} onSwitched={switchProject} />
      </Show>

      <footer class="statusbar">
        <div class="statusbar-left">
          <span class="statusbar-dot" data-state={status().startsWith("offline") ? "bad" : "ok"} aria-hidden="true" />
          <span class="status">{status()}</span>
          <Show when={state.run} fallback={<span class="hint">no run yet</span>}>
            {(log) => (
              <>
                <span class="mono">{log().id}</span>
                <span class="badge" data-status={log().status}>
                  {log().status}
                </span>
                <span class="run-nodes">
                  <For each={log().nodes}>
                    {(node) => (
                      <span
                        class="run-node"
                        data-status={node.status}
                        title="show this node in the inspector"
                        role="button"
                        tabindex={0}
                        onClick={() => actions.select(node.id)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return
                          event.preventDefault()
                          actions.select(node.id)
                        }}
                      >
                        {node.role}
                        <span class="badge" data-status={node.status}>
                          {node.status}
                        </span>
                      </span>
                    )}
                  </For>
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="statusbar-right">
          <Select
            label="Runs"
            leading={<IconHistory />}
            variant="ghost"
            placement="top"
            align="end"
            width={380}
            title="reopen a recorded run"
            value=""
            options={runs().map((entry) => ({
              value: entry.id,
              label: entry.id,
              hint: `${entry.pipeline} · ${entry.status}`,
            }))}
            onChange={(id) => void openRun(id)}
            empty="No runs recorded yet."
          />
          <button
            type="button"
            class="icon-btn statusbar-project"
            title={`${project()} — click to switch project`}
            aria-label="switch project"
            onClick={() => setShowProjectPicker(true)}
          >
            <IconFolder />
            <span class="mono dim">{project()}</span>
          </button>
        </div>
      </footer>
    </div>
  )
}

function clone(log: RunLog): RunLog {
  return { ...log, nodes: log.nodes.map((node) => ({ ...node })) }
}
