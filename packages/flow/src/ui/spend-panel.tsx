import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Spend } from "../graph/types"
import { store, type RunEntry } from "../server/store"
import { byProvider, costLabel, formatCost, formatTokens, mergeSpend } from "../server/usage"
import { state } from "../state"
import { IconClose } from "./icons"

/**
 * What the agents have cost, and how that number was arrived at.
 *
 * Every figure is `tokens the server reported × the price models.dev publishes`
 * — see `server/usage.ts`. The panel is deliberately explicit about the two
 * ways it can be short of the truth, because a spend readout nobody trusts is
 * worth nothing:
 *
 * - a model the catalog quotes no price for is listed with its tokens and *no*
 *   money, and the total says `≥` while any such model is in it;
 * - runs recorded before usage tracking existed carry no usage at all, and are
 *   counted separately rather than folded in as zero.
 *
 * It is also list price: subscription plans, negotiated rates, free tiers and
 * provider credits are invisible from here, and the footer says so.
 */
export function SpendPanel(props: { onClose: () => void }) {
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [loaded, setLoaded] = createSignal(false)

  onMount(async () => {
    setRuns(await store.runs().catch(() => []))
    setLoaded(true)
  })

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  const current = createMemo(() => state.run?.usage)

  /**
   * All-time is the saved run logs plus the live one.
   *
   * The live run is merged in by id so an in-flight run is not counted twice
   * once its log lands on disk mid-session.
   */
  const all = createMemo(() => {
    const live = state.run
    const saved = runs().filter((entry) => entry.id !== live?.id)
    return mergeSpend([...saved.map((entry) => entry.usage), live?.usage])
  })

  const untracked = createMemo(() => {
    const live = state.run
    return runs().filter((entry) => entry.id !== live?.id && !entry.usage).length
  })

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <h2>Spend</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <div class="oc-dialog-body spend">
          <div class="spend-totals">
            <Total label="this run" spend={current()} />
            <Total label={loaded() ? "all runs" : "all runs (loading…)"} spend={all()} />
          </div>

          <Section title="this run" spend={current()} empty="no run yet" />
          <Section title="all runs" spend={all()} empty={loaded() ? "no recorded usage yet" : "reading run logs…"} />

          <Show when={untracked()}>
            <p class="hint">
              {untracked()} earlier run{untracked() === 1 ? "" : "s"} recorded no usage — they predate cost tracking and
              are left out of the totals rather than counted as free.
            </p>
          </Show>

          <p class="hint spend-note">
            Token counts come from the provider's own usage report, relayed by <code>opencode serve</code>. Money is
            those counts at the list price models.dev publishes for each model, including cached and reasoning tokens.
            It does not know about subscriptions, credits, free tiers or negotiated rates, and a step that failed
            before reporting usage is not counted. Treat it as a close estimate of list-price spend, not as an invoice.
          </p>
        </div>
      </section>
    </div>
  )
}

function Total(props: { label: string; spend?: Spend }) {
  return (
    <div class="spend-total">
      <span class="spend-total-label">{props.label}</span>
      {/* nothing measured is "—", not "$0" — a zero would claim the agents ran free */}
      <span class="spend-total-value">{props.spend?.steps ? costLabel(props.spend) : "—"}</span>
      <span class="hint">
        {formatTokens(props.spend ? tokenCount(props.spend) : 0)} tokens · {props.spend?.steps ?? 0} steps
      </span>
    </div>
  )
}

function Section(props: { title: string; spend?: Spend; empty: string }) {
  const providers = createMemo(() => (props.spend ? byProvider(props.spend) : []))
  return (
    <div class="spend-section">
      <h3 class="panel-title">{props.title}</h3>
      <Show when={providers().length} fallback={<div class="hint">{props.empty}</div>}>
        <For each={providers()}>
          {(provider) => (
            <div class="spend-provider">
              <div class="spend-row spend-row-head">
                <span class="spend-name">{provider.provider}</span>
                <span class="spend-tokens hint">{formatTokens(tokenCountOf(provider.tokens))}</span>
                <span class="spend-cost">
                  {provider.priced ? formatCost(provider.cost) : provider.cost > 0 ? `≥ ${formatCost(provider.cost)}` : "unpriced"}
                </span>
              </div>
              <For each={props.spend!.models.filter((model) => model.provider === provider.provider)}>
                {(model) => (
                  <div class="spend-row">
                    <span class="spend-name mono dim">{model.model.slice(provider.provider.length + 1)}</span>
                    <span class="spend-tokens hint" title={detail(model.tokens)}>
                      {formatTokens(tokenCountOf(model.tokens))}
                    </span>
                    <span class="spend-cost" classList={{ dim: !model.priced }}>
                      {model.priced ? formatCost(model.cost ?? 0) : "no published price"}
                    </span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function tokenCount(spend: Spend) {
  return tokenCountOf(spend.tokens)
}

function tokenCountOf(tokens: Spend["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function detail(tokens: Spend["tokens"]) {
  return `input ${tokens.input} · output ${tokens.output} · reasoning ${tokens.reasoning} · cache read ${tokens.cacheRead} · cache write ${tokens.cacheWrite}`
}
