import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { groupMatches, readyRows, searchModels, searchProviders, unlockedRows, type ProviderRow } from "../server/providers"
import { defaultModel, setDefaultModel } from "../graph/default-model"
import { state } from "../state"
import { IconChevron, IconClose, IconSearch, IconSliders } from "./icons"

/**
 * The model field: a 284px popover with a search row, provider headings, one
 * row per model, and a single action pinned under a divider at the bottom.
 * Arrow keys move, Enter picks, Escape closes, and typing filters — the pointer
 * never has to be involved.
 *
 * It will not offer a model whose provider Omp lists as logged out
 * ([../server/providers.ts], `unlockedRows`): that run would fail at the first
 * prompt. Such providers surface only when the query names them, as a pointer
 * to the terminal, because logging in happens in Omp, not here.
 */
export function ModelPicker(props: {
  value?: string
  rows: ProviderRow[]
  onChange: (value: string) => void
  onManage?: (query?: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal("")
  let root: HTMLDivElement | undefined
  let field: HTMLInputElement | undefined

  const CONNECT = "action:connect"
  const matches = createMemo(() => searchModels(props.rows, query()))
  const groups = createMemo(() => groupMatches(matches()))
  const unlocked = createMemo(() => unlockedRows(props.rows))
  const ready = createMemo(() => readyRows(props.rows))
  /**
   * Providers the query names but Omp reports as logged out.
   *
   * Searching "anthropic" without a login would otherwise answer "no models"
   * and leave the user to guess whether the provider exists, is misspelled, or
   * simply has no credentials — the one case where the empty list is not the
   * whole answer.
   */
  const lockedMatches = createMemo(() =>
    query().trim() ? searchProviders(props.rows.filter((row) => !row.unlocked), query()).slice(0, 3) : [],
  )
  const CLEAR = "action:clear"
  const DEFAULT = "action:default"
  /** Only offer "set as default" when a model is chosen and is not already it. */
  const canSetDefault = createMemo(() => Boolean(props.value) && props.value !== defaultModel())
  const keys = createMemo(() => [
    ...matches().map((model) => model.value),
    ...(props.value ? [CLEAR] : []),
    ...(canSetDefault() ? [DEFAULT] : []),
    CONNECT,
  ])

  function show() {
    if (props.disabled) return
    setQuery("")
    setOpen(true)
    setActive(props.value && matches().some((model) => model.value === props.value) ? props.value : (keys()[0] ?? ""))
    queueMicrotask(() => field?.focus())
  }

  function choose(value: string) {
    props.onChange(value)
    setOpen(false)
  }

  function connect(search?: string) {
    setOpen(false)
    props.onManage?.(search)
  }

  /** Pins the chosen model as the app-wide default for future new nodes. */
  function setAsDefault() {
    if (props.value) setDefaultModel(props.value)
    setOpen(false)
  }

  function move(step: number) {
    const options = keys()
    if (!options.length) return
    const index = options.indexOf(active())
    setActive(options[((index < 0 ? 0 : index) + step + options.length) % options.length])
    queueMicrotask(() =>
      root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active())}"]`)?.scrollIntoView({ block: "nearest" }),
    )
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") return setOpen(false)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      return move(event.key === "ArrowDown" ? 1 : -1)
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    if (active() === CONNECT) return connect()
    // "clear" carries a key of its own because the value it picks is "", which
    // a truthiness check would swallow.
    if (active() === CLEAR) return choose("")
    if (active() === DEFAULT) return setAsDefault()
    if (active()) choose(active())
  }

  const onPointerDown = (event: MouseEvent) => {
    if (!root || root.contains(event.target as Node)) return
    setOpen(false)
  }
  document.addEventListener("mousedown", onPointerDown)
  onCleanup(() => document.removeEventListener("mousedown", onPointerDown))

  return (
    <div class="oc-picker" ref={root}>
      <button
        type="button"
        class="oc-trigger"
        disabled={props.disabled}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        <span class="oc-trigger-label" classList={{ "oc-faint": !props.value }}>
          {props.value || "Agent default"}
        </span>
        <IconChevron />
      </button>

      <Show when={open()}>
        <div class="oc-menu">
          <div class="oc-menu-search">
            <IconSearch />
            <input
              ref={field}
              value={query()}
              placeholder="Search models…"
              spellcheck={false}
              autocomplete="off"
              autocapitalize="off"
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setActive(keys()[0] ?? "")
              }}
              onKeyDown={onKey}
            />
            <Show when={query()}>
              <button
                type="button"
                class="oc-clear"
                aria-label="Clear"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery("")
                  setActive(keys()[0] ?? "")
                  field?.focus()
                }}
              >
                <IconClose />
              </button>
            </Show>
          </div>

          <div class="oc-divider" />

          <div class="oc-menu-list">
            <Show
              when={matches().length}
              fallback={
                <>
                  {/*
                    An empty list has two very different causes and only one is
                    the user's to fix. With the host down the catalog could not
                    be read at all, so "nothing logged in" would be a wrong
                    answer pointing at the wrong place.
                  */}
                  <div class="oc-menu-empty">
                    <Show
                      when={state.hostReachable}
                      fallback={<>No models — the OpenFlow host is not answering. Reopen this menu once it is back.</>}
                    >
                      <Show when={unlocked().length} fallback={<>No provider logged in to Omp yet.</>}>
                        No models match “{query()}”.
                      </Show>
                    </Show>
                  </div>
                  <For each={lockedMatches()}>
                    {(row) => (
                      <button type="button" class="oc-item" onClick={() => connect(row.name)}>
                        <span class="oc-item-label oc-faint">{row.name}</span>
                        <span class="oc-tag">log in with the terminal</span>
                      </button>
                    )}
                  </For>
                </>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <>
                    <div class="oc-group">{group.providerName}</div>
                    <For each={group.models}>
                      {(model) => (
                        <button
                          type="button"
                          class="oc-item"
                          data-key={model.value}
                          data-active={active() === model.value ? true : undefined}
                          data-selected={props.value === model.value ? true : undefined}
                          title={model.value}
                          onMouseEnter={() => setActive(model.value)}
                          onClick={() => choose(model.value)}
                        >
                          <span class="oc-item-label">{model.name}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>

            <Show when={props.value}>
              <div class="oc-divider" />
              <button
                type="button"
                class="oc-item"
                data-key={CLEAR}
                data-active={active() === CLEAR ? true : undefined}
                onMouseEnter={() => setActive(CLEAR)}
                onClick={() => choose("")}
              >
                <span class="oc-item-label oc-faint">Agent default</span>
              </button>
            </Show>
          </div>

          <div class="oc-divider" />

          <Show when={canSetDefault()}>
            <button
              type="button"
              class="oc-item"
              data-key={DEFAULT}
              data-active={active() === DEFAULT ? true : undefined}
              onMouseEnter={() => setActive(DEFAULT)}
              onClick={setAsDefault}
            >
              <span class="oc-item-label">Set as default for new nodes</span>
            </button>
          </Show>

          <Show when={defaultModel()}>
            <div class="oc-group">default for new nodes: {defaultModel()}</div>
          </Show>

          <button
            type="button"
            class="oc-item"
            data-key={CONNECT}
            data-active={active() === CONNECT ? true : undefined}
            onMouseEnter={() => setActive(CONNECT)}
            onClick={() => connect()}
          >
            <IconSliders />
            <span class="oc-item-label">Manage models in Omp settings</span>
            <span class="oc-tag">{ready().length}</span>
          </button>
        </div>
      </Show>
    </div>
  )
}
