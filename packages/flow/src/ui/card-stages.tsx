import { For, Show, createEffect, createSignal } from "solid-js"
import type { MemoryInfo } from "../../shared/memory"
import type { SwarmStatus } from "../../shared/swarm"
import type { UpliftInfo } from "../../shared/uplift"
import { runtimeOf } from "../state"
import {
  decisionLine,
  memoryChip,
  memoryReadText,
  memoryRow,
  memoryWriteText,
  stageAnnouncement,
  stageSnapshot,
  swarmAgentText,
  swarmCountsText,
  swarmIdleText,
  swarmLine,
  upliftChip,
  upliftFacts,
  upliftPrompts,
  type MemoryRowItem,
  type StageSnapshot,
} from "./card-stages-model"
import "./card-stages.css"

/**
 * Presentation for what happens to a card's task before and around its Omp
 * turn: prompt uplift, shared memory, the swarm. Wording, counts and truncation
 * are in `card-stages-model.ts`; these components only place them.
 */

/** `role="img"` so the full sentence replaces the terse label for assistive tech. */
export function UpliftChip(props: { uplift?: UpliftInfo }) {
  return (
    <Show when={upliftChip(props.uplift)}>
      {(chip) => (
        <span class="stage-chip" data-tone={chip().tone} role="img" title={chip().title} aria-label={chip().aria}>
          {chip().label}
        </span>
      )}
    </Show>
  )
}

export function MemoryChip(props: { memory?: MemoryInfo }) {
  return (
    <Show when={memoryChip(props.memory)}>
      {(chip) => (
        <span
          class="stage-chip stage-chip-mem"
          data-tone={chip().tone}
          role="img"
          title={chip().title}
          aria-label={chip().aria}
        >
          {chip().label}
        </span>
      )}
    </Show>
  )
}

/** One truncating line: counts, then a pill per agent. */
export function SwarmLine(props: { swarm?: SwarmStatus }) {
  return (
    <Show when={swarmLine(props.swarm)}>
      {(line) => (
        <div class="node-line stage-swarm" data-tone={line().tone} title={line().title} role="img" aria-label={line().aria}>
          <span class="stage-swarm-text">{line().text}</span>
          <Show when={!props.swarm?.error && line().pills.length}>
            <span class="stage-pills">
              <For each={line().pills}>
                {(pill) => (
                  <span class="stage-pill" data-state={pill.state} title={pill.title}>
                    {pill.agent}
                  </span>
                )}
              </For>
              <Show when={line().more}>
                <span class="stage-pill-more dim">+{line().more}</span>
              </Show>
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}

/* ---------------------------------------------------------- inspector parts */

export function UpliftSection(props: { originalPrompt?: string; uplift?: UpliftInfo }) {
  return (
    <Show when={props.uplift}>
      {(uplift) => {
        const prompts = () => upliftPrompts(props.originalPrompt, uplift())
        return (
          <div class="panel-section">
            <h2 class="panel-title">prompt uplift</h2>
            <dl class="stage-facts">
              <For each={upliftFacts(uplift())}>
                {(fact) => (
                  <>
                    <dt>{fact.key}</dt>
                    <dd>{fact.value}</dd>
                  </>
                )}
              </For>
            </dl>
            <Show when={uplift().decisions?.length}>
              <ul class="stage-rows" aria-label="Jev decisions">
                <For each={uplift().decisions}>
                  {(decision) => <li class="stage-row-preview mono">{decisionLine(decision)}</li>}
                </For>
              </ul>
            </Show>
            <Show when={prompts().original}>
              <details class="stage-details">
                <summary>original prompt</summary>
                <pre class="transcript">{prompts().original}</pre>
              </details>
            </Show>
            <Show when={prompts().uplifted}>
              <details class="stage-details">
                <summary>uplifted prompt</summary>
                <pre class="transcript">{prompts().uplifted}</pre>
              </details>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}

export function MemorySection(props: { memory?: MemoryInfo }) {
  return (
    <Show when={memoryChip(props.memory)}>
      <div class="panel-section">
        <h2 class="panel-title">memory</h2>
        <Show when={props.memory?.read}>
          {(read) => (
            <>
              <p class="stage-line" data-tone={read().status === "unavailable" ? "warn" : undefined}>
                {memoryReadText(read())}
              </p>
              <Show when={read().items.length}>
                <ul class="stage-rows" aria-label="memories read">
                  <For each={read().items as MemoryRowItem[]}>
                    {(item) => {
                      const row = () => memoryRow(item)
                      return (
                        <li class="stage-row">
                          <span class="stage-row-head dim">
                            <span class="mono">{row().subject}</span>
                            <span>{row().scope}</span>
                            <Show when={row().age}>
                              <span>{row().age}</span>
                            </Show>
                          </span>
                          <span class="stage-row-preview">{row().preview}</span>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.memory?.write}>
          {(write) => (
            <>
              <p
                class="stage-line"
                data-tone={write().status === "stored" || write().status === "running" || write().status === "skipped" ? undefined : "warn"}
              >
                write: {memoryWriteText(write())}
              </p>
              <Show when={write().status === "stored"}>
                <span class="hint">substrate has no delete: this fact lapses on its ttl, and a forget only stops it being read</span>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.memory?.graphId}>
          <span class="hint mono">{props.memory!.graphId}</span>
        </Show>
      </div>
    </Show>
  )
}

export function SwarmSection(props: { swarm?: SwarmStatus }) {
  return (
    <Show when={props.swarm && props.swarm.mode !== "off" ? props.swarm : undefined}>
      {(swarm) => (
        <div class="panel-section">
          <h2 class="panel-title">swarm</h2>
          <Show when={swarm().error}>
            <p class="stage-line" data-tone="danger">
              swarm degraded: {swarm().error}
            </p>
          </Show>
          <Show
            when={swarm().active || swarm().agents.length}
            fallback={<span class="hint">{swarmIdleText(swarm())}</span>}
          >
            <p class="stage-line">{swarmCountsText(swarm().counts) || "delegating"}</p>
          </Show>
          <Show when={swarm().agents.length}>
            <ul class="stage-rows" aria-label="swarm agents">
              <For each={swarm().agents}>
                {(agent) => (
                  <li class="stage-row">
                    <span class="stage-row-head">
                      <span class="stage-pill" data-state={agent.state}>
                        {agent.state}
                      </span>
                      <span class="mono" title={swarmAgentText(agent)}>
                        {agent.agent}
                      </span>
                    </span>
                    <Show when={agent.activity}>
                      <span class="stage-row-preview">{agent.activity}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={swarm().correlationId}>
            <span class="hint mono">{swarm().correlationId}</span>
          </Show>
        </div>
      )}
    </Show>
  )
}

/**
 * Announces changes in uplift, memory and swarm state for one card.
 *
 * Mounted once, for the card the inspector shows: other cards stay silent.
 * Changing which card that is only re-baselines, so moving the selection reads
 * nothing out.
 */
export function StageAnnouncer(props: { nodeID: string; role: string }) {
  const [text, setText] = createSignal("")
  let last: { id: string; snapshot: StageSnapshot } | undefined

  createEffect(() => {
    const snapshot = stageSnapshot(runtimeOf(props.nodeID))
    const previous = last?.id === props.nodeID ? last.snapshot : undefined
    last = { id: props.nodeID, snapshot }
    setText(previous ? stageAnnouncement(props.role, previous, snapshot) : "")
  })

  return (
    <div class="stage-live" role="status" aria-live="polite" aria-atomic="true">
      {text()}
    </div>
  )
}
