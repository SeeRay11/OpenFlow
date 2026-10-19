import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { MemoryStatus } from "../../shared/memory"
import type { OmpConfigEntry, OmpSettingsView, ValidationError } from "../../shared/omp"
import { SWARM_ROUTES, type SwarmPreflight } from "../../shared/swarm"
import { memory, requestJson, type ClientResult } from "../server/memory-client"
import { omp, type OmpResult } from "../server/omp-config"
import { IconClose } from "./icons"
import { MemoryPanel } from "./memory-panel"
import { memoryLineView } from "./memory-panel-model"
import {
  COPY_LOGINS_LABEL,
  COPY_LOGINS_WARNING,
  FIELDS,
  SECTIONS,
  TABS,
  buildPatch,
  canCopyLogins,
  copyLoginsOutcome,
  describedBy,
  dirtyPaths,
  displayValue,
  effectiveLines,
  entryDirty,
  entryDraft,
  entryInput,
  errorId,
  errorMap,
  escapeStep,
  fieldId,
  formErrors,
  groupEntries,
  hintId,
  parseEntry,
  problemActions,
  readOnlyReason,
  remoteFrom,
  searchEntries,
  statusRows,
  statusSummary,
  swarmView,
  tabTarget,
  toDraft,
  trapTarget,
  type CopyOutcome,
  type CopyStep,
  type Draft,
  type DraftValue,
  type Field,
  type Remote,
  type StatusTone,
  type Tab,
} from "./omp-settings-model"
import "./omp-settings.css"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * One fetch as a four-way state. A response that arrives after the dialog closed
 * (or after a newer request) is dropped instead of written into a dead scope.
 */
function createRemote<T>(fetcher: () => Promise<OmpResult<T>>) {
  const [remote, setRemote] = createSignal<Remote<T>>({ state: "loading" })
  let latest = 0
  let alive = true
  onCleanup(() => {
    alive = false
  })
  async function load(): Promise<Remote<T>> {
    const mine = ++latest
    setRemote({ state: "loading" })
    const next = remoteFrom(await fetcher())
    if (alive && mine === latest) setRemote(next)
    return next
  }
  return [remote, load, setRemote] as const
}

function RemoteView<T>(props: {
  remote: Remote<T>
  label: string
  retry: () => void
  empty?: (value: T) => boolean
  emptyText?: string
  children: (value: T) => JSX.Element
}) {
  const content = () => {
    const remote = props.remote
    if (remote.state === "loading")
      return (
        <p class="omp-note" role="status">
          Loading {props.label}…
        </p>
      )
    if (remote.state === "disconnected" || remote.state === "error") {
      return (
        <div class="omp-alert" role="alert">
          <span>
            {remote.state === "disconnected"
              ? `${remote.message} Check that OpenFlow is still running, then retry.`
              : `Could not load ${props.label}: ${remote.message}`}
          </span>
          <button type="button" class="oc-button" onClick={props.retry}>
            Retry
          </button>
        </div>
      )
    }
    if (props.empty?.(remote.value)) return <p class="omp-note">{props.emptyText}</p>
    return props.children(remote.value)
  }
  return <>{content()}</>
}

/** One status sentence: a degradation is a warning (cards still run), a check that could not be made is an alert. */
function ToneLine(props: { tone: StatusTone; text: string }) {
  if (props.tone === "error")
    return (
      <p class="omp-alert" role="alert">
        <span>{props.text}</span>
      </p>
    )
  return <p class={props.tone === "warning" ? "omp-warning" : "omp-note"}>{props.text}</p>
}

export type OmpSettingsDialogProps = {
  open: boolean
  onClose: () => void
  /** Show the in-app terminal. The dialog closes itself right after, and does not take focus back from it. */
  onOpenTerminal: () => void
  /** Called after OpenFlow's Omp settings or one of omp's own options changed. */
  onChanged?: () => void
  /** The pipeline whose memory the Memory tab lists and forgets. Without one the tab shows only the memory status. */
  pipeline?: string
}

/**
 * Omp status, how cards run it, and omp's own options.
 *
 * Modal: focus moves in on open and returns to the opener on close, Tab cycles
 * inside the dialog, and Escape steps back one level (leave an edited option,
 * then clear the search, then close). The logic worth testing lives in
 * `omp-settings-model.ts`; this file binds it to elements.
 */
export function OmpSettingsDialog(props: OmpSettingsDialogProps) {
  return (
    <Show when={props.open}>
      <Dialog
        onClose={props.onClose}
        onOpenTerminal={props.onOpenTerminal}
        onChanged={props.onChanged}
        pipeline={props.pipeline}
      />
    </Show>
  )
}

function Dialog(props: Omit<OmpSettingsDialogProps, "open">) {
  const opener = document.activeElement
  let restoreFocus = true
  let dialog!: HTMLElement
  let searchInput: HTMLInputElement | undefined
  let configRequested = false

  const [tab, setTab] = createSignal<Tab>("status")
  const [announcement, setAnnouncement] = createSignal("")

  const [status, loadOmpStatus] = createRemote(() => omp.status())
  const [swarm, setSwarm] = createSignal<ClientResult<SwarmPreflight>>()
  const [memoryStatus, setMemoryStatus] = createSignal<ClientResult<MemoryStatus>>()
  const swarmLine = createMemo(() => swarmView(swarm()))
  const memoryLine = createMemo(() => memoryLineView(memoryStatus()))
  let extrasRequest = 0
  let closed = false
  const [copyStep, setCopyStep] = createSignal<CopyStep>("idle")
  const [copyResult, setCopyResult] = createSignal<CopyOutcome>()
  let copyButton: HTMLButtonElement | undefined
  let copyCancel: HTMLButtonElement | undefined
  let checkButton: HTMLButtonElement | undefined
  const [settings, loadSettings, setSettings] = createRemote(() => omp.settings())
  const [config, loadConfig, setConfig] = createRemote(() => omp.config())

  // Cards tab
  const [draft, setDraft] = createSignal<Draft>({})
  const [errors, setErrors] = createSignal<ValidationError[]>([])
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal("")
  const [confirmReset, setConfirmReset] = createSignal(false)

  // Omp options tab
  const [query, setQuery] = createSignal("")
  const [drafts, setDrafts] = createSignal<Record<string, DraftValue>>({})
  const [rowErrors, setRowErrors] = createSignal<Record<string, string>>({})
  const [busyRows, setBusyRows] = createSignal<Record<string, boolean>>({})
  const [openGroups, setOpenGroups] = createSignal<Record<string, boolean>>({})

  const fieldErrors = createMemo(() => errorMap(errors()))
  const summaryOk = () => {
    const current = status()
    return current.state === "ready" ? current.value.problems.length === 0 : current.state === "loading"
  }
  const dirty = createMemo(() => {
    const current = settings()
    return current.state === "ready" && dirtyPaths(current.value.settings, draft()).length > 0
  })

  onCleanup(() => {
    closed = true
    if (restoreFocus && opener instanceof HTMLElement && opener.isConnected) opener.focus()
  })

  /** Omp's own status plus the two checks that depend on OpenFlow's settings: the swarm preflight and shared memory. */
  async function loadStatus() {
    const mine = ++extrasRequest
    setSwarm(undefined)
    setMemoryStatus(undefined)
    const [, nextSwarm, nextMemory] = await Promise.all([
      loadOmpStatus(),
      requestJson<SwarmPreflight>((input, init) => fetch(input, init), SWARM_ROUTES.preflight),
      memory.status(),
    ])
    if (closed || mine !== extrasRequest) return
    setSwarm(nextSwarm)
    setMemoryStatus(nextMemory)
  }

  onMount(() => {
    void loadStatus()
    void adoptSettings(loadSettings())
    document.getElementById(`omp-tab-${tab()}`)?.focus()
  })

  async function adoptSettings(pending: Promise<Remote<OmpSettingsView>>) {
    const next = await pending
    if (next.state === "ready") setDraft(toDraft(next.value.settings))
  }

  function select(next: Tab) {
    setTab(next)
    if (next === "options" && !configRequested) {
      configRequested = true
      void loadConfig()
    }
  }

  function openTerminal() {
    // The terminal takes focus; handing it back to the titlebar button would steal it.
    restoreFocus = false
    props.onOpenTerminal()
    props.onClose()
  }

  // --------------------------------------------------------- copy logins

  function askCopy() {
    setCopyStep("confirm")
    queueMicrotask(() => copyCancel?.focus())
  }

  function cancelCopy() {
    setCopyStep("idle")
    queueMicrotask(() => copyButton?.focus())
  }

  async function copyLogins() {
    setCopyStep("running")
    setCopyResult(undefined)
    const outcome = copyLoginsOutcome(await omp.importAuth())
    if (closed) return
    setCopyStep("idle")
    setCopyResult(outcome)
    setAnnouncement(outcome.text)
    if (!outcome.ok) {
      queueMicrotask(() => copyButton?.focus())
      return
    }
    await loadStatus()
    if (!closed) checkButton?.focus()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      const target = event.target instanceof HTMLElement ? event.target : undefined
      const row = target?.closest<HTMLElement>("[data-omp-key]")
      const onOptions = tab() === "options"
      const step = escapeStep({ editing: onOptions && row?.dataset.dirty === "true", query: onOptions ? query() : "" })
      if (step === "cancel-edit" && row?.dataset.ompKey) revertRow(row.dataset.ompKey)
      else if (step === "clear-search") {
        setQuery("")
        searchInput?.focus()
      } else if (step === "close") props.onClose()
      return
    }
    if (event.key !== "Tab") return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[hidden]"))
    const current = document.activeElement instanceof HTMLElement ? focusable.indexOf(document.activeElement) : -1
    const next = trapTarget(current, focusable.length, event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    focusable[next]?.focus()
  }

  // ------------------------------------------------------------------ cards

  function setField(path: string, value: DraftValue) {
    setDraft((current) => ({ ...current, [path]: value }))
    setErrors((current) => current.filter((error) => error.path !== path))
    setSaved("")
  }

  function focusFirstInvalid(list: ValidationError[]) {
    const map = errorMap(list)
    const first = FIELDS.find((field) => map[field.path])
    if (first) document.getElementById(fieldId(first.path))?.focus()
  }

  async function save(event: Event) {
    event.preventDefault()
    const current = settings()
    if (current.state !== "ready" || saving()) return
    const built = buildPatch(current.value.settings, draft())
    if (built.errors.length) {
      setErrors(built.errors)
      focusFirstInvalid(built.errors)
      return
    }
    setSaving(true)
    const result = await omp.saveSettings(built.patch)
    setSaving(false)
    if (!result.ok) {
      setErrors(result.errors)
      focusFirstInvalid(result.errors)
      return
    }
    adopt(result.value, "Saved.")
    void loadStatus()
  }

  async function reset() {
    if (!confirmReset()) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    setSaving(true)
    const result = await omp.resetSettings()
    setSaving(false)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    adopt(result.value, "Reset to the defaults.")
    void loadStatus()
  }

  function adopt(view: OmpSettingsView, message: string) {
    setSettings({ state: "ready", value: view })
    setDraft(toDraft(view.settings))
    setErrors([])
    setSaved(message)
    setAnnouncement(message)
    props.onChanged?.()
  }

  function discard() {
    const current = settings()
    if (current.state !== "ready") return
    setDraft(toDraft(current.value.settings))
    setErrors([])
    setSaved("")
  }

  // ---------------------------------------------------------------- options

  const draftOf = (entry: OmpConfigEntry): DraftValue => drafts()[entry.key] ?? entryDraft(entry)

  function setRowDraft(entry: OmpConfigEntry, value: DraftValue) {
    setDrafts((current) => ({ ...current, [entry.key]: value }))
    setRowErrors((current) => ({ ...current, [entry.key]: "" }))
  }

  function revertRow(key: string) {
    setDrafts((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setRowErrors((current) => ({ ...current, [key]: "" }))
  }

  function replaceEntry(entry: OmpConfigEntry) {
    setConfig((current) =>
      current.state === "ready"
        ? { state: "ready", value: current.value.map((item) => (item.key === entry.key ? entry : item)) }
        : current,
    )
    revertRow(entry.key)
  }

  async function mutateRow(entry: OmpConfigEntry, run: () => Promise<OmpResult<OmpConfigEntry>>, done: string) {
    setBusyRows((current) => ({ ...current, [entry.key]: true }))
    const result = await run()
    setBusyRows((current) => ({ ...current, [entry.key]: false }))
    if (!result.ok) {
      setRowErrors((current) => ({ ...current, [entry.key]: result.errors.map((error) => error.message).join(" ") }))
      return
    }
    replaceEntry(result.value)
    setAnnouncement(`${entry.key} ${done}.`)
    props.onChanged?.()
  }

  function saveRow(entry: OmpConfigEntry) {
    const parsed = parseEntry(entry, draftOf(entry))
    if (!parsed.ok) {
      setRowErrors((current) => ({ ...current, [entry.key]: parsed.message }))
      return
    }
    void mutateRow(entry, () => omp.setConfig(entry.key, parsed.value), "saved")
  }

  function resetRow(entry: OmpConfigEntry) {
    void mutateRow(entry, () => omp.resetConfig(entry.key), "reset to its default")
  }

  // ------------------------------------------------------------------ views

  function StatusTab() {
    return (
      <div class="omp-stack">
        <p class="omp-summary" role="status" aria-live="polite" data-ok={summaryOk()}>
          {(() => {
            const current = status()
            if (current.state === "ready") return statusSummary(current.value)
            if (current.state === "loading") return "Checking omp…"
            return current.message
          })()}
        </p>
        <Show when={copyResult()}>
          {(result) => (
            <p class="omp-note" data-failed={!result().ok}>
              {result().text}
            </p>
          )}
        </Show>
        <RemoteView remote={status()} label="omp status" retry={() => void loadStatus()}>
          {(value) => (
            <>
              <For each={value.warnings}>{(warning) => <p class="omp-warning">{warning}</p>}</For>
              <dl class="omp-facts">
                <For each={statusRows(value)}>
                  {(row) => (
                    <>
                      <dt>{row.label}</dt>
                      <dd data-ok={row.ok}>{row.value}</dd>
                    </>
                  )}
                </For>
              </dl>
              <Show when={value.problems.length}>
                <ul class="omp-problems" aria-label="Problems">
                  <For each={value.problems}>
                    {(problem) => (
                      <li>
                        <strong>{problem.message}</strong>
                        <Show when={problem.fix}>
                          <p>{problem.fix}</p>
                        </Show>
                        <Show when={canCopyLogins(value, problem)}>
                          <Show
                            when={copyStep() !== "idle"}
                            fallback={
                              <div class="omp-actions">
                                <button type="button" class="oc-button" ref={copyButton} onClick={askCopy}>
                                  {COPY_LOGINS_LABEL}
                                </button>
                              </div>
                            }
                          >
                            <div
                              class="mem-confirm"
                              role="group"
                              aria-labelledby="omp-copy-title"
                              onKeyDown={(event) => {
                                if (event.key !== "Escape") return
                                // The dialog's Escape closes the whole dialog; here it only backs out of the confirm.
                                event.preventDefault()
                                event.stopPropagation()
                                if (copyStep() === "confirm") cancelCopy()
                              }}
                            >
                              <strong id="omp-copy-title">Copy your logins into the OpenFlow profile?</strong>
                              <p>{COPY_LOGINS_WARNING}</p>
                              <div class="mem-actions">
                                <button type="button" class="oc-button" disabled={copyStep() === "running"} onClick={() => void copyLogins()}>
                                  {copyStep() === "running" ? "Copying…" : "Copy logins"}
                                </button>
                                <button type="button" class="oc-button" ref={copyCancel} disabled={copyStep() === "running"} onClick={cancelCopy}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </Show>
                        </Show>
                        <div class="omp-actions">
                          <For each={problemActions(problem)}>
                            {(action) => (
                              <button
                                type="button"
                                class="oc-button"
                                onClick={() => (action === "terminal" ? openTerminal() : select("cards"))}
                              >
                                {action === "terminal" ? "Open terminal" : "Open Cards settings"}
                              </button>
                            )}
                          </For>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="omp-actions">
                <button type="button" class="oc-button" ref={checkButton} onClick={() => void loadStatus()}>
                  Check again
                </button>
                <button type="button" class="oc-button" onClick={openTerminal}>
                  Open terminal
                </button>
              </div>
            </>
          )}
        </RemoteView>
        <section class="mem-subsection" aria-labelledby="omp-swarm-title">
          <h3 class="mem-subhead" id="omp-swarm-title">
            Agent swarm
          </h3>
          <ToneLine tone={swarmLine().tone} text={swarmLine().text} />
          <Show when={swarmLine().problems.length}>
            <ul class="omp-problems" aria-label="Swarm problems">
              <For each={swarmLine().problems}>
                {(problem) => (
                  <li>
                    <strong>{problem.message}</strong>
                    <Show when={problem.fix}>
                      <p>{problem.fix}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <section class="mem-subsection" aria-labelledby="omp-memory-title">
          <h3 class="mem-subhead" id="omp-memory-title">
            Shared memory
          </h3>
          <ToneLine tone={memoryLine().tone} text={memoryLine().text} />
        </section>
      </div>
    )
  }

  function FieldRow(row: { field: Field }) {
    const field = row.field
    const id = fieldId(field.path)
    const error = () => fieldErrors()[field.path]
    const value = () => draft()[field.path]
    const describe = () => describedBy(field, error())
    return (
      <div class="omp-field">
        <Show
          when={field.kind !== "toggle"}
          fallback={
            <label class="omp-toggle">
              <input
                id={id}
                type="checkbox"
                checked={value() === true}
                aria-invalid={error() ? "true" : undefined}
                aria-describedby={describe()}
                onChange={(event) => setField(field.path, event.currentTarget.checked)}
              />
              <span>{field.label}</span>
            </label>
          }
        >
          <label for={id}>{field.label}</label>
          <Show
            when={field.kind === "choice"}
            fallback={
              <input
                id={id}
                type="text"
                inputmode={field.kind === "number" ? "numeric" : undefined}
                value={String(value() ?? "")}
                placeholder={field.placeholder}
                spellcheck={false}
                autocomplete="off"
                aria-invalid={error() ? "true" : undefined}
                aria-describedby={describe()}
                onInput={(event) => setField(field.path, event.currentTarget.value)}
              />
            }
          >
            <select
              id={id}
              aria-invalid={error() ? "true" : undefined}
              aria-describedby={describe()}
              onChange={(event) => setField(field.path, event.currentTarget.value)}
            >
              <For each={field.choices}>
                {(choice) => (
                  <option value={choice.value} selected={String(value()) === choice.value}>
                    {choice.label}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </Show>
        <Show when={field.hint}>
          <p class="omp-hint" id={hintId(field.path)}>
            {field.hint}
          </p>
        </Show>
        <Show when={error()}>
          <p class="omp-error" id={errorId(field.path)}>
            {error()}
          </p>
        </Show>
      </div>
    )
  }

  function CardsTab() {
    return (
      <RemoteView remote={settings()} label="card settings" retry={() => void adoptSettings(loadSettings())}>
        {(view) => (
          <form class="oc-form omp-form omp-stack" onSubmit={save} novalidate aria-label="Card settings">
            <p class="omp-note">How every card's omp session is started. Saved on this machine; no secrets are stored here.</p>
            <For each={view.warnings}>{(warning) => <p class="omp-warning">{warning}</p>}</For>
            <For each={SECTIONS}>
              {(section) => (
                <fieldset class="omp-fieldset">
                  <legend>{section.title}</legend>
                  <For each={section.fields}>{(field) => <FieldRow field={field} />}</For>
                </fieldset>
              )}
            </For>
            <Show when={formErrors(errors()).length}>
              <div class="omp-alert" role="alert">
                <span>{formErrors(errors()).join(" ")}</span>
              </div>
            </Show>
            <section aria-labelledby="omp-effective-title">
              <h3 id="omp-effective-title" class="omp-note">
                What cards use today (saved values)
              </h3>
              <ul class="omp-effective">
                <For each={effectiveLines(view)}>
                  {(line) => (
                    <li>
                      <strong>{line.label}</strong>: {line.text}
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <div class="oc-form-actions omp-sticky">
              <button type="submit" class="oc-button oc-primary" disabled={!dirty() || saving()}>
                Save
              </button>
              <button type="button" class="oc-button" disabled={!dirty() || saving()} onClick={discard}>
                Discard changes
              </button>
              <button
                type="button"
                class="oc-button oc-danger"
                disabled={saving()}
                onClick={() => void reset()}
                onBlur={() => setConfirmReset(false)}
              >
                {confirmReset() ? "Confirm reset to defaults" : "Reset to defaults"}
              </button>
              <span class="omp-saved" role="status" aria-live="polite">
                {saved() || (dirty() ? "Unsaved changes." : "")}
              </span>
            </div>
          </form>
        )}
      </RemoteView>
    )
  }

  function OptionRow(item: { entry: OmpConfigEntry }) {
    const entry = item.entry
    const rid = `omp-opt-${entry.key.replace(/[^A-Za-z0-9_-]/g, "_")}`
    const input = entryInput(entry)
    const error = () => rowErrors()[entry.key]
    const rowDirty = () => input !== "readonly" && entryDirty(entry, draftOf(entry))
    const busy = () => busyRows()[entry.key] === true
    const describe = () => [error() ? `${rid}-error` : undefined, entry.description ? `${rid}-desc` : undefined].filter(Boolean).join(" ") || undefined
    const text = () => String(draftOf(entry))
    return (
      <li class="omp-row" data-omp-key={entry.key} data-dirty={rowDirty()}>
        <div class="omp-row-info">
          <span class="omp-key" id={`${rid}-key`}>
            {entry.key}
            <span class="oc-tag">{entry.type}</span>
            <Show when={entry.redacted}>
              <span class="oc-tag">set</span>
            </Show>
          </span>
          <Show when={entry.description}>
            <span class="omp-hint" id={`${rid}-desc`}>
              {entry.description}
            </span>
          </Show>
        </div>
        <div class="omp-row-edit">
          <Show when={input === "readonly"}>
            <span class="omp-value">{displayValue(entry)}</span>
            <span class="omp-hint">{readOnlyReason(entry)}</span>
            <div class="omp-row-actions">
              <button type="button" class="oc-button" onClick={openTerminal}>
                Open terminal
              </button>
              <button type="button" class="oc-button" disabled={busy()} onClick={() => resetRow(entry)}>
                Reset
              </button>
            </div>
          </Show>
          <Show when={input !== "readonly"}>
            <Show when={input === "toggle"}>
              <label class="omp-toggle">
                <input
                  id={rid}
                  type="checkbox"
                  checked={draftOf(entry) === true}
                  disabled={busy()}
                  aria-labelledby={`${rid}-key`}
                  aria-describedby={describe()}
                  onChange={(event) => setRowDraft(entry, event.currentTarget.checked)}
                />
                <span>{draftOf(entry) === true ? "On" : "Off"}</span>
              </label>
            </Show>
            <Show when={input === "choice"}>
              <select
                id={rid}
                disabled={busy()}
                aria-labelledby={`${rid}-key`}
                aria-describedby={describe()}
                aria-invalid={error() ? "true" : undefined}
                onChange={(event) => setRowDraft(entry, event.currentTarget.value)}
              >
                <For each={entry.options}>
                  {(option) => (
                    <option value={option} selected={text() === option}>
                      {option}
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <Show when={input === "number" || input === "text"}>
              <input
                id={rid}
                type="text"
                inputmode={input === "number" ? "numeric" : undefined}
                value={text()}
                disabled={busy()}
                spellcheck={false}
                autocomplete="off"
                aria-labelledby={`${rid}-key`}
                aria-describedby={describe()}
                aria-invalid={error() ? "true" : undefined}
                onInput={(event) => setRowDraft(entry, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && rowDirty()) {
                    event.preventDefault()
                    saveRow(entry)
                  }
                }}
              />
            </Show>
            <Show when={error()}>
              <p class="omp-error" id={`${rid}-error`}>
                {error()}
              </p>
            </Show>
            <div class="omp-row-actions">
              <button type="button" class="oc-button oc-primary" disabled={!rowDirty() || busy()} onClick={() => saveRow(entry)}>
                Save
              </button>
              <button type="button" class="oc-button" disabled={busy()} onClick={() => resetRow(entry)}>
                Reset
              </button>
            </div>
          </Show>
        </div>
      </li>
    )
  }

  function OptionsTab() {
    return (
      <div class="omp-stack">
        <div class="omp-search">
          <label for="omp-option-search">Search omp options</label>
          <input
            id="omp-option-search"
            ref={searchInput}
            type="search"
            value={query()}
            placeholder="Key, description or category"
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <RemoteView
          remote={config()}
          label="omp options"
          retry={() => void loadConfig()}
          empty={(entries) => entries.length === 0}
          emptyText="omp reported no options."
        >
          {(entries) => {
            const matches = createMemo(() => searchEntries(entries, query()))
            const groups = createMemo(() => groupEntries(matches()))
            return (
              <>
                <p class="omp-count" role="status" aria-live="polite">
                  {matches().length} of {entries.length} options
                </p>
                <Show when={groups().length === 0}>
                  <p class="omp-note">No option matches “{query()}”.</p>
                </Show>
                <For each={groups()}>
                  {(group, index) => {
                    const open = () => query().trim() !== "" || openGroups()[group.group] === true
                    const listId = `omp-group-${index()}`
                    return (
                      <section>
                        <h3 class="omp-group-head">
                          <button
                            type="button"
                            class="omp-group-toggle"
                            aria-expanded={open()}
                            aria-controls={listId}
                            onClick={() => setOpenGroups((current) => ({ ...current, [group.group]: !open() }))}
                          >
                            <span class="omp-chevron" aria-hidden="true">
                              ›
                            </span>
                            {group.group}
                            <span class="oc-tag">{group.entries.length}</span>
                          </button>
                        </h3>
                        <ul class="omp-rows" id={listId} hidden={!open()}>
                          <Show when={open()}>
                            <For each={group.entries}>{(entry) => <OptionRow entry={entry} />}</For>
                          </Show>
                        </ul>
                      </section>
                    )
                  }}
                </For>
              </>
            )
          }}
        </RemoteView>
      </div>
    )
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section
        class="oc-dialog omp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="omp-dialog-title"
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <header class="oc-dialog-head">
          <h2 id="omp-dialog-title">Omp settings</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>
        <div class="omp-tabs" role="tablist" aria-label="Omp settings sections">
          <For each={TABS}>
            {(item, index) => (
              <button
                type="button"
                role="tab"
                class="omp-tab"
                id={`omp-tab-${item.id}`}
                aria-selected={tab() === item.id}
                aria-controls={`omp-panel-${item.id}`}
                tabindex={tab() === item.id ? 0 : -1}
                onClick={() => select(item.id)}
                onKeyDown={(event) => {
                  const target = tabTarget(index(), TABS.length, event.key)
                  if (target === undefined) return
                  event.preventDefault()
                  const next = TABS[target]!.id
                  select(next)
                  document.getElementById(`omp-tab-${next}`)?.focus()
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
        <div
          class="omp-panel"
          role="tabpanel"
          id={`omp-panel-${tab()}`}
          aria-labelledby={`omp-tab-${tab()}`}
          tabindex="0"
        >
          <Show when={tab() === "status"}>
            <StatusTab />
          </Show>
          <Show when={tab() === "cards"}>
            <CardsTab />
          </Show>
          <Show when={tab() === "memory"}>
            <MemoryPanel pipeline={props.pipeline} />
          </Show>
          <Show when={tab() === "options"}>
            <OptionsTab />
          </Show>
        </div>
        <p class="omp-sr" role="status" aria-live="polite">
          {announcement()}
        </p>
      </section>
    </div>
  )
}
