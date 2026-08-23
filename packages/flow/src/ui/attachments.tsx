import { For, Show } from "solid-js"
import type { Attachment } from "../graph/types"
import { state } from "../state"
import { IconClose, IconPaperclip } from "./icons"

/**
 * Files a run (or one card) carries.
 *
 * Everything is read into a `data:` URL in the browser and sent inline with the
 * prompt. That is what the server accepts, and it means no upload endpoint, no
 * temp file on the host, and nothing left behind after a run. The cost is size:
 * base64 inflates by a third and the whole prompt travels through the dev
 * proxy, so anything over `MAX_ATTACHMENT` on its own, or over
 * `ATTACHMENT_BUDGET` in total, is refused with a reason rather than failing
 * later as an opaque request error.
 */
export const MAX_ATTACHMENT = 4 * 1024 * 1024

/**
 * Ceiling on everything attached at once, run files plus every node's pinned
 * files.
 *
 * Both hosts cap a request body at 8 MB (`server.ts`, `vite/flow-store.ts`) and
 * attachments travel inline as base64, which inflates raw bytes by 4/3 — so 5 MB
 * of files is already ~6.7 MB of JSON, leaving the rest of the pipeline about
 * 1.3 MB. Crossing the cap does not fail the attach, it fails every later
 * `PUT /flow/api/pipelines/:name`: an already-saved pipeline that can never be
 * saved again, with no clue which file to drop. So the refusal happens here.
 */
export const ATTACHMENT_BUDGET = 5 * 1024 * 1024

export type AttachmentError = { name: string; reason: string }

/**
 * Which of `files` fit given `used` bytes already attached. Kept pure and
 * separate from the reading so the budget arithmetic is testable without a DOM.
 */
export function planAttachments<T extends { name: string; size: number }>(used: number, files: Iterable<T>) {
  const accepted: T[] = []
  const errors: AttachmentError[] = []
  let total = used
  for (const file of files) {
    const name = file.name || "pasted file"
    if (file.size > MAX_ATTACHMENT) {
      errors.push({
        name,
        reason: `${formatSize(file.size)} is over the ${formatSize(MAX_ATTACHMENT)} per-file limit`,
      })
      continue
    }
    if (total + file.size > ATTACHMENT_BUDGET) {
      errors.push({
        name,
        reason: `${formatSize(file.size)} would pass the ${formatSize(ATTACHMENT_BUDGET)} total attachment limit — ${formatSize(total)} is already attached. Remove an attachment before adding this one.`,
      })
      continue
    }
    total += file.size
    accepted.push(file)
  }
  return { accepted, errors }
}

/** Bytes already spoken for: the run's own files plus everything pinned to a node. */
function attachedBytes() {
  return [...state.attachments, ...state.pipeline.nodes.flatMap((node) => node.agent.attachments ?? [])].reduce(
    (total, file) => total + file.size,
    0,
  )
}

export async function readFiles(files: Iterable<File>): Promise<{
  attachments: Attachment[]
  errors: AttachmentError[]
}> {
  const plan = planAttachments(attachedBytes(), files)
  const attachments: Attachment[] = []
  const errors = [...plan.errors]
  for (const file of plan.accepted) {
    try {
      attachments.push({
        id: crypto.randomUUID(),
        // A pasted image arrives as a blob with no name at all.
        name: file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension(file.type)}`,
        mime: file.type || "application/octet-stream",
        url: await toDataUrl(file),
        size: file.size,
      })
    } catch (error) {
      errors.push({ name: file.name || "pasted file", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { attachments, errors }
}

function toDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"))
    reader.readAsDataURL(file)
  })
}

function extension(mime: string) {
  const tail = mime.split("/")[1]
  return tail ? tail.split("+")[0] : "bin"
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Files dropped or pasted into an element, if any. */
export function filesFrom(event: ClipboardEvent | DragEvent): File[] {
  const data = "clipboardData" in event ? event.clipboardData : event.dataTransfer
  if (!data) return []
  return Array.from(data.files ?? [])
}

/**
 * The attach button and the chips for what is attached.
 *
 * The chips carry a thumbnail for images because the whole point of attaching
 * one is that the user is looking at something specific, and a filename alone
 * ("Screenshot 2026-08-21 at 14.02.11.png") does not tell them which.
 */
export function Attachments(props: {
  files: Attachment[]
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  label?: string
  compact?: boolean
}) {
  let input!: HTMLInputElement
  return (
    <div class="attachments" classList={{ "attachments-compact": props.compact }}>
      <input
        ref={input}
        type="file"
        multiple
        class="attachments-input"
        onChange={(event) => {
          props.onAdd(Array.from(event.currentTarget.files ?? []))
          // Same file twice in a row must still fire a change event.
          event.currentTarget.value = ""
        }}
      />
      <button
        type="button"
        class="btn"
        title="attach files or images — you can also paste an image into the task field"
        onClick={() => input.click()}
      >
        <IconPaperclip />
        {props.label ?? "attach"}
      </button>
      <Show when={props.files.length}>
        <ul class="attachment-list">
          <For each={props.files}>
            {(file) => (
              <li class="attachment" title={`${file.name} · ${file.mime} · ${formatSize(file.size)}`}>
                <Show when={file.mime.startsWith("image/")}>
                  <img class="attachment-thumb" src={file.url} alt="" />
                </Show>
                <span class="attachment-name">{file.name}</span>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`remove ${file.name}`}
                  onClick={() => props.onRemove(file.id)}
                >
                  <IconClose />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
