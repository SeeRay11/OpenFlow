import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js"
import { IconCheck, IconChevron, IconSearch } from "./icons"

export type SelectOption = {
  value: string
  label: string
  /** Muted text on the right of the row — a count, a status, a path. */
  hint?: string
  /** Small bordered pill on the right of the row. */
  tag?: string
  /** Heading this row sits under. Rows are grouped in first-seen order. */
  group?: string
  title?: string
  disabled?: boolean
}

/**
 * One dropdown, built as opencode's own menus are.
 *
 * The native `<select>` cannot be styled into opencode's popover — its list is
 * drawn by the OS — so every menu in OpenFlow goes through this instead:
 * a 28px trigger, a floating panel with 4px radius rows, a check on the row
 * that is selected, and ↑/↓/Enter/Escape wired the way
 * `packages/app/src/components/dialog-select-model.tsx` wires them. Search only
 * appears when the list is long enough to need it.
 *
 * It is fully controlled. Pass `value=""` on menus that are actions rather than
 * state (open a pipeline, open a run) and nothing sticks after the pick.
 */
export function Select(props: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Shown on the trigger when nothing is selected. */
  placeholder?: string
  /** Fixed trigger text, for menus that act rather than hold a value. */
  label?: string
  /** Prefix printed before the selected label on the trigger — "pipe: direct". */
  prefix?: string
  leading?: JSX.Element
  title?: string
  disabled?: boolean
  /** `field` reads as an input, `ghost` as a toolbar button. */
  variant?: "field" | "ghost"
  placement?: "bottom" | "top"
  align?: "start" | "end"
  /** Menu width in px. Defaults to opencode's 284px popover. */
  width?: number
  /** Force the search row on or off. Default: on above 8 options. */
  search?: boolean
  /** Row shown when the option list is empty. */
  empty?: string
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal("")
  const id = createUniqueId()
  let root: HTMLDivElement | undefined
  let field: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined

  const searchable = () => props.search ?? props.options.length > 8
  const matches = createMemo(() => {
    const text = query().trim().toLowerCase()
    if (!text) return props.options
    return props.options.filter((option) =>
      `${option.label} ${option.hint ?? ""} ${option.value}`.toLowerCase().includes(text),
    )
  })
  const groups = createMemo(() => {
    const order: string[] = []
    const byName = new Map<string, SelectOption[]>()
    for (const option of matches()) {
      const name = option.group ?? ""
      if (!byName.has(name)) {
        byName.set(name, [])
        order.push(name)
      }
      byName.get(name)!.push(option)
    }
    return order.map((name) => ({ name, options: byName.get(name)! }))
  })
  const keys = createMemo(() => matches().filter((option) => !option.disabled).map((option) => option.value))
  const selected = createMemo(() => props.options.find((option) => option.value === props.value))
  const text = () => props.label ?? `${props.prefix ?? ""}${selected()?.label ?? props.placeholder ?? ""}`
  /** Row ids exist for `aria-activedescendant`; values are not id-safe on their own. */
  const rowID = (value: string) => `${id}-row-${keys().indexOf(value)}`

  function show() {
    if (props.disabled) return
    setQuery("")
    setOpen(true)
    setActive(props.value && keys().includes(props.value) ? props.value : (keys()[0] ?? ""))
    // Focus has to land somewhere inside the menu or the arrow keys have no
    // listener to reach: the trigger's own handler stands down while the menu
    // is open. The search row takes it when there is one, the list itself when
    // there is not.
    queueMicrotask(() => {
      if (searchable()) field?.focus()
      else list?.focus()
      scrollToActive()
    })
  }

  function scrollToActive() {
    root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active())}"]`)?.scrollIntoView({ block: "nearest" })
  }

  function choose(value: string) {
    setOpen(false)
    props.onChange(value)
  }

  function move(step: number) {
    const options = keys()
    if (!options.length) return
    const index = options.indexOf(active())
    setActive(options[((index < 0 ? 0 : index) + step + options.length) % options.length]!)
    queueMicrotask(scrollToActive)
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      return move(event.key === "ArrowDown" ? 1 : -1)
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      const options = keys()
      if (!options.length) return
      setActive(event.key === "Home" ? options[0]! : options[options.length - 1]!)
      return queueMicrotask(scrollToActive)
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    // Membership, not truthiness — "" is a real value ("(server default)").
    if (keys().includes(active())) choose(active())
  }

  const onPointerDown = (event: MouseEvent) => {
    if (!root || root.contains(event.target as Node)) return
    setOpen(false)
  }
  document.addEventListener("mousedown", onPointerDown)
  onCleanup(() => document.removeEventListener("mousedown", onPointerDown))

  return (
    <div
      class="oc-picker"
      classList={{ "oc-picker-top": props.placement === "top", "oc-picker-end": props.align === "end" }}
      ref={root}
    >
      <button
        type="button"
        class="oc-trigger"
        classList={{ "oc-trigger-ghost": props.variant === "ghost" }}
        title={props.title}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (open() || (event.key !== "ArrowDown" && event.key !== "Enter")) return
          event.preventDefault()
          show()
        }}
      >
        {props.leading}
        <span class="oc-trigger-label" classList={{ "oc-faint": !props.label && !selected() }}>
          {text()}
        </span>
        <IconChevron />
      </button>

      <Show when={open()}>
        <div class="oc-menu" style={{ "--oc-menu-width": `${props.width ?? 284}px` }}>
          <Show when={searchable()}>
            <div class="oc-menu-search">
              <IconSearch />
              <input
                ref={field}
                value={query()}
                placeholder="Search…"
                spellcheck={false}
                autocomplete="off"
                autocapitalize="off"
                role="combobox"
                aria-controls={`${id}-list`}
                aria-expanded={true}
                aria-activedescendant={active() ? rowID(active()) : undefined}
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  setActive(keys()[0] ?? "")
                }}
                onKeyDown={onKey}
              />
            </div>
            <div class="oc-divider" />
          </Show>

          <div
            class="oc-menu-list"
            id={`${id}-list`}
            role="listbox"
            tabindex={searchable() ? undefined : -1}
            aria-activedescendant={active() ? rowID(active()) : undefined}
            ref={list}
            onKeyDown={searchable() ? undefined : onKey}
          >
            <Show when={matches().length} fallback={<div class="oc-menu-empty">{props.empty ?? "Nothing here yet."}</div>}>
              <For each={groups()}>
                {(group) => (
                  <>
                    <Show when={group.name}>
                      <div class="oc-group">{group.name}</div>
                    </Show>
                    <For each={group.options}>
                      {(option) => (
                        <button
                          type="button"
                          class="oc-item"
                          id={rowID(option.value)}
                          role="option"
                          data-key={option.value}
                          data-active={active() === option.value ? true : undefined}
                          data-selected={props.value === option.value ? true : undefined}
                          aria-selected={props.value === option.value}
                          title={option.title ?? option.label}
                          disabled={option.disabled}
                          // Keeps the click from pulling focus off the search
                          // row, the way opencode's own rows do.
                          onPointerDown={(event) => event.preventDefault()}
                          onMouseEnter={() => !option.disabled && setActive(option.value)}
                          onClick={() => choose(option.value)}
                        >
                          <span class="oc-item-label">{option.label}</span>
                          <Show when={option.hint}>
                            <span class="oc-item-hint">{option.hint}</span>
                          </Show>
                          <Show when={option.tag}>
                            <span class="oc-tag">{option.tag}</span>
                          </Show>
                          <Show when={props.value === option.value}>
                            <span class="oc-check">
                              <IconCheck />
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
