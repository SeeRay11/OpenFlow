import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Canvas } from "./canvas/canvas"
import {
  depthOf,
  dispatchesOf,
  gauntletOf,
  MAX_DEPTH,
  MAX_DISPATCHES,
  MAX_ROUNDS,
  modeOf,
  roundsOf,
  type FlowMode,
  type Pipeline,
  type RunLog,
} from "./graph/types"
import { MCP_REACHES_SESSIONS } from "./graph/dispatch"
import { layer, preflight, type Preflight } from "./graph/validate"
import { isPipeline } from "./graph/pipeline-io"
import * as api from "./server/client"
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_NODE_TIMEOUT,
  start,
  type PermissionPolicy,
  type PipeMode,
  type Run,
} from "./server/engine"
import {
  availableModels,
  freeModels,
  providerRows,
  suggestedFreeDefault,
  unlockedRows,
  type ProviderRow,
} from "./server/providers"
import { defaultModel, setAvailableModels, setDefaultModel } from "./graph/default-model"
import { hydrateCustomRoles, onRolesSyncError } from "./graph/roles"
import {
  agentBlock,
  agentKey,
  store,
  type McpServer,
  type PipelineEntry,
  type RunEntry,
  type ServeStatus,
} from "./server/store"
import { actions, state } from "./state"
import {
  IconAlert,
  IconClose,
  IconCoin,
  IconExport,
  IconFlow,
  IconFolder,
  IconHistory,
  IconImport,
  IconInfo,
  IconKey,
  IconLayers,
  IconPlay,
  IconPlug,
  IconPlus,
  IconRestart,
  IconSave,
  IconSliders,
  IconStop,
} from "./ui/icons"
import { ActivityDrawer } from "./ui/activity-drawer"
import { Attachments, filesFrom, readFiles } from "./ui/attachments"
import { Inspector } from "./ui/inspector"
import { McpPanel } from "./ui/mcp-panel"
import { QuestionDialog } from "./ui/question-dialog"
import { Palette } from "./ui/palette"
import { Walkthrough } from "./ui/walkthrough"
import { ProjectPicker } from "./ui/project-picker"
import { ProvidersPanel } from "./ui/providers-panel"
import { SessionsPanel } from "./ui/sessions-panel"
import { SkillsPanel } from "./ui/skills-panel"
import { SpendPanel } from "./ui/spend-panel"
import { EngineDialog } from "./ui/engine-dialog"
import { GauntletDialog } from "./ui/gauntlet-dialog"
import { costLabel } from "./server/usage"
import { Select, type SelectOption } from "./ui/select"

// The four run settings are fixed lists, so they are built once here rather
// than rebuilt on every render. Each label is only the value — the trigger
// prints the name through the `prefix` prop, so a row reads "auto" while the
// bar reads "permissions: auto".
const MODE_OPTIONS: SelectOption[] = [
  { value: "pipeline", label: "pipeline", hint: "cards run in dependency order" },
  { value: "swarm", label: "swarm", hint: "peers debate, a synthesizer decides" },
  { value: "orchestration", label: "orchestration", hint: "an orchestrator assigns subagents" },
]
const ROUND_OPTIONS: SelectOption[] = Array.from({ length: MAX_ROUNDS }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
  hint: index === 0 ? "no debate — one answer each" : undefined,
}))
const DEPTH_OPTIONS: SelectOption[] = Array.from({ length: MAX_DEPTH }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
  hint: index === 0 ? "one layer of subagents" : `subagents ${index + 1} deep`,
}))
const DISPATCH_OPTIONS: SelectOption[] = Array.from({ length: MAX_DISPATCHES }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
  hint: index === 0 ? "hand out once, then answer" : undefined,
}))
const PIPE_OPTIONS: SelectOption[] = [
  { value: "ancestors", label: "ancestors", hint: "every upstream node" },
  { value: "direct", label: "direct", hint: "immediate parents only" },
]
const GAUNTLET_OPTIONS: SelectOption[] = [
  { value: "off", label: "off", hint: "dispatch, then answer" },
  { value: "on", label: "on", hint: "loop against a bar until it holds" },
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

/** How often the statusbar re-checks the engine while nothing else is talking to it. */
const HEALTH_INTERVAL = 15_000

/** How often a running gauntlet's elapsed-minutes readout advances. */
const CLOCK_INTERVAL = 10_000

/**
 * Whether a failure is the engine's rather than the request's.
 *
 * Every `/api/*` call dies the same way when `opencode serve` is down, and the
 * symptom surfaces as whatever the caller was doing — a provider read, a save,
 * a run. Matching the message is what turns any of those back into one honest
 * "the engine is gone" state instead of a confident wrong diagnosis.
 */
function namesEngine(text: string) {
  return (
    text.includes("opencode serve") ||
    text.includes("Failed to fetch") ||
    text.includes("NetworkError") ||
    text.includes("HTTP 502") ||
    text.includes("flow store unavailable")
  )
}

/**
 * Whether the sessions column was left open.
 *
 * Closed by default: the canvas is the app, and a first run should get the full
 * width rather than 240px of empty history. Storage is best-effort in both
 * directions — the signal is the source of truth, so `bun test` (which has no
 * `localStorage`) and a private window both behave, they just do not remember.
 */
const SESSIONS_KEY = "openflow.sessionsOpen.v1"

function readShowSessions() {
  try {
    return localStorage.getItem(SESSIONS_KEY) === "1"
  } catch {
    return false
  }
}

function writeShowSessions(open: boolean) {
  try {
    localStorage.setItem(SESSIONS_KEY, open ? "1" : "0")
  } catch {
    // A browser that refuses storage still gets a working panel for this tab.
  }
}

export function App() {
  const [status, setStatus] = createSignal("connecting…")
  const [agents, setAgents] = createSignal<string[]>([])
  const [providers, setProviders] = createSignal<ProviderRow[]>([])
  const [showProviders, setShowProviders] = createSignal(false)
  const [showSkills, setShowSkills] = createSignal(false)
  const [showMcp, setShowMcp] = createSignal(false)
  const [showSpend, setShowSpend] = createSignal(false)
  const [gauntletOpen, setGauntletOpen] = createSignal(false)
  const [tick, setTick] = createSignal(Date.now())
  const [engine, setEngine] = createSignal<ServeStatus>()
  const [restarting, setRestarting] = createSignal(false)
  /** Set when the engine needs restarting — drives the restart/command dialog. */
  const [engineHelp, setEngineHelp] = createSignal<ServeStatus>()
  const [engineWhy, setEngineWhy] = createSignal<string>()
  // `undefined` means the server list has not been read (yet, or at all), which
  // is not the same as a project with no servers: the generated `<server>_*`
  // permission rules are derived from this list, so an empty stand-in would
  // silently drop every deny rule from the agents written to opencode.json.
  // Starts unknown so a run fired before the first refresh lands refuses too.
  const [mcpServers, setMcpServers] = createSignal<McpServer[] | undefined>(undefined)
  const [showProjectPicker, setShowProjectPicker] = createSignal(false)
  const [pickingProject, setPickingProject] = createSignal(false)
  const [providerQuery, setProviderQuery] = createSignal("")
  const [pipelines, setPipelines] = createSignal<PipelineEntry[]>([])
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [project, setProject] = createSignal("")
  const [showSessions, setShowSessions] = createSignal(readShowSessions())
  const [pipe, setPipe] = createSignal<PipeMode>("ancestors")
  const [policy, setPolicy] = createSignal<PermissionPolicy>("auto")
  const [parallel, setParallel] = createSignal(DEFAULT_MAX_PARALLEL)
  const [nodeTimeout, setNodeTimeout] = createSignal(DEFAULT_NODE_TIMEOUT)
  const [issues, setIssues] = createSignal<Preflight>()
  /** Whether the global config starts OpenFlow's dispatch MCP server. */
  const [dispatchTool, setDispatchTool] = createSignal<Awaited<ReturnType<typeof store.dispatchToolStatus>>>()
  const [installing, setInstalling] = createSignal(false)
  let current: Run | undefined

  /**
   * The `providerID/modelID` set a node could actually run right now.
   *
   * Not "the models of a connected provider": zen's free tier needs no key, so
   * a fresh install with no credential at all still has runnable models, and
   * gating on `unlockedRows` here would block a first-timer's run outright.
   */
  const unlockedModels = () => new Set(availableModels(providers()).map((model) => model.value))

  /**
   * Every error this file reports goes through here rather than through
   * `actions.notice` directly, so a failure that names the engine re-probes it.
   * Without that the statusbar keeps asserting "connected" against a dead
   * server for as long as the tab stays open.
   */
  function notice(kind: "info" | "error", text: string) {
    actions.notice(kind, text)
    if (kind === "error" && namesEngine(text)) void probe()
  }

  /**
   * One health round trip. The only thing that may put the statusbar back to
   * "connected", and the only thing that clears `engineReachable`.
   */
  async function probe() {
    if (restarting()) return false
    try {
      await api.health()
      actions.setEngineReachable(true)
      setStatus("connected")
      return true
    } catch (error) {
      actions.setEngineReachable(false)
      setStatus(`offline — ${api.describe(error)}`)
      return false
    }
  }

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
      // Before the palette settles, so a project's own saved roles are what it
      // renders rather than the built-ins alone. Roles follow the project, so
      // this re-runs on a switch too.
      await hydrateCustomRoles()
      await api.health()
      actions.setEngineReachable(true)
      setStatus("connected")
      const agentList = await api.agents()
      setAgents(agentList.filter((agent) => !agent.hidden).map((agent) => agent.id))
      await refreshProviders()
    } catch (error) {
      // The dev proxy already names the server when it is the thing that is
      // down, so the prefix is only added when the message lacks it.
      const detail = api.describe(error)
      actions.setEngineReachable(false)
      setStatus(`offline — ${detail}`)
      actions.notice("error", detail.includes("opencode serve") ? detail : `cannot reach opencode serve: ${detail}`)
    }
    setEngine(await store.serverStatus().catch(() => undefined))
    const entries = await refresh()
    await reopen(entries)
  }

  /**
   * Restarts `opencode serve` and re-reads everything that only loads at its
   * boot: agents, models, and the MCP status the panels show. This is the one
   * action that makes a merged agent, a new skill or an MCP entry actually
   * live, which until now meant leaving the app for a terminal.
   *
   * A host that did not spawn the engine cannot restart it, and says so with
   * the command rather than failing silently.
   */
  /** Opens the restart dialog with whatever this host knows about the engine. */
  /**
   * Writes the MCP server into the global config, then offers the restart it
   * needs — opencode reads config once at boot, so until the engine restarts
   * the tool exists in the file and not in any card.
   */
  async function installDispatchTool() {
    setInstalling(true)
    try {
      const result = await store.installDispatchTool()
      setDispatchTool(await store.dispatchToolStatus().catch(() => undefined))
      notice(
        "info",
        `dispatch tool written to ${result.path}${result.backup ? ` (backup ${result.backup})` : ""}`,
      )
      if (result.restart)
        void showEngineHelp("The dispatch tool is in your config now, and the engine has to restart before cards can call it.")
    } catch (error) {
      notice("error", api.describe(error))
    } finally {
      setInstalling(false)
    }
  }

  async function showEngineHelp(why?: string) {
    const status = (await store.serverStatus().catch(() => undefined)) ?? engine()
    if (!status) return actions.notice("error", "cannot tell how `opencode serve` was started on this host")
    setEngine(status)
    setEngineWhy(why)
    setEngineHelp(status)
  }

  async function restartEngine() {
    if (restarting()) return
    setRestarting(true)
    setStatus("restarting engine…")
    actions.notice("info", "restarting opencode serve…")
    try {
      const next = await store.restartServer()
      setEngine(next)
      setEngineHelp(undefined)
      setEngineWhy(undefined)
      // Every cached handle points at the old process; drop them and reconnect.
      api.disconnect()
      await bootstrap()
      actions.notice("info", "engine restarted — agents, skills and mcp servers reloaded")
    } catch (error) {
      const info = (error as { info?: ServeStatus }).info
      if (info && !info.managed) {
        setEngine(info)
        setEngineWhy(undefined)
        setEngineHelp(info)
        actions.clearNotice()
      } else {
        actions.notice("error", api.describe(error))
        setEngine(await store.serverStatus().catch(() => undefined))
        actions.setEngineReachable(false)
        setStatus(`offline — ${api.describe(error)}`)
      }
    } finally {
      setRestarting(false)
    }
  }

  /**
   * Reopens the pipeline that was last open in this project.
   *
   * Only if the store still lists it: a pipeline deleted or renamed outside
   * OpenFlow would otherwise greet the user with a load error on every launch.
   * Loading is silent — this is restoring where they were, not an action they
   * just took — and it is safe at boot because the canvas is empty until it
   * runs. A failure leaves the blank canvas rather than blocking startup.
   */
  async function reopen(entries: PipelineEntry[]) {
    try {
      // `connect()` is cached, so this rereads nothing — it just hands back the
      // context already fetched, including the pipeline to reopen.
      const { context } = await api.connect()
      const last = context.pipeline
      if (!last || !entries.some((entry) => entry.name === last)) return
      actions.load((await store.pipeline(last)) as Pipeline)
    } catch {
      // The listing said it was there; if it is not, a blank canvas is fine.
    }
  }

  // A role that only reached this browser is one cleared cache from gone, so a
  // failed write to the project's roles.json has to be said out loud.
  onRolesSyncError((reason) => actions.notice("error", `custom roles were not saved to this project — ${reason}`))
  onMount(bootstrap)

  onMount(() => {
    // A heartbeat, not a poll of anything expensive: one `/api/health` while
    // the tab is visible and no run is already talking to the server. Without
    // it the statusbar only ever learns the truth at boot.
    const timer = setInterval(() => {
      if (document.hidden || state.running || restarting()) return
      void probe()
    }, HEALTH_INTERVAL)
    // The clock behind the gauntlet readout. It only has to be right to the
    // minute, and it stops mattering the moment a run finishes.
    const clock = setInterval(() => state.running && setTick(Date.now()), CLOCK_INTERVAL)
    // Coming back to a tab that sat hidden for an hour should not wait out the
    // interval before admitting the engine died meanwhile.
    const onVisibility = () => {
      if (!document.hidden) void probe()
    }
    // The one destructive path the app cannot guard with a dialog of its own.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.dirty || !state.pipeline.nodes.length) return
      // Browsers show their own wording; `preventDefault` is what asks at all.
      event.preventDefault()
      event.returnValue = ""
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("beforeunload", onBeforeUnload)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(clock)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("beforeunload", onBeforeUnload)
    })
  })

  /**
   * Asked by every path that replaces the graph — new, open, import. `dirty` is
   * what keeps it quiet: a pipeline just loaded or just saved has nothing to
   * lose, so it is replaced without a prompt.
   */
  function confirmReplace() {
    if (!state.dirty || !state.pipeline.nodes.length) return true
    return window.confirm("Replace the current pipeline?")
  }

  /**
   * Asks the host for its own folder dialog first, and only falls back to the
   * in-app browser when there is none (a remote or headless host, or a
   * platform with no picker). The native dialog is what a user means by
   * "change folder"; the browser exists because a page cannot produce a real
   * OS path on its own.
   */
  async function pickProject() {
    if (pickingProject()) return
    setPickingProject(true)
    try {
      const { path } = await store.pickFolder(project() || undefined)
      if (!path) return
      const paths = await store.setProject(path)
      api.disconnect()
      await switchProject(paths.project)
    } catch (error) {
      setShowProjectPicker(true)
    } finally {
      setPickingProject(false)
    }
  }

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
    const integrationList = await readCatalog()
    // A provider with a key always serves models, so an empty model list beside
    // a connected provider is the same cold-catalog race — and it reads worse,
    // since every connected provider then shows as "no runnable models".
    const modelList = await readModels(integrationList.some((item) => (item.connections ?? []).length > 0))
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
    // Keep the default-model gate current: a node only inherits the default
    // when it is still among the models a connected provider can actually run.
    setAvailableModels(unlockedModels())
  }

  /** `query` carries a provider name the model search could not satisfy. */
  function openProviders(query?: string) {
    setProviderQuery(query ?? "")
    setShowProviders(true)
    // Nothing to pick means the boot read came back empty. Try again rather
    // than show a first-time user an empty list with no way out of it.
    if (!providers().length) void refreshProviders()
  }

  async function refresh() {
    // Only worth a request when something could show it — see the banner below.
    if (MCP_REACHES_SESSIONS) setDispatchTool(await store.dispatchToolStatus().catch(() => undefined))
    const entries = await store.pipelines().catch(() => [])
    setPipelines(entries)
    setRuns(await store.runs().catch(() => []))
    setMcpServers(await store.mcpServers().catch(() => undefined))
    return entries
  }

  const mcpNames = () => (mcpServers() ?? []).map((server) => server.name)

  /** Reads picked or pasted files into data URLs and attaches them to the run. */
  async function attachToRun(files: File[]) {
    const { attachments, errors } = await readFiles(files)
    actions.addAttachments(attachments)
    for (const failure of errors) actions.notice("error", `${failure.name}: ${failure.reason}`)
  }

  /**
   * Saves the graph, and stops when the name already belongs to a different
   * pipeline.
   *
   * The store answers that case with a 409 rather than destroying the file
   * ([lib/store.ts]) — every pipeline is born "untitled", so the second one
   * saved used to silently overwrite the first. The route is called directly
   * because only the status distinguishes a conflict from an ordinary failure,
   * and the shared client throws the body message with the status dropped.
   */
  async function save(overwrite = false) {
    const check = layer(state.pipeline)
    if (!check.ok) return notice("error", check.error)
    try {
      const response = await fetch(
        `/flow/api/pipelines/${encodeURIComponent(state.pipeline.name)}${overwrite ? "?overwrite=1" : ""}`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state.pipeline) },
      )
      const body = await response.json().catch(() => undefined)
      if (response.status === 409) {
        const conflict = body?.error ?? `a different pipeline is already saved as "${state.pipeline.name}"`
        // Never overwrite on the user's behalf: replacing somebody's saved work
        // is the whole thing this guard exists to prevent.
        if (window.confirm(`${conflict}\n\nOK replaces the saved pipeline. Cancel keeps it so you can rename this one.`))
          return save(true)
        return notice("error", `${conflict} — rename this pipeline in the title bar, then save again`)
      }
      if (!response.ok) return notice("error", body?.error ?? `could not save the pipeline (HTTP ${response.status})`)
      const generated = await store.saveAgents(state.pipeline.name, agentBlock(state.pipeline, mcpNames()))
      actions.markSaved()
      actions.notice("info", `saved ${body.path} · agents ${generated.path}`)
      await refresh()
    } catch (error) {
      notice("error", api.describe(error))
    }
  }

  let importInput: HTMLInputElement | undefined

  /** Saves the current graph to a `.json` file — the same schema the server stores. */
  function exportPipeline() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state.pipeline, null, 2)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${state.pipeline.name || "pipeline"}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Loads a `.json` file exported here or hand-edited. A bad file becomes a
   * notice, never a throw; a non-empty graph is guarded like a template load.
   */
  async function importPipeline(file: File) {
    const parsed = parseJson(await file.text())
    if (!isPipeline(parsed)) return actions.notice("error", "Not a valid OpenFlow pipeline")
    if (!confirmReplace()) return
    actions.load(parsed)
    // Loading clears `dirty`, but an imported graph is not on disk here yet —
    // closing the tab would still lose it.
    actions.markDirty()
    actions.notice("info", `imported ${parsed.name}`)
  }

  async function load(name: string) {
    if (!name) return
    if (!confirmReplace()) return
    try {
      const pipeline = (await store.pipeline(name)) as Pipeline
      actions.load(pipeline)
      actions.notice("info", `loaded ${name}`)
    } catch (error) {
      notice("error", api.describe(error))
    }
  }

  /**
   * Folds the generated agent defs into the project's opencode.json (after a
   * .bak) and points every node at its own agent, so the per-node tool
   * allowlist actually applies at runtime — sessions can only pick tools
   * through a named agent. The server skips the write (and the .bak) when the
   * block is already identical, so this is cheap to call before every run.
   *
   * Refuses to write when the MCP server list is unknown: the merge replaces
   * each agent entry wholesale, so writing a block built from an empty server
   * list would strip the `<server>_*` deny rules already on disk and quietly
   * widen what every node can reach. Returns the agent keys alongside the
   * server's reply.
   */
  async function syncAgents() {
    if (!mcpServers())
      throw new Error("cannot read the project's mcp servers — refusing to rewrite agents without them")
    const result = await store.saveAgents(state.pipeline.name, agentBlock(state.pipeline, mcpNames()), true)
    const keys = state.pipeline.nodes.map((node) => agentKey(state.pipeline, node))
    for (const node of state.pipeline.nodes) actions.updateAgent(node.id, { name: agentKey(state.pipeline, node) })
    setAgents([...new Set([...agents(), ...keys])])
    return { result, keys }
  }

  async function mergeAgents() {
    try {
      const { result, keys } = await syncAgents()
      if (result.error) return actions.notice("error", result.error)

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
      actions.notice(
        "info",
        result.unchanged
          ? `agents already up to date in ${result.path}`
          : `merged into ${result.path}${result.backup ? ` (backup ${result.backup})` : ""}`,
      )
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  /**
   * Outputs from the last run that are worth keeping.
   *
   * A node that finished is a node already paid for, so re-running the tail
   * after a failure should not buy its answer twice. Anything not `done` —
   * failed, skipped, stopped, still queued — is absent and therefore re-runs.
   */
  function reusableOutputs() {
    return Object.fromEntries(
      (state.run?.nodes ?? [])
        .filter((node) => node.status === "done" && node.output !== undefined)
        .map((node) => [node.id, node.output as string]),
    )
  }

  /**
   * How far a gauntlet is through the two bounds that will stop it.
   *
   * Undefined for every other canvas, which has a node count to read progress
   * from instead. The clock is read off `tick` so it advances on its own — a
   * gauntlet can sit on one long card for many minutes, and a readout that only
   * moved when a node settled would look stopped.
   */
  function gauntletProgress(log: RunLog) {
    const settings = gauntletOf(state.pipeline)
    if (!settings) return undefined
    // `tick` only advances every 10s, so a run started since the last one reads
    // as negative minutes until it catches up.
    const elapsed = Math.max(0, Math.round(((log.finished ?? tick()) - log.started) / 60_000))
    return {
      spend: `$${(log.usage?.cost ?? 0).toFixed(2)} / $${settings.maxSpend}`,
      time: `${elapsed} / ${settings.maxMinutes}m`,
    }
  }

  /** A finished run with something left undone is the only time resuming means anything. */
  function canRerunFailed() {
    const nodes = state.run?.nodes ?? []
    return !state.running && nodes.length > 0 && nodes.some((node) => node.status !== "done")
  }

  async function run(resume?: Record<string, string>) {
    // One place tells the user everything that is wrong before a session is
    // ever created. Blocking problems abort; warnings are shown but let the run
    // proceed. The list survives on screen so each problem can select its node.
    // The engine is re-probed first: an unreachable one empties `unlockedModels`,
    // and preflight has to know that so it blames the engine rather than every
    // node's model.
    await probe()
    const pre = preflight(state.pipeline, {
      unlockedModels: unlockedModels(),
      engineReachable: state.engineReachable,
    })
    setIssues(pre.blocking.length || pre.warnings.length ? pre : undefined)
    if (pre.blocking.length) {
      // A dead engine has exactly one fix and it is not on this screen, so the
      // same dialog the stale-agent path opens is offered here too.
      if (pre.blocking.some((problem) => problem.kind === "engine-unreachable"))
        void showEngineHelp("`opencode serve` is not answering, so no card can start a session.")
      return
    }
    actions.clearNotice()

    // Fold any pending agent edits into opencode.json before the run so a node
    // never runs against a stale def. The server no-ops when nothing changed,
    // so this stays silent unless it actually wrote. It cannot make a running
    // server reload its cache, though — the engine's own unknown-agent check
    // still surfaces the "restart the server" case below.
    //
    // A failed sync stops the run: the nodes would otherwise go off against
    // whatever defs happen to be on disk, which is exactly the stale-agent case
    // this sync exists to prevent.
    try {
      const { result } = await syncAgents()
      if (result.error) return notice("error", result.error)
      if (result.merged)
        actions.notice("info", `synced agents into ${result.path}${result.backup ? ` (backup ${result.backup})` : ""}`)
    } catch (error) {
      return notice("error", api.describe(error))
    }

    actions.resetRuntime(Object.fromEntries(state.pipeline.nodes.map((node) => [node.id, "queued" as const])))
    actions.setRunning(true)
    try {
      current = start(
        state.pipeline,
        // A resumed run must re-send the task the reused outputs were produced
        // from: downstream prompts are built from both, so a task edited in the
        // meantime would pair new instructions with old answers.
        resume ? (state.run?.input ?? state.input) : state.input,
        {
          onNode: (id, patch) => actions.patchRuntime(id, patch),
          onNodeEvent: (id, event) => actions.pushEvent(id, event),
          onRun: (log) => actions.setRun(clone(log)),
          onNotice: notice,
          onPermission: (request) =>
            actions.askPermission({
              requestID: request.requestID,
              nodeID: request.nodeID,
              role: request.role,
              action: request.action,
              resources: request.resources,
            }),
          onQuestion: (request) =>
            actions.askQuestion({
              requestID: request.requestID,
              nodeID: request.nodeID,
              role: request.role,
              questions: request.questions,
            }),
          // The engine settles a question on its own once it times out, so the
          // dialog has to come down even though nobody touched it.
          onQuestionClosed: (requestID) => actions.answerQuestion(requestID, undefined),
          // A run stopped by stale config has exactly one fix, so hand it over
          // rather than leaving the user to find the command themselves.
          onEngineStale: () => void showEngineHelp("The engine is running older config than what is on disk — an agent this pipeline needs was merged after it booted."),
        },
        {
          pipe: pipe(),
          permissions: policy(),
          maxParallel: parallel(),
          nodeTimeout: nodeTimeout(),
          attachments: [...state.attachments],
          resume,
        },
      )
      const log = await current.done
      const failure = log.nodes.find((node) => node.status === "error")
      notice(
        log.status === "error" ? "error" : "info",
        failure ? `run ${log.id} error — ${failure.role}: ${failure.error}` : `run ${log.id} ${log.status}`,
      )
      // The engine died mid-run. The per-node text already says so, but the fix
      // lives in the restart dialog, so open it the way the stale-agent case does.
      //
      // Confirm it is actually gone before saying so. `namesEngine` matches any
      // message mentioning the server, and the stale-agent failure names it too
      // while the engine is answering perfectly well — without this probe that
      // case opens the dialog claiming the engine "stopped answering", which is
      // the wrong fix on screen. `onEngineStale` already opens it with the right
      // words, so staying quiet here loses nothing.
      if (failure?.error && namesEngine(failure.error) && !(await probe()))
        void showEngineHelp("The run stopped because `opencode serve` stopped answering.")
    } catch (error) {
      notice("error", api.describe(error))
    } finally {
      actions.setRunning(false)
      actions.rejectPermissions()
      actions.rejectQuestions()
      current = undefined
      await refresh()
    }
  }

  async function stop() {
    actions.rejectPermissions()
    actions.rejectQuestions()
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
          usage: node.usage,
          started: node.started,
          finished: node.finished,
          events: node.events,
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
            classList={{ active: showSessions() }}
            type="button"
            title="show the sessions this project has on the server"
            aria-label="toggle sessions panel"
            aria-pressed={showSessions()}
            onClick={() => {
              const next = !showSessions()
              setShowSessions(next)
              writeShowSessions(next)
            }}
          >
            <IconHistory />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="new pipeline"
            aria-label="new pipeline"
            onClick={() => confirmReplace() && actions.reset()}
          >
            <IconPlus />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="save the pipeline and its generated agent defs"
            aria-label="save pipeline"
            onClick={() => void save()}
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
            title="export this pipeline to a .json file"
            aria-label="export pipeline"
            onClick={exportPipeline}
          >
            <IconExport />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="import a pipeline from a .json file"
            aria-label="import pipeline"
            onClick={() => importInput?.click()}
          >
            <IconImport />
          </button>
          <input
            ref={importInput}
            style={{ display: "none" }}
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              // Reset so re-importing the same file fires change again.
              event.currentTarget.value = ""
              if (file) void importPipeline(file)
            }}
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
          <button
            class="icon-btn"
            type="button"
            disabled={restarting()}
            title={
              engine()?.managed
                ? "restart opencode serve — reloads agents, skills and mcp servers"
                : "how to restart opencode serve (this host did not start it)"
            }
            aria-label="restart engine"
            onClick={restartEngine}
          >
            <IconRestart />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="add and configure mcp servers for this project"
            aria-label="mcp servers"
            onClick={() => setShowMcp(true)}
          >
            <IconPlug />
          </button>
        </div>
      </header>

      <div class="runbar">
        <input
          class="runbar-task"
          placeholder="task for this run — Enter to start, paste an image to attach it"
          title="task for this run — Enter to start, paste an image to attach it"
          aria-label="task for this run — Enter to start"
          value={state.input}
          onInput={(event) => actions.setInput(event.currentTarget.value)}
          onKeyDown={onTaskKey}
          // Pasting a screenshot is how most people attach one, so the task
          // field takes files as well as text.
          onPaste={(event) => {
            const files = filesFrom(event)
            if (!files.length) return
            event.preventDefault()
            void attachToRun(files)
          }}
        />
        <Attachments
          files={state.attachments}
          onAdd={(files) => void attachToRun(files)}
          onRemove={actions.removeAttachment}
        />
        <div class="runbar-settings">
          <Select
            variant="ghost"
            prefix="mode: "
            width={320}
            title="how this canvas executes — it belongs to the graph, not to the run"
            value={modeOf(state.pipeline)}
            options={MODE_OPTIONS}
            onChange={(value) => actions.setMode(value as FlowMode)}
          />
          {/* Each mode reads its own budget and none of the others. `pipe`
              means nothing to a swarm, whose peers all see each other by
              definition; rounds mean nothing to a pipeline. Showing all of them
              would offer settings that silently do not apply. */}
          <Show when={modeOf(state.pipeline) === "pipeline"}>
            <Select
              variant="ghost"
              prefix="pipe: "
              width={320}
              title="how much upstream output each node receives"
              value={pipe()}
              options={PIPE_OPTIONS}
              onChange={(value) => setPipe(value as PipeMode)}
            />
          </Show>
          <Show when={modeOf(state.pipeline) === "swarm"}>
            <Select
              variant="ghost"
              prefix="rounds: "
              title="how many times every agent reads its peers and revises — a swarm costs agents x rounds + 1 sessions"
              value={String(roundsOf(state.pipeline))}
              options={ROUND_OPTIONS}
              onChange={(value) => actions.setRounds(Number(value))}
            />
          </Show>
          <Show when={modeOf(state.pipeline) === "orchestration"}>
            <Select
              variant="ghost"
              prefix="depth: "
              width={280}
              title="how many levels of subagents may sit below the orchestrator — every level multiplies the session count"
              value={String(depthOf(state.pipeline))}
              options={DEPTH_OPTIONS}
              onChange={(value) => actions.setDepth(Number(value))}
            />
            {/* A gauntlet replaces the dispatch budget with money and time, so
                offering both at once would show a countdown that no longer
                counts. */}
            <Show
              when={gauntletOf(state.pipeline)}
              fallback={
                <Select
                  variant="ghost"
                  prefix="dispatches: "
                  width={280}
                  title="how many times one orchestrator may hand work out before it has to answer"
                  value={String(dispatchesOf(state.pipeline))}
                  options={DISPATCH_OPTIONS}
                  onChange={(value) => actions.setDispatches(Number(value))}
                />
              }
            >
              {(settings) => (
                <button
                  class="btn btn-ghost"
                  type="button"
                  title="the bar this run is judged against, and the money, time and stall bounds that stop it"
                  onClick={() => setGauntletOpen(true)}
                >
                  <IconSliders />
                  {settings().bar ? `bar · $${settings().maxSpend} · ${settings().maxMinutes}m` : "set the bar"}
                </button>
              )}
            </Show>
            <Select
              variant="ghost"
              prefix="gauntlet: "
              width={320}
              title="keep looping builders against critics until the work clears a bar — the run can go for hours and is stopped by spend, time or no progress"
              value={gauntletOf(state.pipeline) ? "on" : "off"}
              options={GAUNTLET_OPTIONS}
              onChange={(value) => actions.setGauntlet(value === "on")}
            />
          </Show>
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
          <button class="btn btn-primary" type="button" disabled={state.running} onClick={() => void run()}>
            <IconPlay />
            Run
          </button>
          <Show when={canRerunFailed()}>
            <button
              class="btn"
              type="button"
              title="run only the cards that did not finish, reusing the outputs of the ones that did"
              onClick={() => void run(reusableOutputs())}
            >
              <IconPlay />
              Re-run failed
            </button>
          </Show>
          <button class="btn btn-danger" type="button" disabled={!state.running} onClick={stop}>
            <IconStop />
            Stop
          </button>
        </div>
      </div>

      <Show when={state.notice}>
        {(banner) => (
          <div class="notice" data-kind={banner().kind} onClick={actions.clearNotice}>
            <span class="notice-icon">
              <Show when={banner().kind === "error"} fallback={<IconInfo />}>
                <IconAlert />
              </Show>
            </span>
            <span class="notice-text">{banner().text}</span>
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

      {/* Parked. The install works and the server is correct, but no MCP tool
          reaches a v2 session in this fork, so offering the config write would
          promise a fix it cannot deliver — see `MCP_REACHES_SESSIONS`. The
          route stays live for anyone who wants to install it ahead of upstream;
          it just is not advertised. Flip the constant to bring this back. */}
      <Show when={MCP_REACHES_SESSIONS && modeOf(state.pipeline) === "orchestration" && dispatchTool() && !dispatchTool()!.current}>
        <div class="notice" data-kind="info">
          <IconInfo />
          <span class="notice-text">
            {dispatchTool()!.present
              ? "The dispatch tool in your global opencode config points at a different checkout — repoint it so orchestrator cards can call it."
              : "Orchestrator cards have no dispatch tool to call. Installing it writes one entry into your global opencode config, backed up first."}
          </span>
          <button class="btn" type="button" disabled={installing()} onClick={() => void installDispatchTool()}>
            {installing() ? "installing…" : dispatchTool()!.present ? "repoint" : "install"}
          </button>
        </div>
      </Show>

      <Show when={issues()}>
        {(pre) => (
          <div class="preflight">
            <div class="preflight-head">
              <span class="preflight-title">
                <Show when={pre().blocking.length} fallback={<>Warnings before this run</>}>
                  Fix before running
                </Show>
              </span>
              <button
                class="icon-btn"
                type="button"
                title="dismiss"
                aria-label="dismiss"
                onClick={() => setIssues(undefined)}
              >
                <IconClose />
              </button>
            </div>
            <For each={[...pre().blocking, ...pre().warnings]}>
              {(problem) => (
                <button
                  class="preflight-item"
                  type="button"
                  data-kind={pre().blocking.includes(problem) ? "bad" : "warn"}
                  disabled={!problem.nodeId}
                  title={problem.nodeId ? "show this node in the inspector" : undefined}
                  onClick={() => problem.nodeId && actions.select(problem.nodeId)}
                >
                  <span class="preflight-dot" data-kind={pre().blocking.includes(problem) ? "bad" : "warn"} />
                  <span class="preflight-message">{problem.message}</span>
                </button>
              )}
            </For>
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
        <Show when={showSessions()}>
          <SessionsPanel
            project={project()}
            onClose={() => {
              setShowSessions(false)
              writeShowSessions(false)
            }}
          />
        </Show>
        <Palette />
        <Canvas />
        <Inspector
          agents={agents()}
          providers={providers()}
          mcpServers={mcpNames()}
          onManageKeys={openProviders}
          onManageMcp={() => setShowMcp(true)}
        />
      </main>

      <Walkthrough
        unlockedProviders={unlockedRows(providers()).length}
        suggestedFree={defaultModel() ? undefined : suggestedFreeDefault(providers())}
        onOpenProviders={() => openProviders()}
        onUseFree={async () => {
          // suggestedFreeDefault picks by catalog order, not liveness — the free
          // tier's health drifts hour to hour, so probe each candidate with a real
          // prompt (same check the per-node "test" button runs) until one answers.
          const candidates = freeModels(providers())
          if (!candidates.length) return
          actions.notice("info", "checking free models…")
          for (const candidate of candidates) {
            const result = await api.testModel(candidate.value)
            if (!result.ok) continue
            setDefaultModel(candidate.value)
            actions.notice("info", `default model set to ${candidate.value} — new nodes will use it`)
            return
          }
          actions.notice("error", "no free model answered right now — try again in a moment")
        }}
      />

      {/* Below the graph, above the status bar: the expanded card. */}
      <Show when={state.expanded}>
        <ActivityDrawer />
      </Show>

      <Show when={showProviders()}>
        <ProvidersPanel
          rows={providers()}
          initialQuery={providerQuery()}
          onClose={() => setShowProviders(false)}
          onChanged={refreshProviders}
          onNotice={notice}
          onRestart={engine()?.managed ? restartEngine : undefined}
        />
      </Show>

      <Show when={showSkills()}>
        <SkillsPanel onClose={() => setShowSkills(false)} onNotice={notice} />
      </Show>

      <Show when={showMcp()}>
        <McpPanel onClose={() => setShowMcp(false)} onNotice={notice} onChanged={refresh} />
      </Show>

      {/*
        One question at a time: the dialog blocks, and stacking two of them
        would hide which card is waiting on which.
      */}
      {/*
        Read the signal directly rather than through the render-prop accessor:
        answering unmounts this Show from inside the child's own handler, and
        the accessor goes stale mid-handler ("Attempting to access a stale
        value from <Show>").
      */}
      <Show when={state.questions[0]?.requestID} keyed>
        <QuestionDialog request={state.questions[0]!} onAnswer={actions.answerQuestion} />
      </Show>

      <Show when={showProjectPicker()}>
        <ProjectPicker current={project()} onClose={() => setShowProjectPicker(false)} onSwitched={switchProject} />
      </Show>

      <Show when={engineHelp()}>
        {(status) => (
          <EngineDialog
            status={status()}
            because={engineWhy()}
            restarting={restarting()}
            onRestart={status().managed ? () => void restartEngine() : undefined}
            onClose={() => setEngineHelp(undefined)}
          />
        )}
      </Show>

      <Show when={showSpend()}>
        <SpendPanel onClose={() => setShowSpend(false)} />
      </Show>

      {/* Only reachable while the canvas is a gauntlet, and it closes itself if
          the mode changes underneath it rather than editing settings nothing
          would read. */}
      <Show when={gauntletOpen() && gauntletOf(state.pipeline)}>
        <GauntletDialog
          pipeline={state.pipeline}
          onChange={actions.setGauntletSetting}
          onClose={() => setGauntletOpen(false)}
        />
      </Show>

      <footer class="statusbar">
        <div class="statusbar-left">
          <span
            class="statusbar-dot"
            data-state={status().startsWith("offline") ? "bad" : "ok"}
            title={status()}
            aria-hidden="true"
          />
          <span class="status">{status()}</span>
          <Show when={state.run} fallback={<span class="hint">no run yet</span>}>
            {(log) => (
              <>
                <span class="mono">{log().id}</span>
                <span class="badge" data-status={log().status}>
                  {log().status}
                </span>
                {/* A gauntlet has no node count to read progress from — it ends
                    on money or time, so those are what a run has to show while
                    it is going. */}
                <Show when={gauntletProgress(log())}>
                  {(progress) => (
                    <span class="mono" title="what this gauntlet has spent of the bounds that will stop it">
                      {progress().spend} · {progress().time}
                    </span>
                  )}
                </Show>
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
          {/*
            Always visible, run or no run: the point of the readout is that
            nobody has to go looking for what the agents have cost. It shows the
            live run's list-price total, and `≥` whenever some model in it has
            no published price — see `server/usage.ts`.
          */}
          <button
            class="icon-btn statusbar-spend"
            type="button"
            title="what this run has cost, and every run before it"
            onClick={() => setShowSpend(true)}
          >
            <IconCoin />
            <span class="mono">{state.run?.usage?.steps ? costLabel(state.run.usage) : "—"}</span>
          </button>
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
            title={`${project()} — click to choose a folder (right-click to browse in-app)`}
            aria-label="switch project"
            onClick={() => void pickProject()}
            onContextMenu={(event) => {
              event.preventDefault()
              setShowProjectPicker(true)
            }}
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

/**
 * Reads the provider catalog, retrying while it comes back empty.
 *
 * `GET /api/integration` answers as soon as the engine is listening, but the
 * catalog behind it is populated separately, so a page that loads the instant
 * the engine comes up can get `200` with nothing in it. An empty catalog is
 * never a real answer — models.dev knows hundreds of providers — and nothing
 * refetches it until a key changes, so without this the first thing a fresh
 * install sees when it clicks "api keys" is an empty list.
 */
async function readCatalog() {
  for (const wait of RETRIES) {
    if (wait) await new Promise((done) => setTimeout(done, wait))
    const list = await api.integrations().catch(() => [])
    if (list.length) return list
  }
  return []
}

/**
 * Reads the model list. `expected` says whether an empty answer can be real:
 * a fresh install with no key connected genuinely has no models, and retrying
 * that would only delay the panel that exists to fix it.
 */
async function readModels(expected: boolean) {
  for (const wait of RETRIES) {
    if (wait) await new Promise((done) => setTimeout(done, wait))
    const list = await api.models().catch(() => [])
    if (list.length || !expected) return list
  }
  return []
}

/** Backoff for the two catalog reads, in ms before each attempt. */
const RETRIES = [0, 300, 900, 2000]

/** Parses untrusted file text; a malformed file yields `undefined`, not a throw. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
