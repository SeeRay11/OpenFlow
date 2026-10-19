import { Show, createSignal, onCleanup, onMount } from "solid-js"
import type { FitAddon as GhosttyFit, Ghostty, Terminal as GhosttyTerminal } from "ghostty-web"
import { PTY_ROUTES } from "../../shared/terminal"
import type { PtyKind, PtyTicket } from "../../shared/terminal"
import { IconClose } from "./icons"
import { decodeServerFrame, encodeResize, ptyHeaders, readProblem, socketUrl, ticketInit } from "./terminal-frames"
import { actionLabel, initialState, needsOmpSettings, reduce, statusText } from "./terminal-session"
import type { SessionEvent, SessionState } from "./terminal-session"
import "./terminal-dock.css"

/** The bottom dock the way the activity drawer is one: a row of the app column, resizable by its grip. */
const DEFAULT_HEIGHT = 0.35
const MIN_HEIGHT = 0.15
const MAX_HEIGHT = 0.7

/** Sessions outlive the dock: closing it detaches, opening it attaches again. */
const remembered: Partial<Record<PtyKind, string>> = {}

type Emulator = { Terminal: typeof GhosttyTerminal; FitAddon: typeof GhosttyFit; ghostty: Ghostty }

let loading: Promise<Emulator> | undefined

/**
 * ghostty-web, once: a dynamic import keeps its ~400 KB of inlined wasm in a
 * chunk nobody downloads until the dock opens. The promise is dropped on
 * failure so a flaky first load can be retried.
 */
function loadEmulator(): Promise<Emulator> {
  if (loading) return loading
  loading = import("ghostty-web")
    .then(async (mod) => ({ Terminal: mod.Terminal, FitAddon: mod.FitAddon, ghostty: await mod.Ghostty.load() }))
    .catch((error) => {
      loading = undefined
      throw error
    })
  return loading
}

/** Any CSS colour (the `--v2-*` tokens are not all hex) as `#rrggbb`, via a 1x1 canvas. */
function colour(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!value || !context) return fallback
  context.fillStyle = "#000"
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

export type TerminalDockProps = {
  open: boolean
  onClose(): void
  /** Which session to open first; the dock's own switch changes it afterwards. */
  kind?: PtyKind
  /** Shown as a link when omp is missing or too old. */
  onOpenSettings?(): void
}

export function TerminalDock(props: TerminalDockProps) {
  return (
    <Show when={props.open}>
      <Dock kind={props.kind ?? "omp"} onClose={props.onClose} onOpenSettings={props.onOpenSettings} />
    </Show>
  )
}

/**
 * Keys: everything typed inside the dock goes to the shell, `Esc` included, and
 * none of it reaches the window handlers (the activity drawer closes on `Esc`,
 * the canvas undoes on Ctrl+Z). The one key the terminal does not receive is
 * Ctrl+` — it leaves the terminal for the dock's own controls, and the header
 * says so. Ctrl+Shift+C copies the selection; paste is the browser's.
 *
 * The emulator draws to a canvas, so a screen reader cannot read the grid: the
 * `aria-live` line carries connection and exit state, and the region is named.
 */
function Dock(props: { kind: PtyKind; onClose(): void; onOpenSettings?(): void }) {
  const [view, setView] = createSignal<SessionState>(initialState(props.kind))
  const [height, setHeight] = createSignal(DEFAULT_HEIGHT)
  let current = view()
  let dock!: HTMLElement
  let surface!: HTMLDivElement
  let kindSwitch!: HTMLDivElement
  let term: GhosttyTerminal | undefined
  let socket: WebSocket | undefined
  let retry: number | undefined
  let sizing: number | undefined
  let attempt = 0
  let disposed = false
  const cleanups: (() => void)[] = []

  const dispatch = (event: SessionEvent) => {
    current = reduce(current, event)
    setView(current)
  }

  function sendSize() {
    if (!term || socket?.readyState !== WebSocket.OPEN) return
    socket.send(encodeResize(term.cols, term.rows))
  }

  async function ensureTerminal(): Promise<GhosttyTerminal> {
    if (term) return term
    const emulator = await loadEmulator()
    if (disposed) throw new Error("closed")
    const created = new emulator.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--v2-font-family-mono").trim() || "monospace",
      scrollback: 10_000,
      allowTransparency: false,
      convertEol: false,
      ghostty: emulator.ghostty,
      theme: {
        background: colour("--v2-background-bg-layer-01", "#191515"),
        foreground: colour("--v2-text-text-base", "#d4d4d4"),
        cursor: colour("--v2-text-text-base", "#d4d4d4"),
        selectionBackground: colour("--v2-background-bg-accent", "#3b6fd4"),
      },
    })
    const fit = new emulator.FitAddon()
    created.loadAddon(fit)
    created.attachCustomKeyEventHandler((event) => {
      // `true` means "the dock handled it": the key is not sent to the pty.
      if (event.ctrlKey && event.shiftKey && !event.metaKey && event.key.toLowerCase() === "c") {
        const selection = created.getSelection()
        if (selection && !document.execCommand("copy")) void navigator.clipboard?.writeText(selection)
        return true
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "`") {
        created.blur()
        created.textarea?.blur()
        kindSwitch.querySelector("button")?.focus()
        return true
      }
      return false
    })
    created.open(surface)
    fit.fit()
    fit.observeResize()
    cleanups.push(() => fit.dispose())

    const onCopy = (event: ClipboardEvent) => {
      const selection = created.getSelection()
      if (!selection || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData("text/plain", selection)
    }
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? ""
      if (!text) return
      event.preventDefault()
      event.stopPropagation()
      created.paste(text)
    }
    surface.addEventListener("copy", onCopy)
    surface.addEventListener("paste", onPaste, true)
    cleanups.push(() => {
      surface.removeEventListener("copy", onCopy)
      surface.removeEventListener("paste", onPaste, true)
    })

    const data = created.onData((text) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(text)
    })
    // The pty needs the new size once the user stops dragging, not on every pixel.
    const resized = created.onResize(() => {
      clearTimeout(sizing)
      sizing = window.setTimeout(sendSize, 100)
    })
    cleanups.push(() => {
      data.dispose()
      resized.dispose()
    })
    term = created
    return created
  }

  function closeSocket() {
    clearTimeout(retry)
    const old = socket
    socket = undefined
    old?.close(1000)
  }

  function scheduleRetry(generation: number) {
    if (current.phase !== "disconnected" || current.retryInMs === undefined) return
    retry = window.setTimeout(() => {
      if (generation !== attempt) return
      dispatch({ type: "retry" })
      void connect(generation, false)
    }, current.retryInMs)
  }

  /** Asks for a ticket (attach when the session is known, create otherwise), then opens the socket with it. */
  async function connect(generation: number, recreateIfGone: boolean) {
    let terminal: GhosttyTerminal
    try {
      terminal = await ensureTerminal()
    } catch (error) {
      if (generation !== attempt || disposed) return
      const reason = error instanceof Error ? error.message : "unknown error"
      dispatch({ type: "failed", problem: { message: `the terminal emulator failed to load: ${reason}`, code: "emulator" } })
      return
    }
    if (generation !== attempt) return

    let granted: PtyTicket
    try {
      const response = await fetch(
        PTY_ROUTES.ticket,
        ticketInit(current.id === undefined ? { create: { kind: current.kind, cols: terminal.cols, rows: terminal.rows } } : { id: current.id }),
      )
      if (generation !== attempt) return
      if (!response.ok) {
        const problem = await readProblem(response)
        if (generation !== attempt) return
        if (recreateIfGone && problem.status === 404 && problem.code === "gone") {
          delete remembered[current.kind]
          void begin(current.kind, true)
          return
        }
        dispatch({ type: "failed", status: problem.status, problem: { message: problem.message, code: problem.code } })
        return
      }
      granted = (await response.json()) as PtyTicket
    } catch {
      if (generation !== attempt) return
      dispatch({ type: "failed", network: true, problem: { message: "the host is not reachable" } })
      scheduleRetry(generation)
      return
    }

    dispatch({ type: "ticket", id: granted.id })
    remembered[current.kind] = granted.id
    const opened = new WebSocket(socketUrl(window.location, granted, current.cursor))
    opened.binaryType = "arraybuffer"
    socket = opened
    opened.onopen = () => {
      if (opened !== socket) return
      dispatch({ type: "open" })
      sendSize()
      term?.focus()
    }
    opened.onmessage = (event) => {
      if (opened !== socket) return
      const frame = decodeServerFrame(event.data)
      if (frame.kind === "output") {
        term?.write(frame.text)
        dispatch({ type: "output", length: frame.text.length })
        return
      }
      if (frame.kind !== "control") return
      dispatch("cursor" in frame.control ? { type: "cursor", cursor: frame.control.cursor } : { type: "exit", exit: frame.control.exit })
    }
    opened.onclose = (event) => {
      if (opened !== socket) return
      socket = undefined
      dispatch({ type: "closed", code: event.code })
      scheduleRetry(generation)
    }
  }

  /** A new connection attempt: a remembered session for `kind` when there is one, else a fresh one. */
  async function begin(kind: PtyKind, fresh = false) {
    const generation = ++attempt
    closeSocket()
    const id = fresh ? undefined : remembered[kind]
    dispatch({ type: "begin", kind, id })
    // A new session starts on a clean screen; a reconnect (no `begin`) never clears.
    term?.reset()
    await connect(generation, id !== undefined)
  }

  function restart() {
    const old = current.id
    if (old !== undefined) {
      delete remembered[current.kind]
      void fetch(PTY_ROUTES.session(old), { method: "DELETE", headers: ptyHeaders }).catch(() => undefined)
    }
    void begin(current.kind, true)
  }

  function act() {
    const action = actionLabel(current)
    if (action === "Restart") restart()
    else if (action === "Reconnect") {
      attempt += 1
      closeSocket()
      dispatch({ type: "retry", manual: true })
      void connect(attempt, false)
    } else if (action === "Try again") void begin(current.kind, true)
  }

  function startResize(event: PointerEvent) {
    event.preventDefault()
    const move = (moved: PointerEvent) =>
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, 1 - moved.clientY / window.innerHeight)))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  onMount(() => {
    // Native, not Solid's delegated handler: this has to stop the event before it
    // reaches `window`, where the activity drawer and the canvas listen.
    const contain = (event: KeyboardEvent) => event.stopPropagation()
    dock.addEventListener("keydown", contain)
    cleanups.push(() => dock.removeEventListener("keydown", contain))
    void begin(props.kind)
  })

  onCleanup(() => {
    disposed = true
    attempt += 1
    closeSocket()
    clearTimeout(sizing)
    for (const cleanup of cleanups.splice(0)) cleanup()
    term?.dispose()
    term = undefined
  })

  const state = view
  const strip = () => state().phase === "exited" || state().phase === "disconnected"

  return (
    <section class="terminal-dock" role="region" aria-label="Terminal" ref={dock} style={{ height: `${Math.round(height() * 100)}vh` }}>
      <div class="terminal-grip" onPointerDown={startResize} title="drag to resize" />

      <header class="terminal-bar">
        <span class="terminal-title">Terminal</span>
        <div class="terminal-kind" role="group" aria-label="Terminal kind" ref={kindSwitch}>
          <button type="button" aria-pressed={state().kind === "omp"} onClick={() => void begin("omp")}>
            omp
          </button>
          <button type="button" aria-pressed={state().kind === "shell"} onClick={() => void begin("shell")}>
            shell
          </button>
        </div>
        <span class="terminal-status" role="status" aria-live="polite" data-phase={state().phase}>
          {statusText(state())}
        </span>
        <span class="terminal-spacer" />
        <span class="hint terminal-leave">Ctrl+` leaves the terminal</span>
        <button class="icon-btn" type="button" title="Close terminal" aria-label="Close terminal" onClick={() => props.onClose()}>
          <IconClose />
        </button>
      </header>

      <div class="terminal-body">
        <div class="terminal-surface" ref={surface} />

        <Show when={state().phase === "loading"}>
          <div class="terminal-banner">{statusText(state())}</div>
        </Show>

        <Show when={state().phase === "error"}>
          <div class="terminal-banner terminal-banner-error" role="alert">
            <p>{state().error?.message}</p>
            <div class="terminal-actions">
              <Show when={needsOmpSettings(state()) && props.onOpenSettings}>
                <button class="btn" type="button" onClick={() => props.onOpenSettings?.()}>
                  Open Omp settings
                </button>
              </Show>
              <button class="btn" type="button" onClick={act}>
                {actionLabel(state())}
              </button>
            </div>
          </div>
        </Show>

        <Show when={strip()}>
          <div class="terminal-strip" data-phase={state().phase}>
            <span>{statusText(state())}</span>
            <button class="btn" type="button" onClick={act}>
              {actionLabel(state())}
            </button>
          </div>
        </Show>
      </div>
    </section>
  )
}
