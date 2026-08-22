import { For, Show, createMemo, createSignal } from "solid-js"
import type { PendingQuestion } from "../state"
import { IconQuestion } from "./icons"

/**
 * A card stopping to ask a person something.
 *
 * This is the `question` tool coming back the other way: the agent asked, its
 * node is parked mid-run, and nothing else in that branch proceeds until an
 * answer or a rejection goes back. That is why this is a modal rather than a
 * toast — an ask that scrolls past is an ask that times out.
 *
 * Answers are positional, one array of chosen labels per question, so every
 * question has to be answered before the reply can be sent. A question marked
 * `multiple` takes several labels; one marked `custom` (the default) also
 * accepts text the options did not offer, which is how a "none of these" answer
 * gets through.
 */
export function QuestionDialog(props: {
  request: PendingQuestion
  onAnswer: (requestID: string, answers: string[][] | undefined) => void
}) {
  const [chosen, setChosen] = createSignal<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.request.questions.map(() => ""))

  const answers = createMemo(() =>
    props.request.questions.map((_, index) => {
      const typed = custom()[index]?.trim()
      const picked = chosen()[index] ?? []
      return typed ? [...picked, typed] : picked
    }),
  )
  const complete = createMemo(() => answers().every((entry) => entry.length > 0))

  function toggle(index: number, label: string, multiple: boolean | undefined) {
    setChosen((current) =>
      current.map((entry, at) => {
        if (at !== index) return entry
        if (!multiple) return entry.includes(label) ? [] : [label]
        return entry.includes(label) ? entry.filter((value) => value !== label) : [...entry, label]
      }),
    )
  }

  return (
    <div class="oc oc-backdrop">
      <section class="oc-dialog oc-dialog-question">
        <header class="oc-dialog-head">
          <IconQuestion />
          <h2>
            {props.request.role} needs an answer
          </h2>
        </header>

        <div class="oc-dialog-body">
          <For each={props.request.questions}>
            {(question, index) => (
              <div class="question">
                <span class="oc-tag oc-faint">{question.header}</span>
                <p class="question-text">{question.question}</p>
                <div class="question-options">
                  <For each={question.options}>
                    {(option) => (
                      <button
                        type="button"
                        class="question-option"
                        data-chosen={chosen()[index()]?.includes(option.label) ? "yes" : undefined}
                        onClick={() => toggle(index(), option.label, question.multiple)}
                      >
                        <span class="question-option-label">{option.label}</span>
                        <Show when={option.description}>
                          <span class="question-option-hint">{option.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={question.custom !== false}>
                  <input
                    class="field"
                    placeholder="or type your own answer"
                    value={custom()[index()] ?? ""}
                    onInput={(event) =>
                      setCustom((current) =>
                        current.map((value, at) => (at === index() ? event.currentTarget.value : value)),
                      )
                    }
                  />
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="oc-form-actions">
          <button
            type="button"
            class="oc-button oc-primary"
            disabled={!complete()}
            onClick={() => props.onAnswer(props.request.requestID, answers())}
          >
            Send answer
          </button>
          <button
            type="button"
            class="oc-button"
            title="the card is told nobody answered and continues on its own assumption"
            onClick={() => props.onAnswer(props.request.requestID, undefined)}
          >
            Skip
          </button>
        </div>
      </section>
    </div>
  )
}
