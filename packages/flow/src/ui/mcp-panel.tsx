import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import * as api from "../server/client"
import { store, type McpServer } from "../server/store"
import { IconBack, IconClose, IconPlus, IconTrash } from "./icons"

/**
 * Add, edit and inspect the project's MCP servers.
 *
 * Two lists are folded into one view on purpose. The *configured* set is the
 * `mcp` block of the project's `opencode.json`, which this panel owns and
 * rewrites. The *live* set is what the running `opencode serve` has actually
 * connected, read from its own `GET /mcp`. They disagree constantly — the
 * server reads config once at boot — and showing only one of them is how a user
 * ends up convinced a server is broken when it is merely not loaded yet. Every
 * row therefore carries its live status, and "not loaded" is spelled out as
 * "restart the server", not as an error.
 *
 * Connect/disconnect act on the live server only; they are a way to retry a
 * failed connection without a restart, not a way to change the config.
 */
export function McpPanel(props: {
  onClose: () => void
  onNotice: (kind: "info" | "error", text: string) => void
  onChanged?: () => void
}) {
  const [servers, setServers] = createSignal<McpServer[]>([])
  const [status, setStatus] = createSignal<Record<string, api.McpStatus>>({})
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
    const [configured, live] = await Promise.all([
      store.mcpServers().catch(() => []),
      api.mcpStatus().catch(() => ({}) as Record<string, api.McpStatus>),
    ])
    setServers(configured)
    setStatus(live)
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
      if (draft.original && draft.original !== name) {
        await store.deleteMcpServer(draft.original)
        renamed = ` (renamed from ${draft.original})`
      }
      await refresh()
      props.onChanged?.()
      setEditing(undefined)
      const backup = result.backup ? ` (backup ${result.backup})` : ""
      props.onNotice(
        "info",
        result.unchanged && !renamed
          ? `mcp server ${name} is already saved in ${result.path} as it stands`
          : `saved mcp server ${name}${renamed} to ${result.path}${backup}. Restart \`opencode serve\` to load it.`,
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function remove(draft: Draft) {
    if (!draft.original) return setEditing(undefined)
    if (!window.confirm(`Remove the mcp server "${draft.original}" from opencode.json?`)) return
    setBusy(true)
    try {
      await store.deleteMcpServer(draft.original)
      await refresh()
      props.onChanged?.()
      setEditing(undefined)
      props.onNotice("info", `removed ${draft.original}. Restart \`opencode serve\` to drop its tools.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  /** Reconnect (or disconnect) a server the running instance already knows. */
  async function toggleLive(server: McpServer, connect: boolean) {
    setBusy(true)
    try {
      if (connect) await api.mcpConnect(server.name)
      else await api.mcpDisconnect(server.name)
      await refresh()
      props.onNotice("info", `${connect ? "connected" : "disconnected"} ${server.name}`)
    } catch (failure) {
      props.onNotice("error", `${server.name}: ${api.describe(failure)}`)
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
            Servers are written to the project's <code>opencode.json</code>, so cards and the opencode CLI see the
            same set.
          </span>
          <button type="button" class="oc-button oc-primary" onClick={create}>
            <IconPlus /> New server
          </button>
        </div>
        <div class="oc-dialog-body">
          <For each={servers()}>
            {(server) => {
              const live = () => status()[server.name]
              return (
                <div class="oc-row">
                  <button type="button" class="oc-item" disabled={busy()} onClick={() => open(server)}>
                    <span class="oc-item-label">{server.name}</span>
                    <span class="oc-tag oc-faint">{server.type}</span>
                    <span class="oc-tag" data-mcp={live()?.status ?? (server.enabled ? "unloaded" : "disabled")}>
                      {describeStatus(live(), server.enabled)}
                    </span>
                  </button>
                  <Show when={live()}>
                    <button
                      type="button"
                      class="oc-button"
                      disabled={busy()}
                      title={
                        live()!.status === "connected"
                          ? "disconnect this server on the running opencode serve"
                          : "retry the connection without restarting the server"
                      }
                      onClick={() => void toggleLive(server, live()!.status !== "connected")}
                    >
                      {live()!.status === "connected" ? "disconnect" : "connect"}
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={!servers().length}>
            <div class="oc-menu-empty">
              No MCP servers configured. Add one — every card can then be given access to it in the inspector.
            </div>
          </Show>
          <Show when={unconfigured().length}>
            <p class="oc-note oc-faint">
              The running server also has {unconfigured().join(", ")}, which this project's opencode.json does not
              list — they come from your global config.
            </p>
          </Show>
        </div>
      </>
    )
  }

  /** Live servers with no row of their own: configured globally, not per project. */
  function unconfigured() {
    const known = new Set(servers().map((server) => server.name))
    return Object.keys(status()).filter((name) => !known.has(name))
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
          Enabled at server start
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
          Values are stored in plain text in <code>opencode.json</code>. For a secret, prefer an environment variable
          the host already has, or a header this project's config is not shared from.
        </p>
      </form>
    )
  }
}

function describeStatus(live: api.McpStatus | undefined, enabled: boolean) {
  if (!live) return enabled ? "not loaded — restart server" : "disabled"
  switch (live.status) {
    case "connected":
      return "connected"
    case "disabled":
      return "disabled"
    case "needs_auth":
      return "needs auth"
    case "needs_client_registration":
      return "needs client registration"
    default:
      return `failed — ${live.error}`
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
