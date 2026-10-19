import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { store, type McpServer } from "../server/store"
import { IconBack, IconClose, IconPlus, IconTrash } from "./icons"

/**
 * Add, edit and remove the MCP servers of the OpenFlow Omp profile.
 *
 * The list is the profile's `mcp.json`, which this panel owns and rewrites. Omp
 * connects to the servers itself when a card's session starts, so there is no
 * live status to show or connection to manage here: a saved change simply
 * applies to the next session. Omp has no way to select servers per session, so
 * every card sees every configured server.
 */
export function McpPanel(props: {
  onClose: () => void
  onNotice: (kind: "info" | "error", text: string) => void
}) {
  const [servers, setServers] = createSignal<McpServer[]>([])
  const [editing, setEditing] = createSignal<Draft>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  type Pair = { key: string; value: string }
  type Draft = {
    original?: string
    name: string
    type: "local" | "remote"
    enabled: boolean
    command: string
    cwd: string
    url: string
    /** environment (local) or headers (remote), as editable rows. */
    pairs: Pair[]
  }

  async function refresh() {
    setServers(await store.mcpServers().catch(() => []))
  }
  onMount(refresh)

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    if (editing()) return setEditing(undefined)
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  function create() {
    setError(undefined)
    setEditing({ name: "", type: "local", enabled: true, command: "", cwd: "", url: "", pairs: [] })
  }

  function open(server: McpServer) {
    setError(undefined)
    setEditing({
      original: server.name,
      name: server.name,
      type: server.type,
      enabled: server.enabled,
      // Round-tripped as a single line: the config stores argv, and quoting a
      // command back into one string then re-splitting it is the same shape a
      // user types it in.
      command: (server.command ?? []).join(" "),
      cwd: server.cwd ?? "",
      url: server.url ?? "",
      pairs: Object.entries(server.type === "remote" ? (server.headers ?? {}) : (server.environment ?? {})).map(
        ([key, value]) => ({ key, value }),
      ),
    })
  }

  async function save(event: Event) {
    event.preventDefault()
    const draft = editing()
    if (!draft) return
    const name = draft.name.trim()
    if (!name) return setError("Give the server a name.")
    if (draft.type === "local" && !draft.command.trim()) return setError("A local server needs a command to run.")
    if (draft.type === "remote" && !draft.url.trim()) return setError("A remote server needs a url.")

    const pairs = Object.fromEntries(
      draft.pairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]),
    )
    const server: McpServer =
      draft.type === "remote"
        ? { name, type: "remote", enabled: draft.enabled, url: draft.url.trim(), headers: pairs }
        : {
            name,
            type: "local",
            enabled: draft.enabled,
            command: splitCommand(draft.command),
            cwd: draft.cwd.trim() || undefined,
            environment: pairs,
          }

    setBusy(true)
    setError(undefined)
    try {
      const result = await store.saveMcpServer(server)
      // A rename leaves the old key behind, exactly as a renamed skill leaves
      // its folder: the write is an upsert under the new name, nothing else.
      let renamed = ""
      if (draft.original && draft.original !== result.name) {
        const old = await store.deleteMcpServer(draft.original)
        renamed = old.removed
          ? ` (renamed from ${draft.original})`
          : ` (the old entry ${draft.original} was not found, so it was not removed)`
      }
      await refresh()
      setEditing(undefined)
      const backup = result.backup ? ` (backup ${result.backup})` : ""
      props.onNotice(
        "info",
        result.unchanged && !renamed
          ? `mcp server ${result.name} is already saved in ${result.path} as it stands`
          : `saved mcp server ${result.name}${renamed} to ${result.path}${backup}. It applies to the next card session.`,
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function remove(draft: Draft) {
    if (!draft.original) return setEditing(undefined)
    if (!window.confirm(`Remove the mcp server "${draft.original}" from the OpenFlow Omp profile?`)) return
    setBusy(true)
    try {
      const result = await store.deleteMcpServer(draft.original)
      if (!result.removed) {
        // The host found nothing under that name: saying "removed" would leave a server in the profile that the user believes is gone.
        setError(`${draft.original} was not removed: the OpenFlow Omp profile has no mcp server by that name`)
        await refresh()
        return
      }
      await refresh()
      setEditing(undefined)
      props.onNotice("info", `removed ${draft.original}. It is gone from the next card session.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  function patch(next: Partial<Draft>) {
    const draft = editing()
    if (draft) setEditing({ ...draft, ...next })
  }

  function setPair(index: number, next: Partial<Pair>) {
    const draft = editing()
    if (!draft) return
    const pairs = draft.pairs.map((pair, at) => (at === index ? { ...pair, ...next } : pair))
    setEditing({ ...draft, pairs })
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <Show when={editing()}>
            <button type="button" class="oc-clear" aria-label="Back" onClick={() => setEditing(undefined)}>
              <IconBack />
            </button>
          </Show>
          <h2>{editing() ? (editing()!.original ? "Edit MCP server" : "New MCP server") : "MCP servers"}</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <Show when={editing() !== undefined} fallback={<ServerList />}>
          <ServerForm />
        </Show>
      </section>
    </div>
  )

  function ServerList() {
    return (
      <>
        <div class="oc-banner">
          <span>
            These are the MCP servers of the OpenFlow Omp profile. Omp connects to them when a card starts, so a change
            applies to the next card session — not to one already running. Omp has no per-session MCP selection: every
            card sees every configured server.
          </span>
          <button type="button" class="oc-button oc-primary" onClick={create}>
            <IconPlus /> New server
          </button>
        </div>
        <div class="oc-dialog-body">
          <For each={servers()}>
            {(server) => (
              <div class="oc-row">
                <button type="button" class="oc-item" disabled={busy()} onClick={() => open(server)}>
                  <span class="oc-item-label">{server.name}</span>
                  <span class="oc-tag oc-faint">{server.type}</span>
                  <span class="oc-tag" data-mcp={server.enabled ? "enabled" : "disabled"}>
                    {server.enabled ? "enabled" : "disabled"}
                  </span>
                </button>
              </div>
            )}
          </For>
          <Show when={!servers().length}>
            <div class="oc-menu-empty">
              No MCP servers configured. Add one and every card started afterwards can use it.
            </div>
          </Show>
        </div>
      </>
    )
  }

  function ServerForm() {
    const draft = () => editing()!
    return (
      <form class="oc-form" onSubmit={save}>
        <label>
          Name
          <input
            autofocus
            spellcheck={false}
            autocomplete="off"
            placeholder="context7"
            value={draft().name}
            onInput={(event) => patch({ name: event.currentTarget.value })}
          />
        </label>

        <div class="oc-choice">
          <label>
            <input
              type="radio"
              name="mcp-type"
              checked={draft().type === "local"}
              onChange={() => patch({ type: "local" })}
            />
            local — a command this machine runs
          </label>
          <label>
            <input
              type="radio"
              name="mcp-type"
              checked={draft().type === "remote"}
              onChange={() => patch({ type: "remote" })}
            />
            remote — an http/sse endpoint
          </label>
        </div>

        <Show
          when={draft().type === "local"}
          fallback={
            <label>
              URL
              <input
                spellcheck={false}
                autocomplete="off"
                placeholder="https://mcp.example.com/sse"
                value={draft().url}
                onInput={(event) => patch({ url: event.currentTarget.value })}
              />
            </label>
          }
        >
          <>
            <label>
              Command
              <input
                spellcheck={false}
                autocomplete="off"
                placeholder="bunx -y @upstash/context7-mcp"
                value={draft().command}
                onInput={(event) => patch({ command: event.currentTarget.value })}
              />
            </label>
            <label>
              Working directory <span class="oc-faint">(optional)</span>
              <input
                spellcheck={false}
                autocomplete="off"
                placeholder="relative paths resolve from the project"
                value={draft().cwd}
                onInput={(event) => patch({ cwd: event.currentTarget.value })}
              />
            </label>
          </>
        </Show>

        <div class="oc-pairs">
          <span class="oc-pairs-title">{draft().type === "remote" ? "Headers" : "Environment"}</span>
          <For each={draft().pairs}>
            {(pair, index) => (
              <div class="oc-pair">
                <input
                  spellcheck={false}
                  autocomplete="off"
                  placeholder={draft().type === "remote" ? "Authorization" : "API_KEY"}
                  value={pair.key}
                  onInput={(event) => setPair(index(), { key: event.currentTarget.value })}
                />
                <input
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="value"
                  value={pair.value}
                  onInput={(event) => setPair(index(), { value: event.currentTarget.value })}
                />
                <button
                  type="button"
                  class="oc-clear"
                  aria-label="remove"
                  onClick={() => patch({ pairs: draft().pairs.filter((_, at) => at !== index()) })}
                >
                  <IconTrash />
                </button>
              </div>
            )}
          </For>
          <button
            type="button"
            class="oc-button"
            onClick={() => patch({ pairs: [...draft().pairs, { key: "", value: "" }] })}
          >
            <IconPlus /> Add {draft().type === "remote" ? "header" : "variable"}
          </button>
        </div>

        <label class="oc-check">
          <input
            type="checkbox"
            checked={draft().enabled}
            onChange={(event) => patch({ enabled: event.currentTarget.checked })}
          />
          Enabled
        </label>

        <Show when={error()}>{(text) => <p class="oc-error">{text()}</p>}</Show>

        <div class="oc-form-actions">
          <button type="submit" class="oc-button oc-primary" disabled={busy()}>
            {draft().original ? "Save server" : "Add server"}
          </button>
          <Show when={draft().original}>
            <button type="button" class="oc-button oc-danger" disabled={busy()} onClick={() => remove(draft())}>
              <IconTrash /> Remove
            </button>
          </Show>
        </div>

        <p class="oc-note oc-faint">
          Values are stored in plain text in the OpenFlow profile's <code>mcp.json</code>. For a secret, prefer an
          environment variable the host already has, or a header that file is not shared from.
        </p>
      </form>
    )
  }
}

/**
 * Splits a typed command line into argv.
 *
 * Quoting is honoured because MCP commands routinely carry a path with spaces
 * (`node "C:\Program Files\..."`), and splitting that on whitespace produces a
 * server that fails to start with an error naming a file nobody wrote.
 */
export function splitCommand(value: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) out.push(current)
      current = ""
      started = false
      continue
    }
    current += char
  }
  if (started || current) out.push(current)
  return out
}
