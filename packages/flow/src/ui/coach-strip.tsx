import { For, Show } from "solid-js"
import type { Finding } from "../graph/coach"
import { IconAlert, IconClose, IconInfo } from "./icons"

/**
 * The findings a run's ending still shows: the ones nobody dismissed for *this*
 * run. Keys carry the run id, so the same finding on the next run comes back.
 */
export function visibleFindings(findings: Finding[], dismissed: ReadonlySet<string>, runId: string | undefined) {
  if (!runId) return []
  return findings.filter((finding) => !dismissed.has(dismissKey(runId, finding.id)))
}

export function dismissKey(runId: string, findingId: string) {
  return `${runId}:${findingId}`
}

/** Post-run findings, one notice row each. Renders nothing when the list is empty. */
export function CoachStrip(props: { findings: Finding[]; onDismiss: (id: string) => void }) {
  return (
    <Show when={props.findings.length}>
      <div class="coach" role="status">
        <For each={props.findings}>
          {(finding) => (
            <div class="notice coach-row" data-kind={finding.severity}>
              <span class="notice-icon">
                <Show when={finding.severity === "info"} fallback={<IconAlert />}>
                  <IconInfo />
                </Show>
              </span>
              <span class="notice-text">
                {finding.evidence}
                <span class="coach-fix">{finding.fix}</span>
              </span>
              <button
                class="icon-btn notice-close"
                type="button"
                title="dismiss"
                aria-label="dismiss"
                onClick={() => props.onDismiss(finding.id)}
              >
                <IconClose />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
