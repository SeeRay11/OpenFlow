import { Show, createUniqueId, onCleanup, onMount } from "solid-js"
import type { PendingUpliftFailure, UpliftChoice } from "../state"
import { upliftFailureView, wrapFocus } from "./card-stages-model"
import "./card-stages.css"
import { IconAlert } from "./icons"

/**
 * A card whose task could not be uplifted, waiting on a person.
 *
 * Nothing has been sent to the agent: the card is parked until one of three
 * things happens — run it with the original prompt, try the uplift again, or
 * cancel the card. Like the question dialog this is a modal, one failure at a
 * time, but it is a real `alertdialog`: focus moves in (to the safe, repeatable
 * choice), Tab stays inside, Esc cancels the card, and focus goes back to where
 * it was when the dialog closes. The backdrop is not a dismiss target; a stray
 * click must not decide for a card.
 *
 * Mount it keyed on the first pending failure so each failure gets a fresh
 * dialog and a fresh focus restore.
 */
export function UpliftFailureDialog(props: {
  failure: PendingUpliftFailure
  /** Failures queued behind this one. */
  waiting?: number
  onDecide: (requestID: string, choice: UpliftChoice) => void
}) {
  const id = createUniqueId()
  const titleId = `uplift-failure-title-${id}`
  const bodyId = `uplift-failure-body-${id}`
  const view = () => upliftFailureView(props.failure, props.waiting ?? 0)
  let dialog!: HTMLElement
  let retry: HTMLButtonElement | undefined
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined

  const decide = (choice: UpliftChoice) => props.onDecide(props.failure.requestID, choice)

  // Capture phase on the window, so Esc cancels this card instead of also
  // closing the activity drawer, and Tab cannot leave for the page behind.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      // Holding Esc auto-repeats, and each repeat would cancel the next queued card unseen.
      if (event.repeat) return
      return decide("cancel")
    }
    if (event.key !== "Tab") return
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")]
    const target = controls[wrapFocus(controls.indexOf(document.activeElement as HTMLElement), controls.length, event.shiftKey)]
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  onMount(() => {
    // Retry is the safe, repeatable choice; on the last attempt it is gone, so land on the first button.
    ;(retry ?? dialog.querySelector<HTMLElement>("button"))?.focus()
    window.addEventListener("keydown", onKeyDown, true)
  })

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true)
    if (opener?.isConnected) opener.focus()
  })

  return (
    <div class="oc oc-backdrop">
      <section
        ref={dialog}
        class="oc-dialog uplift-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <header class="oc-dialog-head">
          <IconAlert />
          <h2 id={titleId}>{view().title}</h2>
        </header>

        <div class="oc-dialog-body" id={bodyId}>
          <p class="uplift-failure-reason">{view().reason}</p>
          <p class="hint uplift-failure-meta">
            nothing was sent to the agent{view().elapsed ? ` · ${view().elapsed}` : ""}
          </p>
          <Show when={view().queue}>
            <p class="hint uplift-failure-meta">{view().queue}</p>
          </Show>
        </div>

        <div class="oc-form-actions uplift-failure-actions">
          <button
            type="button"
            class="oc-button"
            title="send the card's own task text, as written, without the uplift"
            onClick={() => decide("original")}
          >
            Run with original prompt
          </button>
          <Show when={view().canRetry}>
            <button
              ref={retry}
              type="button"
              class="oc-button oc-primary"
              title="run the uplift again"
              onClick={() => decide("retry")}
            >
              Retry uplift
            </button>
          </Show>
          <button
            type="button"
            class="oc-button oc-danger"
            title="stop this card; the cards that need it are skipped"
            onClick={() => decide("cancel")}
          >
            Cancel card
          </button>
        </div>
      </section>
    </div>
  )
}
