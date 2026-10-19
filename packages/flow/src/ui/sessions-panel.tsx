import { For, Show, createEffect, createSignal, on, onCleanup, createMemo } from "solid-js"
import * as api from "../server/client"
import { latest } from "../server/latest"
import { formatAge, matches, sessionLabel, type SessionRow, type Turn } from "../server/sessions"
import { state } from "../state"
import { IconBack, IconRestart, IconSearch } from "./icons"

/**
 * The sessions column.
 *
 * Every OpenFlow node is one Omp session owned by the host, and the rows listed
 * here come from `api.sessions()` with a session's turns from
 * `api.sessionTranscript()` — not from a parallel history kept in the browser.
 * A session a card started shows up in the list while the host holds it.
 *
 * The panel is collapsible because the canvas is the app: 240px is cheap on a
 * wide screen and not on a laptop, and a history sidebar is a thing you consult
 * rather than watch.
 */
export function SessionsPanel(props: { project: string; onClose: () => void }) {
  const [query, setQuery] = createSignal("")
  const [rows, setRows] = createSignal<SessionRow[]>([])
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [open, setOpen] = createSignal<SessionRow>()
  const [turns, setTurns] = createSignal<Turn[]>()
  const [now, setNow] = createSignal(Date.now())
  const listing = latest()
  const opening = latest()

  // Ages are relative, so a list left open goes wrong without a clock of its
  // own — nothing else here changes between runs.
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(clock))

  async function refresh() {
    // The newest call owns the list and the spinner: an older list (the previous project's) landing late, or finishing first, must not overwrite or clear them.
    const current = listing.begin()
    setLoading(true)
    try {
      const loaded = await api.sessions()
      if (!current()) return
      setRows(loaded)
      setError(undefined)
    } catch (failure) {
      if (!current()) return
      setError(api.describe(failure))
    }
    setLoading(false)
  }

  // Re-fetched when the project changes or a run starts or ends — a run is
  // precisely the thing that adds sessions, and a list still showing the state
  // from before it is worse than an empty one. Typing does *not* refetch: the
  // filter is local (see `api.sessions`), so it costs nothing and never lags.
  createEffect(() => {
    props.project
    state.running
    void refresh()
  })

  /** Shows one session's turns, or goes back to the list with no row. Only the newest call may write: a slower, older answer must not land under another row's header. */
  async function openSession(row?: SessionRow) {
    const current = opening.begin()
    setOpen(row)
    setTurns(undefined)
    if (!row) return
    try {
      const loaded = await api.sessionTranscript(row.id)
      if (current()) setTurns(loaded)
    } catch (failure) {
      if (!current()) return
      setError(api.describe(failure))
      setTurns([])
    }
  }

  // A transcript belongs to the project it was read from.
  createEffect(on(() => props.project, () => void openSession(), { defer: true }))

  const visible = createMemo(() => rows().filter((row) => matches(row, query())))

  return (
    <aside class="panel sessions">
      <Show
        when={!open()}
        fallback={
          <>
            <div class="row">
              <button
                class="icon-btn"
                type="button"
                title="back to the session list"
                aria-label="back to the session list"
                onClick={() => void openSession()}
              >
                <IconBack />
              </button>
              <h2 class="panel-title">{sessionLabel(open()!)}</h2>
            </div>
            <p class="hint session-meta">
              <span class="mono">{open()!.id}</span>
              <Show when={open()!.agent}>{(agent) => <span>{agent()}</span>}</Show>
              <Show when={open()!.model}>{(model) => <span class="mono">{model()}</span>}</Show>
            </p>
            <div class="session-transcript">
              <Show when={turns()} fallback={<p class="hint">loading…</p>}>
                {(list) => (
                  <Show when={list().length} fallback={<p class="hint">This session has no text turns.</p>}>
                    <For each={list()}>
                      {(turn) => (
                        <div class={`session-turn session-turn-${turn.role}`}>
                          <span class="session-turn-role">{turn.role}</span>
                          <p class="session-turn-text">{turn.text}</p>
                        </div>
                      )}
                    </For>
                  </Show>
                )}
              </Show>
            </div>
          </>
        }
      >
        <div class="row">
          <h2 class="panel-title">sessions</h2>
          <button
            class="icon-btn"
            type="button"
            title="reload the session list"
            aria-label="reload the session list"
            onClick={() => void refresh()}
          >
            <IconRestart />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="hide the sessions panel"
            aria-label="hide the sessions panel"
            onClick={props.onClose}
          >
            <IconBack />
          </button>
        </div>

        <div class="oc-menu-search session-search">
          <IconSearch />
          <input
            value={query()}
            placeholder="Search sessions…"
            spellcheck={false}
            autocomplete="off"
            aria-label="search sessions"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>

        <Show when={error()}>{(message) => <p class="hint session-error">{message()}</p>}</Show>

        <div class="session-list">
          <Show
            when={visible().length}
            fallback={
              <p class="hint">
                {loading() ? "loading…" : query() ? "No session matches that." : "No sessions in this project yet."}
              </p>
            }
          >
            <For each={visible()}>
              {(row) => (
                <button class="session-card" type="button" title={row.id} onClick={() => void openSession(row)}>
                  <span class="session-card-top">
                    <span class="session-card-title">{sessionLabel(row)}</span>
                    <span class="session-card-age">{formatAge(row.updated, now())}</span>
                  </span>
                  <span class="session-card-meta">
                    <Show when={row.parent}>
                      <span class="session-card-tag">subagent</span>
                    </Show>
                    {/* the agent is often the headline already; only repeat it when it is not */}
                    <Show when={row.agent && row.agent !== sessionLabel(row) ? row.agent : undefined}>
                      {(agent) => <span>{agent()}</span>}
                    </Show>
                    <Show when={row.model}>{(model) => <span class="mono">{model()}</span>}</Show>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
