import type { PtyKind } from "../shared/terminal"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { Canvas } from "./canvas/canvas"
import {
  depthOf,
  dispatchesOf,
  gauntletOf,
  MAX_DEPTH,
  MAX_DISPATCHES,
  MAX_ROUNDS,
  isolationOf,
  modeOf,
  roundsOf,
  type FlowMode,
  type RunLog,
} from "./graph/types"
import { layer, preflight, type Preflight } from "./graph/validate"
import { isPipeline } from "./graph/pipeline-io"
import { isLegacySession, legacyModelProblems, migratePipeline, migrateRunLog, type MigrationNote } from "./graph/migrate"
import * as api from "./server/client"
import {
  DEFAULT_CATALOG_RETRY,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_NODE_TIMEOUT,
  start,
  type PermissionPolicy,
  type PipeMode,
  type Run,
} from "./server/engine"
import { availableModels, providerRows, type ProviderRow } from "./server/providers"
import { setAvailableModels } from "./graph/default-model"
import { forgetCustomRoles, hydrateCustomRoles, onRolesSyncError } from "./graph/roles"
import { latest } from "./server/latest"
import { abandoned, findRun, interrupted, PRUNE_DAYS, RUN_DELETE, RUN_PRUNE, runMenuOptions, superseded } from "./server/runs"
import { store, type PipelineEntry, type RunEntry } from "./server/store"
import { PROJECT_BUSY, switchFreeing } from "./server/project"
import { actions, requestKey, state } from "./state"
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
  IconLayers,
  IconPlay,
  IconPlug,
  IconPlus,
  IconSave,
  IconSliders,
  IconStop,
  IconTerminal,
} from "./ui/icons"
import { ActivityDrawer } from "./ui/activity-drawer"
import { Attachments, filesFrom, readFiles } from "./ui/attachments"
import { CoachStrip, dismissKey, visibleFindings } from "./ui/coach-strip"
import { coach } from "./graph/coach"
import { Inspector } from "./ui/inspector"
import { McpPanel } from "./ui/mcp-panel"
import { QuestionDialog } from "./ui/question-dialog"
import { Palette } from "./ui/palette"
import { Walkthrough } from "./ui/walkthrough"
import { ProjectPicker } from "./ui/project-picker"
import { SessionsPanel } from "./ui/sessions-panel"
import { SkillsPanel } from "./ui/skills-panel"
import { SpendPanel } from "./ui/spend-panel"
import { GauntletDialog } from "./ui/gauntlet-dialog"
import { VerifyDialog } from "./ui/verify-dialog"
import { alertsOn, announce, askDesktop, setAlerts, webhook } from "./alerts"
import { AlertsDialog } from "./ui/alerts-dialog"
import { costLabel } from "./server/usage"
import { Select, type SelectOption } from "./ui/select"
import { OmpSettingsDialog } from "./ui/omp-settings"
import { TerminalDock } from "./ui/terminal-dock"
import { UpliftFailureDialog } from "./ui/uplift-dialog"
import { omp } from "./server/omp-config"

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
const ISOLATE_OPTIONS: SelectOption[] = [
  { value: "off", label: "off", hint: "one shared working directory" },
  { value: "on", label: "on", hint: "a git worktree per card, merged after each batch" },
]
const VERIFY_OPTIONS: SelectOption[] = [
  { value: "off", label: "off", hint: "the run ends when its cards do" },
  { value: "on", label: "on", hint: "a reviewer card judges the result and the run reports its verdict" },
]
const ALERT_OPTIONS: SelectOption[] = [
  { value: "off", label: "off", hint: "the canvas is the only place an ending is reported" },
  { value: "on", label: "on", hint: "tell me when the run ends, even if I have walked away" },
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

/** How often the statusbar re-checks the host while nothing else is talking to it. */
const HEALTH_INTERVAL = 15_000

/** How often a running gauntlet's elapsed-minutes readout advances. */
const CLOCK_INTERVAL = 10_000

/** How often the Resume offer is re-judged. Half the heartbeat that keeps a live run's log fresh. */
const RESUME_CLOCK_INTERVAL = 30_000

const HOST_DOWN = "cannot reach the OpenFlow host — start it with `bun openflow.ts`, then reload this page"
const OMP_MISSING = "omp is not available — install it, or set its path in the Omp settings"

/** What a probe found: all well, the host does not answer, or the host answers and omp cannot run. */
type Health = "ready" | "host" | "omp"

/** Banner extras that ride along with a notice: a hover title, and a button that opens the Omp settings. */
type NoticeMeta = { text: string; title?: string; settings?: boolean }

/**
 * Whether a failure is the host's or omp's rather than the request's.
 *
 * Every `/flow/api/*` call dies the same way when the host is down, and the
 * symptom surfaces as whatever the caller was doing — a model read, a save, a
 * run. Matching the message is what turns any of those back into one honest
 * "the host is gone / omp is missing" state instead of a confident wrong
 * diagnosis. The wire drops the error `code`, so `omp-unavailable` is matched
 * through the sentences the host attaches to it.
 */
function namesHost(text: string) {
  return (
    text.includes("Failed to fetch") ||
    text.includes("NetworkError") ||
    text.includes("HTTP 502") ||
    text.includes("HTTP 503") ||
    text.includes("omp-unavailable") ||
    text.includes("omp was not found") ||
    text.includes("omp is not available") ||
    text.includes("could not run omp") ||
    text.includes("flow store unavailable") ||
    text.includes("OpenFlow host did not answer")
  )
}

/**
 * Whether a panel was left open: the sessions column and the terminal dock.
 *
 * Both closed by default — the canvas is the app, and a first run should get
 * the full width and height. Storage is best-effort in both directions — the
 * signal is the source of truth, so `bun test` (which has no `localStorage`)
 * and a private window both behave, they just do not remember.
 */
const SESSIONS_KEY = "openflow.sessionsOpen.v1"
const TERMINAL_KEY = "openflow.terminal.v1"

function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeFlag(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0")
  } catch {
    // A browser that refuses storage still gets a working panel for this tab.
  }
}

const NOTE_LABELS: Record<MigrationNote["kind"], string> = {
  "legacy-model": "models to re-pick",
  "legacy-agent": "agent settings dropped",
  "legacy-session": "sessions that cannot be resumed",
  "unknown-field": "unrecognised fields kept",
}

/** Most migration lines the hover title lists; the rest are counted. */
const NOTE_LINES = 12

/** One line for the banner, every note for its hover title. Absent when the migration had nothing to say. */
function migrationSummary(notes: MigrationNote[]) {
  if (!notes.length) return undefined
  const counts = new Map<MigrationNote["kind"], number>()
  for (const note of notes) counts.set(note.kind, (counts.get(note.kind) ?? 0) + 1)
  const parts = [...counts].map(([kind, count]) => `${NOTE_LABELS[kind]}: ${count}`)
  const lines = notes.slice(0, NOTE_LINES).map((note) => note.message)
  if (notes.length > NOTE_LINES) lines.push(`…and ${notes.length - NOTE_LINES} more`)
  return { text: `from an earlier build — ${parts.join(", ")} (hover for details)`, title: lines.join("\n") }
}

/** A pipeline read from disk or a file, brought up to date. `undefined` when it is not a pipeline at all. */
function readPipeline(raw: unknown) {
  const { pipeline, notes } = migratePipeline(raw)
  return isPipeline(pipeline) ? { pipeline, summary: migrationSummary(notes) } : undefined
}

async function loadRun(id: string) {
  const { run, notes } = migrateRunLog(await store.run(id))
  // The migration only stamps and reports; the shape is still the store's `RunLog`.
  return { log: run as RunLog, summary: migrationSummary(notes) }
}

export function App() {
  const [status, setStatus] = createSignal("connecting…")
  const [providers, setProviders] = createSignal<ProviderRow[]>([])
  /** False until the first catalog read settles; the first-run walkthrough says "Loading models…" until then. */
  const [modelsLoaded, setModelsLoaded] = createSignal(false)
  const [showSkills, setShowSkills] = createSignal(false)
  const [showMcp, setShowMcp] = createSignal(false)
  const [showSpend, setShowSpend] = createSignal(false)
  const [showOmp, setShowOmp] = createSignal(false)
  const [terminalOpen, setTerminalOpen] = createSignal(readFlag(TERMINAL_KEY))
  const [terminalKind, setTerminalKind] = createSignal<PtyKind>("omp")
  const [gauntletOpen, setGauntletOpen] = createSignal(false)
  const [verifyOpen, setVerifyOpen] = createSignal(false)
  const [alertsOpen, setAlertsOpen] = createSignal(false)
  const [tick, setTick] = createSignal(Date.now())
  /** `omp` as the host's last health answer saw it. Unknown until the first answer, which counts as ready. */
  const [ompInfo, setOmpInfo] = createSignal<api.HealthInfo["omp"]>()
  /** The host's sentence for why omp cannot run, with the fix; absent when omp is fine or nothing said. */
  const [ompProblem, setOmpProblem] = createSignal<string>()
  const [noticeMeta, setNoticeMeta] = createSignal<NoticeMeta>()
  const [showProjectPicker, setShowProjectPicker] = createSignal(false)
  const [pickingProject, setPickingProject] = createSignal(false)
  const [pipelines, setPipelines] = createSignal<PipelineEntry[]>([])
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [project, setProject] = createSignal("")
  const [showSessions, setShowSessions] = createSignal(readFlag(SESSIONS_KEY))
  const [pipe, setPipe] = createSignal<PipeMode>("ancestors")
  const [policy, setPolicy] = createSignal<PermissionPolicy>("auto")
  const [parallel, setParallel] = createSignal(DEFAULT_MAX_PARALLEL)
  const [nodeTimeout, setNodeTimeout] = createSignal(DEFAULT_NODE_TIMEOUT)
  const [issues, setIssues] = createSignal<Preflight>()
  let current: Run | undefined
  let providersRequest = 0
  const probes = latest()
  const listings = latest()
  const openings = latest()
  /** The clock the Resume offer is judged against: an abandoned run turns resumable by itself as it ticks. */
  const [resumeNow, setResumeNow] = createSignal(Date.now())
  /** A folder is being chosen: the host may move to another project at any moment, so no run may start. */
  const folderOpen = () => pickingProject() || showProjectPicker()

  const ompReady = () => ompInfo()?.available !== false
  const ompMessage = () => ompProblem() ?? OMP_MISSING

  /**
   * The `providerID/modelID` set a node could actually run right now: the
   * models of every provider omp holds credentials for, or says nothing about.
   */
  const unlockedModels = () => new Set(availableModels(providers()).map((model) => model.value))

  /** Shows a banner. `extra` is for the banner alone: its hover title and the Omp settings button. */
  function say(kind: "info" | "error", text: string, extra: Omit<NoticeMeta, "text"> = {}) {
    actions.notice(kind, text)
    setNoticeMeta({ text, ...extra })
  }

  /**
   * Every error this file reports goes through here rather than through
   * `actions.notice` directly, so a failure that names the host re-probes it.
   * Without that the statusbar keeps asserting "connected" against a dead
   * host for as long as the tab stays open.
   */
  function notice(kind: "info" | "error", text: string) {
    say(kind, text)
    if (kind === "error" && namesHost(text)) void probe()
  }

  /**
   * One health round trip. The only thing that may put the statusbar back to
   * "connected", and the only thing that clears `hostReachable`. Never throws.
   */
  async function probe(): Promise<Health> {
    // Heartbeat, notices and runs all probe: only the newest answer may touch the statusbar, or an old failure lands over a newer success.
    const current = probes.begin()
    try {
      const health = await api.health()
      if (current()) {
        actions.setHostReachable(true)
        setOmpInfo(health.omp)
      }
      if (health.omp.available) {
        if (current()) {
          setOmpProblem(undefined)
          setStatus(health.omp.version ? `connected · omp ${health.omp.version}` : "connected")
        }
        return "ready"
      }
      // The health answer only says omp is missing; its status view names the problem and the fix.
      const detail = await omp.status()
      if (current()) {
        const problem = detail.ok ? detail.value.problems[0] : undefined
        setOmpProblem(problem ? `${problem.message}${problem.fix ? ` — ${problem.fix}` : ""}` : undefined)
        setStatus("omp unavailable")
      }
      return "omp"
    } catch (error) {
      if (current()) {
        actions.setHostReachable(false)
        setStatus(`offline — ${api.describe(error)}`)
      }
      return "host"
    }
  }

  /**
   * Connects (or reconnects, after a project switch) and reloads everything
   * that is scoped to the project directory: the model catalog, saved
   * pipelines, recorded runs.
   */
  async function bootstrap() {
    // Roles belong to one project: nothing of the previous project's may be on screen if this one's cannot be read.
    forgetCustomRoles()
    setStatus("connecting…")
    let reachable = true
    try {
      const { context } = await api.connect()
      setProject(context.project)
      // Before the palette settles, so a project's own saved roles are what it
      // renders rather than the built-ins alone. Roles follow the project, so
      // this re-runs on a switch too.
      await hydrateCustomRoles()
    } catch (error) {
      const detail = api.describe(error)
      reachable = false
      actions.setHostReachable(false)
      setStatus(`offline — ${detail}`)
      say("error", `${HOST_DOWN} (${detail})`)
    }
    if (reachable) {
      const health = await probe()
      if (health === "host") say("error", HOST_DOWN)
      if (health === "omp") say("error", ompMessage(), { settings: true })
      if (health !== "host") await refreshProviders()
    }
    const entries = await refresh()
    await reopen(entries)
  }

  /** The logins or the Omp settings may have changed what omp is or can run: read its health, models and providers again. */
  async function reconnect() {
    const health = await probe()
    if (health === "ready" && noticeMeta()?.settings && noticeMeta()?.text === state.notice?.text) actions.clearNotice()
    if (health !== "host") await refreshProviders()
  }

  /**
   * Reopens the pipeline that was last open in this project.
   *
   * Only if the store still lists it: a pipeline deleted or renamed outside
   * OpenFlow would otherwise greet the user with a load error on every launch.
   * Loading is silent — this is restoring where they were, not an action they
   * just took — except for what a migration had to say about it. It is safe at
   * boot because the canvas is empty until it runs. A failure leaves the blank
   * canvas rather than blocking startup.
   */
  async function reopen(entries: PipelineEntry[]) {
    try {
      // `connect()` is cached, so this rereads nothing — it just hands back the
      // context already fetched, including the pipeline to reopen.
      const { context } = await api.connect()
      const last = context.pipeline
      if (!last || !entries.some((entry) => entry.name === last)) return
      const opened = readPipeline(await store.pipeline(last))
      if (!opened) return
      actions.load(opened.pipeline)
      if (opened.summary) say("info", `reopened ${last} — ${opened.summary.text}`, { title: opened.summary.title })
    } catch {
      // The listing said it was there; if it is not, a blank canvas is fine.
    }
  }

  // A role that only reached this browser is one cleared cache from gone, so a
  // failed write to the project's roles.json has to be said out loud.
  onRolesSyncError((reason) => actions.notice("error", `custom roles were not saved to this project — ${reason}`))
  onMount(bootstrap)

  onMount(() => {
    // A heartbeat, not a poll of anything expensive: one `/flow/api/engine/health`
    // while the tab is visible and no run is already talking to the host. Without
    // it the statusbar only ever learns the truth at boot.
    const timer = setInterval(() => {
      if (document.hidden || state.running) return
      void probe()
    }, HEALTH_INTERVAL)
    // The clock behind the gauntlet readout. It only has to be right to the
    // minute, and it stops mattering the moment a run finishes.
    const clock = setInterval(() => state.running && setTick(Date.now()), CLOCK_INTERVAL)
    // A run abandoned minutes ago becomes resumable on its own: the staleness rule needs a clock that moves.
    const resumeClock = setInterval(() => setResumeNow(Date.now()), RESUME_CLOCK_INTERVAL)
    // Coming back to a tab that sat hidden for an hour should not wait out the
    // interval before admitting the host died meanwhile.
    const onVisibility = () => {
      if (!document.hidden) void probe()
    }
    // Ctrl+` toggles the terminal. A field elsewhere on the page keeps the key
    // (it may be typing a backtick); the dock itself never gets here, because it
    // contains every key typed inside it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      if (event.key !== "`" && event.code !== "Backquote") return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        !target.closest(".terminal-dock") &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      )
        return
      event.preventDefault()
      setTerminal(!terminalOpen())
    }
    // The one destructive path the app cannot guard with a dialog of its own.
    //
    // A live run counts as much as an unsaved graph, and for longer: the engine
    // runs *in this page*, so a reload orphans every session mid-turn and there
    // is no resume. Measured on a gauntlet — an hour of work, four cards
    // dispatched, gone on a refresh nobody thought twice about.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.running && (!state.dirty || !state.pipeline.nodes.length)) return
      // Browsers show their own wording; `preventDefault` is what asks at all.
      event.preventDefault()
      event.returnValue = ""
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("beforeunload", onBeforeUnload)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(clock)
      clearInterval(resumeClock)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("beforeunload", onBeforeUnload)
    })
  })

  /**
   * Opens or closes the terminal dock and remembers the choice. The activity
   * drawer and the dock share the column under the canvas, so the one opened
   * last wins: two docks would leave the canvas no height.
   */
  function setTerminal(open: boolean) {
    if (open) actions.expand(undefined)
    setTerminalOpen(open)
    writeFlag(TERMINAL_KEY, open)
  }

  function openTerminal(kind: PtyKind) {
    setTerminalKind(kind)
    setTerminal(true)
  }

  // The other half of the rule above: expanding a card closes the dock. Not
  // remembered — the user did not turn the terminal off, a card took its place.
  createEffect(() => {
    if (state.expanded && terminalOpen()) setTerminalOpen(false)
  })

  // Logins change what omp can run, and they are typed in the terminal or the Omp
  // dialog without this app hearing about it: read models and providers again
  // when either closes. The host's catalog is keyed on the profile's credential
  // files, so an unchanged profile costs nothing.
  createEffect(
    on(
      terminalOpen,
      (open, wasOpen) => {
        if (wasOpen && !open) void reconnect()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      showOmp,
      (open, wasOpen) => {
        if (wasOpen && !open) void reconnect()
      },
      { defer: true },
    ),
  )

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
    if (state.running) return actions.notice("info", PROJECT_BUSY)
    setPickingProject(true)
    try {
      // No native dialog (a remote or headless host) leaves the in-app browser as the way to choose.
      const picked = await store.pickFolder(project() || undefined).then(
        (result) => result,
        () => undefined,
      )
      if (!picked) return setShowProjectPicker(true)
      if (!picked.path) return
      const target = picked.path
      // The dialog stays open for as long as the user likes: look again before moving the host.
      if (state.running) return actions.notice("info", PROJECT_BUSY)
      const paths = await switchFreeing(() => store.setProject(target), {
        confirm: (question) => window.confirm(question),
        release: api.release,
      })
      if (!paths) return
      api.disconnect()
      await switchProject(paths.project)
    } catch (error) {
      // The host refuses while cards hold the project, and says so in a sentence: show it as it is.
      notice("error", api.describe(error))
    } finally {
      setPickingProject(false)
    }
  }

  async function switchProject(next: string) {
    if (state.running) {
      // The host moved before the page could refuse: put it back under the project this page's run is in.
      const back = await store.setProject(project()).then(
        () => true,
        () => false,
      )
      api.disconnect()
      return back
        ? actions.notice("info", PROJECT_BUSY)
        : notice("error", `${PROJECT_BUSY} — the host is now on ${next} while this page is on ${project()}: switch back with the folder button`)
    }
    setShowProjectPicker(false)
    await bootstrap()
    actions.notice("info", `switched project to ${next}`)
  }

  /**
   * Re-reads omp's model catalog and its provider list together.
   *
   * They have to be read as a pair: the model list says what omp can dispatch,
   * the provider list says which providers have credentials, and only the join
   * says which models a user can choose. A provider list that fails to load is
   * treated as unknown, which keeps every model available rather than hiding
   * models omp would run. Called at boot and whenever the logins may have changed:
   * the Omp settings changed, Copy logins ran, or the terminal or the Omp dialog closed.
   */
  async function refreshProviders() {
    // With the host down every read comes back empty, which would read as "no
    // model is runnable": keep what is on screen instead.
    if (!state.hostReachable) return
    // Refreshes now come from several places; only the newest one may write.
    const mine = ++providersRequest
    let models = await api.models().catch(() => [])
    // The first read can land while omp is still enumerating its catalog.
    if (!models.length && ompReady()) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, DEFAULT_CATALOG_RETRY)
      await promise
      models = await api.models().catch(() => [])
    }
    const known = await omp.providers()
    if (mine !== providersRequest) return
    setProviders(providerRows(models, known.ok ? known.value : undefined))
    // Keep the default-model gate current: a node only inherits the default
    // when it is still among the models a provider can actually run.
    setAvailableModels(unlockedModels())
    setModelsLoaded(true)
  }

  async function refresh() {
    // Called from boot, save, a project switch and the end of every run: the newest read owns the lists.
    const current = listings.begin()
    const [entries, recorded] = await Promise.all([
      store.pipelines().catch(() => []),
      store.runs().catch(() => []),
    ])
    if (current()) {
      setPipelines(entries)
      setRuns(recorded)
    }
    return entries
  }

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
    // What this request writes. Edits made while it is in flight are not in it, so they must keep the graph dirty.
    const snapshot = JSON.stringify(state.pipeline)
    const name = state.pipeline.name
    try {
      const response = await fetch(
        `/flow/api/pipelines/${encodeURIComponent(name)}${overwrite ? "?overwrite=1" : ""}`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: snapshot },
      )
      const body = await response.json().catch(() => undefined)
      if (response.status === 409) {
        const conflict = body?.error ?? `a different pipeline is already saved as "${name}"`
        // Never overwrite on the user's behalf: replacing somebody's saved work
        // is the whole thing this guard exists to prevent.
        if (
          window.confirm(`${conflict}\n\nOK replaces the saved pipeline. Cancel keeps it so you can rename this one.`)
        )
          return save(true)
        return notice("error", `${conflict} — rename this pipeline in the title bar, then save again`)
      }
      if (!response.ok) return notice("error", body?.error ?? `could not save the pipeline (HTTP ${response.status})`)
      const unchanged = JSON.stringify(state.pipeline) === snapshot
      if (unchanged) actions.markSaved()
      actions.notice("info", unchanged ? `saved ${body.path}` : `saved ${body.path} — edits made while saving are not saved yet`)
      await refresh()
    } catch (error) {
      notice("error", api.describe(error))
    }
  }

  let importInput: HTMLInputElement | undefined

  /** Saves the current graph to a `.json` file — the same schema the server stores. */
  function exportPipeline() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.pipeline, null, 2)], { type: "application/json" }))
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
    const opened = readPipeline(parseJson(await file.text()))
    if (!opened) return actions.notice("error", "Not a valid OpenFlow pipeline")
    if (!confirmReplace()) return
    actions.load(opened.pipeline)
    // Loading clears `dirty`, but an imported graph is not on disk here yet —
    // closing the tab would still lose it.
    actions.markDirty()
    say("info", `imported ${opened.pipeline.name}${opened.summary ? ` — ${opened.summary.text}` : ""}`, {
      title: opened.summary?.title,
    })
  }

  async function load(name: string) {
    if (!name) return
    if (!confirmReplace()) return
    try {
      const opened = readPipeline(await store.pipeline(name))
      if (!opened) return notice("error", `${name} is not a valid OpenFlow pipeline`)
      actions.load(opened.pipeline)
      say("info", `loaded ${name}${opened.summary ? ` — ${opened.summary.text}` : ""}`, { title: opened.summary?.title })
    } catch (error) {
      notice("error", api.describe(error))
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

  /**
   * Findings are derived, never stored: reopening a past run from the Runs menu
   * recomputes them. Dismissal is keyed by run id, so a new run starts fresh.
   */
  const [dismissedFindings, setDismissedFindings] = createSignal<ReadonlySet<string>>(new Set())
  const findings = createMemo(() =>
    state.run && !state.running
      ? visibleFindings(coach(state.run, state.pipeline), dismissedFindings(), state.run.id)
      : [],
  )
  function dismissFinding(id: string) {
    const run = state.run
    if (!run) return
    setDismissedFindings((prev) => new Set(prev).add(dismissKey(run.id, id)))
  }

  /**
   * Picks an interrupted run back up: finished cards keep their answers, and the
   * ones that were still working are continued in the sessions they already hold.
   */
  async function resumeRun(id: string) {
    try {
      const { log, summary } = await loadRun(id)
      // The list this was offered from can be minutes old: the log itself says whether another tab is still writing it.
      if (!abandoned(log))
        return notice("error", `run ${id} was written a moment ago — it is probably still running in another tab`)
      const outputs: Record<string, string> = {}
      const sessions: Record<string, string> = {}
      const fresh: string[] = []
      for (const node of log.nodes) {
        if (node.status === "done" && node.output !== undefined) outputs[node.id] = node.output
        // A session the earlier build opened lives in a process this one cannot attach to.
        else if (node.sessionID && isLegacySession(node.sessionID)) fresh.push(node.role)
        else if (node.sessionID) sessions[node.id] = node.sessionID
      }
      actions.setRun(log)
      const carried = Object.keys(sessions).length
      say(
        "info",
        `resuming ${id} — ${Object.keys(outputs).length} card(s) kept, ${carried} continued in session` +
          (fresh.length
            ? `, ${fresh.length} start fresh because their session is from an earlier build and cannot be resumed (${fresh.join(", ")})`
            : ""),
        { title: summary?.title },
      )
      await run(outputs, sessions, log)
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  async function run(resume?: Record<string, string>, sessions?: Record<string, string>, supersedes?: RunLog) {
    // A run started while a folder is being chosen would be bound to the project the host is about to leave.
    if (state.running || folderOpen()) return
    // One place tells the user everything that is wrong before a session is
    // ever created. Blocking problems abort; warnings are shown but let the run
    // proceed. The list survives on screen so each problem can select its node.
    // The host is re-probed first: a card needs the host to launch omp and omp
    // to be there, and with either missing every model reads as locked, so
    // preflight would blame each node's model instead of the one real cause.
    const health = await probe()
    if (health === "host") {
      setIssues(undefined)
      return say("error", HOST_DOWN)
    }
    if (health === "omp") {
      setIssues(undefined)
      say("error", ompMessage(), { settings: true })
      // The one place the fix lives, so it is offered rather than left to be found.
      setShowOmp(true)
      return
    }
    // The project is read from the host rather than from this page, and handed to the engine: a project switch made while the run is going must not move the rest of it somewhere else.
    api.disconnect()
    const startedIn = await api.connect().then(
      ({ context }) => context.project,
      () => undefined,
    )
    if (startedIn) setProject(startedIn)
    openings.cancel()
    const pre = preflight(state.pipeline, { unlockedModels: unlockedModels() })
    // A card carried over from an earlier build can name a model this catalog
    // does not hold; say why before the generic "no logged-in provider" line.
    pre.warnings.unshift(...legacyModelProblems(state.pipeline).map((message) => ({ kind: "legacy-model", message })))
    setIssues(pre.blocking.length || pre.warnings.length ? pre : undefined)
    if (pre.blocking.length) return
    actions.clearNotice()

    actions.resetRuntime(Object.fromEntries(state.pipeline.nodes.map((node) => [node.id, "queued" as const])))
    actions.setRunning(true)
    try {
      current = start(
        state.pipeline,
        // A resumed run must re-send the task the reused outputs were produced
        // from: downstream prompts are built from both, so a task edited in the
        // meantime would pair new instructions with old answers.
        resume || sessions ? (state.run?.input ?? state.input) : state.input,
        {
          // The card's own task is what uplift was asked about, so it is also
          // the "original" the inspector shows next to what was sent.
          onNode: (id, patch) =>
            actions.patchRuntime(id, patch.uplift ? { ...patch, originalPrompt: patch.uplift.original } : patch),
          onNodeEvent: (id, event) => actions.pushEvent(id, event),
          onRun: (log) => actions.setRun(clone(log)),
          onNotice: notice,
          onPermission: (request) =>
            actions.askPermission({
              sessionID: request.sessionID,
              requestID: request.requestID,
              nodeID: request.nodeID,
              role: request.role,
              action: request.action,
              resources: request.resources,
            }),
          onQuestion: (request) =>
            actions.askQuestion({
              sessionID: request.sessionID,
              requestID: request.requestID,
              nodeID: request.nodeID,
              role: request.role,
              questions: request.questions,
            }),
          // The engine settles a question on its own once it times out, so the
          // dialog has to come down even though nobody touched it.
          onQuestionClosed: (sessionID, requestID) => actions.answerQuestion(requestKey(sessionID, requestID), undefined),
          // Blocks the card until a person says what to do with the original prompt.
          onUpliftFailure: (request) => actions.askUpliftFailure({ requestID: crypto.randomUUID(), ...request }),
        },
        {
          project: startedIn,
          pipe: pipe(),
          permissions: policy(),
          maxParallel: parallel(),
          nodeTimeout: nodeTimeout(),
          attachments: [...state.attachments],
          resume,
          sessions,
        },
      )
      // The resumed run carries on from the interrupted one, so that log stops being offered for resuming.
      if (supersedes)
        void store
          .saveRun(superseded(supersedes, current.log.id))
          .catch((error) => notice("error", `the interrupted run's log was not closed: ${api.describe(error)}`))
      const log = await current.done
      // Whoever asked for this is not necessarily here — a gauntlet is bounded
      // in hours, and the ending worth knowing about is exactly the one the
      // canvas cannot report to somebody who walked away. Failing to tell them
      // must not fail the run, so nothing here is awaited into the run's own
      // result path.
      void announce(log)
      // A run ends on whatever round a bound stopped it in, which is not
      // reliably its best: the last round a critic passed is on the log, and
      // the tree as that round left it is still reachable. Said only when the
      // two differ — on a run that ended on its best round there is nothing to
      // go back to.
      if (log.best?.ref && log.rounds?.[log.rounds.length - 1]?.ref !== log.best.ref)
        notice(
          "info",
          `the last round a critic passed was round ${log.best.round} — restore that state with: git restore --source ${log.best.ref} --worktree .`,
        )
      const failure = log.nodes.find((node) => node.status === "error")
      notice(
        log.status === "error" ? "error" : "info",
        failure ? `run ${log.id} error — ${failure.role}: ${failure.error}` : `run ${log.id} ${log.status}`,
      )
      // The host or omp died mid-run. The per-node text already says so, but
      // the fix lives in the status bar and the Omp settings, so say it again
      // in those terms — after confirming: `namesHost` matches any message that
      // mentions them, and a card can fail with such a message while both are
      // answering perfectly well.
      if (failure?.error && namesHost(failure.error)) {
        const after = await probe()
        if (after === "host") say("error", HOST_DOWN)
        if (after === "omp") {
          say("error", ompMessage(), { settings: true })
          setShowOmp(true)
        }
      }
    } catch (error) {
      notice("error", api.describe(error))
    } finally {
      actions.setRunning(false)
      actions.rejectPermissions()
      actions.rejectQuestions()
      // The engine has no callback for a decision it stopped waiting on, so a
      // dialog still up when the run settles has to be dropped here.
      actions.rejectUpliftFailures()
      current = undefined
      await refresh()
    }
  }

  async function stop() {
    actions.rejectPermissions()
    actions.rejectQuestions()
    actions.rejectUpliftFailures()
    await current?.stop()
    actions.notice("info", "stopping run…")
  }

  /**
   * Switches the ending alerts on, asking the browser for permission from the
   * click that did it — a notification prompt needs a gesture behind it, and
   * asking at load would be a permission dialog nobody had asked for.
   *
   * A refused prompt does not switch the setting off: the webhook is the other
   * half of this, works without any permission at all, and a user who has just
   * denied notifications has more reason to want it, not less. The notice says
   * so rather than leaving a toggle that looks on and does nothing.
   */
  async function enableAlerts(on: boolean) {
    setAlerts(on)
    if (!on) return
    if (!(await askDesktop()))
      notice("info", "this browser will not show desktop notifications — endings can still be sent to a webhook")
  }

  /** The Runs menu both opens a recording and manages one, so its rows are routed here. */
  async function chooseRun(value: string) {
    if (state.running) return
    if (value === RUN_DELETE) return deleteOpenRun()
    if (value === RUN_PRUNE) return pruneRuns()
    return openRun(value)
  }

  /**
   * Deletes the recording that is currently open.
   *
   * The canvas is deliberately left showing what it was showing: deleting the
   * record of a run is not the same as wanting the answers off the screen, and
   * a menu row that blanked the whole canvas would be a nasty surprise. Only
   * the log reference goes, which is what makes the run no longer re-openable.
   */
  async function deleteOpenRun() {
    // The listing's id, not the log's: a run is addressed by its filename and
    // the two differ in case for every run recorded as `run-<ISO>`.
    const id = findRun(runs(), state.run?.id)?.id
    if (!id) return
    if (
      !window.confirm(
        `Delete the recording of run ${id}?\n\nThis cannot be undone. The canvas keeps what it is showing.`,
      )
    )
      return
    try {
      await store.deleteRun(id)
      actions.setRun(undefined)
      actions.notice("info", `deleted run ${id}`)
      await refresh()
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  async function pruneRuns() {
    if (
      !window.confirm(
        `Delete every recorded run older than ${PRUNE_DAYS} days?\n\nThis cannot be undone. Runs still marked running are kept — those are the ones that can be resumed.`,
      )
    )
      return
    try {
      const result = await store.pruneRuns({ days: PRUNE_DAYS })
      // A run open on screen may have just been deleted underneath it.
      const open = findRun(runs(), state.run?.id)?.id
      if (open && result.removed.includes(open)) actions.setRun(undefined)
      actions.notice("info", `pruned ${result.removed.length} run(s), ${result.kept} kept`)
      await refresh()
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  async function openRun(id: string) {
    // A run in progress is still writing the canvas this would replace, and `resetRuntime` would cancel its pending uplift decisions.
    if (state.running) return
    const current = openings.begin()
    try {
      const { log, summary } = await loadRun(id)
      // Another recording was picked, or a run started, while this one was loading: it is not what the user is looking at any more.
      if (!current() || state.running) return
      actions.setRun(log)
      actions.resetRuntime({})
      for (const node of log.nodes) {
        actions.patchRuntime(node.id, {
          status: node.status,
          output: node.output,
          error: node.error,
          prompt: node.prompt,
          originalPrompt: node.uplift?.original,
          sessionID: node.sessionID,
          usage: node.usage,
          diff: node.diff,
          started: node.started,
          finished: node.finished,
          events: node.events,
          uplift: node.uplift,
          memory: node.memory,
          swarm: node.swarm,
        })
      }
      say("info", `loaded run ${id}${summary ? ` — ${summary.text}` : ""}`, { title: summary?.title })
    } catch (error) {
      actions.notice("error", api.describe(error))
    }
  }

  /**
   * Enter in the task field starts the run, the way a chat prompt box does.
   * Guarded on `state.running` so a second press cannot open a parallel
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
              writeFlag(SESSIONS_KEY, next)
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
            title="save the pipeline"
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
            title="author skills your cards can use"
            aria-label="skills"
            onClick={() => setShowSkills(true)}
          >
            <IconLayers />
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
          <button
            class="icon-btn"
            classList={{ active: showOmp() }}
            type="button"
            title="Omp — its status, models and keys, and how cards run it"
            aria-label="Omp settings"
            aria-haspopup="dialog"
            onClick={() => setShowOmp(true)}
          >
            <IconSliders />
          </button>
          <button
            class="icon-btn"
            classList={{ active: terminalOpen() }}
            type="button"
            title="terminal — an omp or shell session in this project (Ctrl+`)"
            aria-label="toggle terminal"
            aria-pressed={terminalOpen()}
            onClick={() => setTerminal(!terminalOpen())}
          >
            <IconTerminal />
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
            <Select
              variant="ghost"
              prefix="isolate: "
              width={360}
              title="give each dispatched card its own git worktree, and fold its work back in after the batch — two cards told to touch one file then conflict on merge instead of overwriting each other silently. Needs a git repository."
              value={isolationOf(state.pipeline) ? "on" : "off"}
              options={ISOLATE_OPTIONS}
              onChange={(value) => actions.setIsolate(value === "on")}
            />
          </Show>
          {/* Every mode, unlike the two above it: a gauntlet is the one canvas
              that already ends on a verdict, and `verifyOf` ignores it there. */}
          <Show when={!gauntletOf(state.pipeline)}>
            <Select
              variant="ghost"
              prefix="verify: "
              width={360}
              title="when the cards have finished, every reviewer card runs once more in a new session, looks at what the run produced, and passes or fails it — so a run that did nothing cannot report success"
              value={state.pipeline.verify ? "on" : "off"}
              options={VERIFY_OPTIONS}
              onChange={(value) => actions.setVerify(value === "on")}
            />
            <Show when={state.pipeline.verify}>
              <button
                class="btn btn-ghost"
                type="button"
                title="what the verifier holds the result against"
                onClick={() => setVerifyOpen(true)}
              >
                <IconSliders />
                {state.pipeline.verify?.bar?.trim() ? "bar set" : "set the bar"}
              </button>
            </Show>
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
          {/* A preference rather than a document property, so it sits with the
              run settings and not with mode, verify and isolate. */}
          <Select
            variant="ghost"
            prefix="alerts: "
            width={340}
            title="tell me when the run ends — a desktop notification while this page is not the one you are looking at, and a webhook if you set one"
            value={alertsOn() ? "on" : "off"}
            options={ALERT_OPTIONS}
            onChange={(value) => void enableAlerts(value === "on")}
          />
          <Show when={alertsOn()}>
            <button
              class="btn btn-ghost"
              type="button"
              title="where an ending is sent"
              onClick={() => setAlertsOpen(true)}
            >
              <IconSliders />
              {webhook().trim() ? "webhook set" : "add a webhook"}
            </button>
          </Show>
        </div>
        <div class="runbar-actions">
          <button class="btn btn-primary" type="button" disabled={state.running || folderOpen()} onClick={() => void run()}>
            <IconPlay />
            Run
          </button>
          <Show when={state.running || folderOpen() ? undefined : interrupted(runs(), state.pipeline.name, resumeNow())}>
            {(entry) => (
              <button
                class="btn"
                type="button"
                title="continue the run that was cut off — finished cards keep their answers, the rest carry on in the sessions they still hold"
                onClick={() => void resumeRun(entry().id)}
              >
                <IconPlay />
                Resume
              </button>
            )}
          </Show>
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

      <CoachStrip findings={findings()} onDismiss={dismissFinding} />

      <Show when={state.notice}>
        {(banner) => (
          <div
            class="notice"
            data-kind={banner().kind}
            role={banner().kind === "error" ? "alert" : "status"}
            aria-live={banner().kind === "error" ? undefined : "polite"}
            title={noticeMeta()?.text === banner().text ? noticeMeta()?.title : undefined}
            onClick={actions.clearNotice}
          >
            <span class="notice-icon">
              <Show when={banner().kind === "error"} fallback={<IconInfo />}>
                <IconAlert />
              </Show>
            </span>
            <span class="notice-text">{banner().text}</span>
            <Show when={noticeMeta()?.text === banner().text && noticeMeta()?.settings}>
              <button
                class="btn"
                type="button"
                aria-label="open the Omp settings"
                onClick={(event) => {
                  event.stopPropagation()
                  setShowOmp(true)
                }}
              >
                Omp settings
              </button>
            </Show>
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
        <div class="permissions" role="status" aria-live="polite" aria-label="permission requests">
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
                  <button
                    class="btn"
                    type="button"
                    onClick={() => actions.answerPermission(requestKey(request.sessionID, request.requestID), "once")}
                  >
                    allow once
                  </button>
                  <button
                    class="btn"
                    type="button"
                    onClick={() => actions.answerPermission(requestKey(request.sessionID, request.requestID), "always")}
                    title="persists to the project's saved permissions, beyond this run"
                  >
                    always
                  </button>
                  <button
                    class="btn btn-danger"
                    type="button"
                    onClick={() => actions.answerPermission(requestKey(request.sessionID, request.requestID), "reject")}
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
              writeFlag(SESSIONS_KEY, false)
            }}
          />
        </Show>
        <Palette />
        <Canvas />
        <Inspector
          providers={providers()}
          onManageKeys={() => setShowOmp(true)}
          onManageMcp={() => setShowMcp(true)}
        />
      </main>

      <Walkthrough
        ompReady={ompReady()}
        ompMessage={ompReady() ? undefined : ompMessage()}
        modelCount={availableModels(providers()).length}
        modelsLoaded={modelsLoaded()}
        onOpenOmp={() => setShowOmp(true)}
        onOpenTerminal={() => openTerminal("omp")}
      />

      {/* Below the graph, above the status bar: the expanded card, or the
          terminal — never both, see `setTerminal`. */}
      <Show when={state.expanded}>
        <ActivityDrawer />
      </Show>
      <TerminalDock
        open={terminalOpen()}
        onClose={() => setTerminal(false)}
        kind={terminalKind()}
        project={project()}
        onOpenSettings={() => setShowOmp(true)}
      />

      <OmpSettingsDialog
        open={showOmp()}
        onClose={() => setShowOmp(false)}
        onOpenTerminal={() => {
          setShowOmp(false)
          openTerminal("omp")
        }}
        onChanged={() => void reconnect()}
        pipeline={state.pipeline.name}
      />

      <Show when={showSkills()}>
        <SkillsPanel onClose={() => setShowSkills(false)} onNotice={notice} />
      </Show>

      <Show when={showMcp()}>
        <McpPanel onClose={() => setShowMcp(false)} onNotice={notice} />
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
      <Show when={state.questions[0] && requestKey(state.questions[0].sessionID, state.questions[0].requestID)} keyed>
        <QuestionDialog request={state.questions[0]!} onAnswer={actions.answerQuestion} />
      </Show>

      {/* A card is parked on this: nothing has been sent to it. One at a time,
          keyed on the failure so each gets a fresh dialog and a fresh focus restore. */}
      <Show when={state.upliftFailures[0]} keyed>
        {(failure) => (
          <UpliftFailureDialog
            failure={failure}
            waiting={state.upliftFailures.length - 1}
            onDecide={actions.resolveUpliftFailure}
          />
        )}
      </Show>

      <Show when={showProjectPicker()}>
        <ProjectPicker current={project()} onClose={() => setShowProjectPicker(false)} onSwitched={switchProject} />
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

      {/* Closes itself if verification is switched off underneath it, or if the
          canvas becomes a gauntlet, which ignores the setting entirely. */}
      <Show when={verifyOpen() && state.pipeline.verify && !gauntletOf(state.pipeline)}>
        <VerifyDialog
          pipeline={state.pipeline}
          onChange={actions.setVerifySetting}
          onClose={() => setVerifyOpen(false)}
        />
      </Show>

      {/* Closes itself if the alerts are switched off underneath it — the
          webhook field would then be editing a channel nothing sends on. */}
      <Show when={alertsOpen() && alertsOn()}>
        <AlertsDialog onClose={() => setAlertsOpen(false)} />
      </Show>

      <footer class="statusbar">
        <div class="statusbar-left">
          <span
            class="statusbar-dot"
            data-state={status().startsWith("offline") || !ompReady() ? "bad" : "ok"}
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
                {/* Without this a failed verdict reads as a broken run: every
                    card is green and the badge says error, with the reason only
                    on the reviewer's activity stream. */}
                <Show when={log().verdict}>
                  {(verdict) => (
                    <span
                      class="badge"
                      data-status={verdict().kind === "pass" ? "done" : "error"}
                      title={verdict().reason ?? ""}
                    >
                      {verdict().kind === "pass"
                        ? "verified"
                        : verdict().kind === "fail"
                          ? "did not meet the bar"
                          : "no verdict"}
                    </span>
                  )}
                </Show>
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
          {/*
            `search` is forced on rather than left to the menu's 8-row
            threshold: a row is a timestamp, so the run id, the canvas name and
            the cost are only reachable by typing them.
          */}
          <Select
            label="Runs"
            leading={<IconHistory />}
            variant="ghost"
            placement="top"
            align="end"
            // Wider than the 284px default: a row carries a timestamp, a
            // duration and a price, and the hint is ellipsised at half the row.
            width={460}
            // Opening a recording replaces everything the canvas shows, which a run in progress is still writing.
            disabled={state.running}
            title={state.running ? "recorded runs can be opened once the current run ends" : "reopen a recorded run"}
            value=""
            search
            options={runMenuOptions(runs(), state.pipeline.name, state.run?.id, tick())}
            onChange={(value) => void chooseRun(value)}
            empty="No runs recorded yet."
          />
          <button
            type="button"
            class="icon-btn statusbar-project"
            // The run is bound to the project it started in; the host refuses a switch too.
            disabled={state.running}
            title={
              state.running
                ? PROJECT_BUSY
                : `${project()} — click to choose a folder (right-click to browse in-app)`
            }
            aria-label="switch project"
            onClick={() => void pickProject()}
            onContextMenu={(event) => {
              event.preventDefault()
              if (state.running) return actions.notice("info", PROJECT_BUSY)
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

/** Parses untrusted file text; a malformed file yields `undefined`, not a throw. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
