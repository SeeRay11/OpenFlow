import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { HARNESS_ROUTES, type GsdHealth } from "../../shared/harness"

export function HarnessStrip() {
  const [health, setHealth] = createSignal<GsdHealth | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  let timer: ReturnType<typeof setInterval> | undefined

  async function load() {
    try {
      const response = await fetch(HARNESS_ROUTES.health)
      if (!response.ok) throw new Error(`harness health ${response.status}`)
      const body = (await response.json()) as { gsdCore: GsdHealth }
      setHealth(body.gsdCore)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onMount(() => {
    void load()
    timer = setInterval(() => void load(), 30_000)
  })
  onCleanup(() => clearInterval(timer))

  function theme(next: "light" | "dark") {
    document.documentElement.dataset.colorScheme = next
    document.documentElement.style.colorScheme = next
    try { localStorage.setItem("autonogrammer-theme", next) } catch { /* this view only */ }
  }

  return (
    <div class="harness-strip">
      <Show when={health()} fallback={<span class="harness-health">gsd-core …</span>}>
        {(row) => (
          <span class="harness-health" data-health={row().health} title={row().detail}>
            gsd-core {row().installed ? row().version : row().health}
          </span>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <button class="btn btn-ghost" type="button" onClick={() => void load()}>
            harness unavailable — retry ({message()})
          </button>
        )}
      </Show>
      <button class="btn btn-ghost" type="button" aria-label="use light theme" onClick={() => theme("light")}>light</button>
      <button class="btn btn-ghost" type="button" aria-label="use dark theme" onClick={() => theme("dark")}>dark</button>
    </div>
  )
}
