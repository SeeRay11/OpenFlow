import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import type { MemoryEntriesResult, MemoryStatus } from "../../shared/memory"
import { memory, type ClientResult } from "../server/memory-client"
import {
  FORGET_WARNING,
  forgetOutcome,
  listSummary,
  listView,
  memoryHealth,
  statusFacts,
  type ForgetStep,
} from "./memory-panel-model"
import "./memory-panel.css"

export type MemoryPanelProps = {
  /** The pipeline whose entries are listed and forgotten. Without one the panel only shows the status. */
  pipeline?: string
}

/**
 * What Substrate shared memory is doing for this machine, and what it holds for
 * one pipeline. Forget is the honest kind: Substrate cannot delete, so it retracts
 * and OpenFlow stops reading; the confirm step says so before anything is written.
 */
export function MemoryPanel(props: MemoryPanelProps) {
  const [status, setStatus] = createSignal<ClientResult<MemoryStatus>>()
  const [entries, setEntries] = createSignal<ClientResult<MemoryEntriesResult>>()
  const [step, setStep] = createSignal<ForgetStep>("idle")
  const [live, setLive] = createSignal("")
  const [failed, setFailed] = createSignal(false)
  let forgetButton: HTMLButtonElement | undefined
  let cancelButton: HTMLButtonElement | undefined
  let latest = 0
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const view = () => listView(entries())
  const info = () => {
    const current = status()
    return current?.ok ? current.value : undefined
  }
  const failure = () => {
    const current = status()
    return current && !current.ok ? current.error : undefined
  }
  const ready = () => {
    const current = info()
    return current !== undefined && memoryHealth(current) === "ready"
  }

  /** A response that arrives after a newer request, or after the panel went away, is dropped. */
  async function load(announce: boolean) {
    const mine = ++latest
    const pipeline = props.pipeline
    setStatus(undefined)
    setEntries(undefined)
    if (announce) setLive(pipeline ? "Loading memory entries…" : "Loading memory status…")
    const [nextStatus, nextEntries] = await Promise.all([
      memory.status(),
      pipeline ? memory.entries({ pipeline }) : Promise.resolve(undefined),
    ])
    if (!alive || mine !== latest) return
    setStatus(nextStatus)
    setEntries(nextEntries)
    if (!announce) return
    setFailed(false)
    if (!nextStatus.ok) setLive(nextStatus.error)
    else if (pipeline) setLive(listSummary(listView(nextEntries), pipeline))
    else setLive("Memory status loaded.")
  }

  createEffect(
    on(
      () => props.pipeline,
      () => {
        setStep("idle")
        void load(true)
      },
    ),
  )

  function askForget() {
    setStep("confirm")
    queueMicrotask(() => cancelButton?.focus())
  }

  function cancelForget() {
    setStep("idle")
    queueMicrotask(() => forgetButton?.focus())
  }

  async function forget() {
    const pipeline = props.pipeline
    if (!pipeline) return
    setStep("running")
    const outcome = forgetOutcome(await memory.forget({ pipeline }))
    if (!alive) return
    setStep("idle")
    await load(false)
    if (!alive) return
    setFailed(!outcome.ok)
    setLive(outcome.text)
    forgetButton?.focus()
  }

  return (
    <div class="mem-panel">
      <div class="mem-toolbar">
        <h3 id="mem-title">Shared memory</h3>
        <button type="button" class="oc-button" onClick={() => void load(true)} disabled={step() === "running"}>
          Refresh
        </button>
      </div>

      <p class="mem-live" role="status" aria-live="polite" data-failed={failed()}>
        {live()}
      </p>

      <Show when={status()} fallback={<p class="mem-note">Loading memory status…</p>}>
        <Show
          when={info()}
          fallback={
            <div class="mem-alert" role="alert">
              <span>{failure()}</span>
              <button type="button" class="oc-button" onClick={() => void load(true)}>
                Retry
              </button>
            </div>
          }
        >
          {(value) => (
            <>
              <dl class="mem-facts" aria-labelledby="mem-title">
                <For each={statusFacts(value())}>
                  {(row) => (
                    <>
                      <dt>{row.label}</dt>
                      <dd data-ok={row.ok}>{row.value}</dd>
                    </>
                  )}
                </For>
              </dl>
              <Show when={value().problems.length}>
                <ul class="mem-problems" aria-label="Memory problems">
                  <For each={value().problems}>{(problem) => <li>{problem}</li>}</For>
                </ul>
              </Show>
              <p class="mem-retention">{value().retention.note}</p>
            </>
          )}
        </Show>
      </Show>

      <Show
        when={props.pipeline}
        fallback={<p class="mem-note">Entries are listed per pipeline: open this dialog from a pipeline to browse or forget its memory.</p>}
      >
        {(pipeline) => (
          <section class="mem-entries" aria-labelledby="mem-entries-title">
            <h4 id="mem-entries-title">
              Entries for <span class="mem-pipeline">{pipeline()}</span>
            </h4>
            {(() => {
              const current = view()
              switch (current.kind) {
                case "loading":
                  return <p class="mem-note">Loading entries…</p>
                case "error":
                  return <p class="mem-note">Entries could not be loaded: {current.message}</p>
                case "disabled":
                  return <p class="mem-note">Shared memory is off. Turn it on in the Cards tab to share memory across cards.</p>
                case "unavailable":
                  return <p class="mem-note">Substrate is unavailable, so entries cannot be listed. {current.message}</p>
                case "empty":
                  return <p class="mem-note">Nothing has been remembered for this pipeline yet. Cards write here when they finish.</p>
                case "rows":
                  return (
                    <ul class="mem-list" aria-label="Memory entries">
                      <For each={current.rows}>
                        {(row) => (
                          <li class="mem-entry" data-retracted={row.retracted}>
                            <div class="mem-entry-head">
                              <span class="mem-subject">{row.subject}</span>
                              <Show when={row.retracted}>
                                <span class="mem-tag">retracted: cards ignore it</span>
                              </Show>
                            </div>
                            <div class="mem-meta">
                              <span>{row.scope}</span>
                              <span>{row.age}</span>
                            </div>
                            <p class="mem-preview">{row.preview}</p>
                          </li>
                        )}
                      </For>
                    </ul>
                  )
              }
            })()}

            <div class="mem-forget">
              <Show
                when={step() !== "idle"}
                fallback={
                  <button type="button" class="oc-button oc-danger" ref={forgetButton} disabled={!ready()} onClick={askForget}>
                    Forget this pipeline's memory
                  </button>
                }
              >
                <div
                  class="mem-confirm"
                  role="group"
                  aria-labelledby="mem-confirm-title"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    // The dialog's Escape closes the whole dialog; here it only backs out of the confirm.
                    event.preventDefault()
                    event.stopPropagation()
                    if (step() === "confirm") cancelForget()
                  }}
                >
                  <strong id="mem-confirm-title">Forget everything remembered for {pipeline()}?</strong>
                  <p>{FORGET_WARNING}</p>
                  <div class="mem-actions">
                    <button type="button" class="oc-button oc-danger" disabled={step() === "running"} onClick={() => void forget()}>
                      {step() === "running" ? "Forgetting…" : "Forget"}
                    </button>
                    <button type="button" class="oc-button" ref={cancelButton} disabled={step() === "running"} onClick={cancelForget}>
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </section>
        )}
      </Show>
    </div>
  )
}
