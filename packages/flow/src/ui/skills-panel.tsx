import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { store, type SkillEntry } from "../server/store"
import { IconBack, IconClose, IconPlus, IconTrash } from "./icons"

/**
 * Author skills without leaving OpenFlow.
 *
 * A skill is a folder with a `SKILL.md` (frontmatter `name`/`description`, plus a
 * markdown body). Skills are written to the OpenFlow Omp profile's skills
 * directory, which Omp reads when a card's session starts — so a save applies to
 * the next card session, never one already running.
 *
 * Entries from the old `.openflow/skills` folder come back flagged `legacy`.
 * They stay listed so nothing silently disappears, open read-only, and move to
 * the profile when saved.
 */
export function SkillsPanel(props: {
  onClose: () => void
  onNotice: (kind: "info" | "error", text: string) => void
}) {
  const [skills, setSkills] = createSignal<SkillEntry[]>([])
  const [editing, setEditing] = createSignal<Draft>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  type Draft = { original?: string; name: string; description: string; content: string; legacy?: boolean }

  async function refresh() {
    setSkills(await store.skills().catch(() => []))
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
    setEditing({ name: "", description: "", content: "" })
  }

  async function open(entry: SkillEntry) {
    setError(undefined)
    setBusy(true)
    try {
      const doc = await store.skill(entry.name)
      setEditing({
        // The folder, not the display name — it is what the API addresses and
        // what `save` deletes if the name changes.
        original: doc.folder ?? entry.name,
        legacy: entry.legacy,
        name: doc.name ?? entry.name,
        description: doc.description ?? "",
        content: doc.content ?? "",
      })
    } catch (failure) {
      props.onNotice("error", failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function save(event: Event) {
    event.preventDefault()
    const draft = editing()
    if (!draft) return
    const name = draft.name.trim()
    if (!name) return setError("Give the skill a name.")
    if (!draft.description.trim()) return setError("Add a one-line description — it is how a card decides to use the skill.")
    setBusy(true)
    setError(undefined)
    try {
      const result = await store.saveSkill({
        name,
        description: draft.description,
        content: draft.content,
      })
      // The server slugs the name into a folder, so a renamed skill lands in a new
      // one. Drop the folder it came from, or the old copy stays on disk and the
      // agent sees two skills with the same body.
      let renamed = ""
      if (draft.original && !draft.legacy && draft.original !== result.name) {
        const old = await store.deleteSkill(draft.original)
        renamed = old.removed
          ? ` (renamed from ${draft.original})`
          : ` (the old skill ${draft.original} was not found, so it was not removed)`
      }
      await refresh()
      setEditing(undefined)
      const warn = result.error ? ` — but ${result.error}` : ""
      props.onNotice("info", `saved ${result.name}${renamed}${warn}. It applies to the next card session.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Deleting removes the skill's folder recursively and there is no undo, so the
   * button asks once rather than acting on a single click.
   */
  async function remove(draft: Draft) {
    if (!draft.original) return setEditing(undefined)
    if (!window.confirm(`Delete the skill "${draft.original}"? Its folder and SKILL.md are removed for good.`)) return
    setBusy(true)
    try {
      const result = await store.deleteSkill(draft.original)
      await refresh()
      if (!result.removed) return setError(`${draft.original} was not deleted: the OpenFlow Omp profile has no skill folder by that name`)
      setEditing(undefined)
      props.onNotice("info", `deleted ${draft.original}. It is gone from the next card session.`)
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

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <Show when={editing()}>
            <button type="button" class="oc-clear" aria-label="Back" onClick={() => setEditing(undefined)}>
              <IconBack />
            </button>
          </Show>
          <h2>{editing() ? (editing()!.original ? "Edit skill" : "New skill") : "Skills"}</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <Show when={editing()} fallback={<SkillList />}>
          {(draft) => <SkillForm draft={draft()} />}
        </Show>
      </section>
    </div>
  )

  function SkillList() {
    return (
      <>
        <div class="oc-banner">
          <span>
            Skills live in the OpenFlow Omp profile's skills directory. Omp loads them when a card's session starts, so a
            change applies to the next card session.
          </span>
          <button type="button" class="oc-button oc-primary" onClick={create}>
            <IconPlus /> New skill
          </button>
        </div>
        <div class="oc-dialog-body">
          <For each={skills()}>
            {(entry) => (
              <button type="button" class="oc-item" disabled={busy()} onClick={() => open(entry)}>
                <span class="oc-item-label">{entry.name}</span>
                <Show when={entry.description}>
                  <span class="oc-tag oc-faint">{entry.description}</span>
                </Show>
                <Show when={entry.legacy}>
                  <span class="oc-tag" title="stored in the old .openflow/skills folder">
                    legacy — save to migrate
                  </span>
                </Show>
              </button>
            )}
          </For>
          <Show when={!skills().length}>
            <div class="oc-menu-empty">No skills yet. Create one — it becomes a tool your cards can call.</div>
          </Show>
        </div>
      </>
    )
  }

  function SkillForm(item: { draft: Draft }) {
    return (
      <form class="oc-form" onSubmit={save}>
        <label>
          Name
          <input
            autofocus
            spellcheck={false}
            autocomplete="off"
            placeholder="summarize-thread"
            value={item.draft.name}
            onInput={(event) => patch({ name: event.currentTarget.value })}
          />
        </label>

        <label>
          Description
          <input
            spellcheck={false}
            placeholder="Condense a long thread into a few bullet points"
            value={item.draft.description}
            onInput={(event) => patch({ description: event.currentTarget.value })}
          />
        </label>

        <label>
          Instructions
          <textarea
            class="oc-textarea"
            rows={12}
            spellcheck={false}
            placeholder={"# When to use\n\nSteps and guidance the card follows when it invokes this skill."}
            value={item.draft.content}
            onInput={(event) => patch({ content: event.currentTarget.value })}
          />
        </label>

        <Show when={error()}>{(text) => <p class="oc-error">{text()}</p>}</Show>

        <div class="oc-form-actions">
          <button type="submit" class="oc-button oc-primary" disabled={busy()}>
            {item.draft.legacy ? "Save to migrate" : item.draft.original ? "Save skill" : "Create skill"}
          </button>
          <Show when={item.draft.original && !item.draft.legacy}>
            <button type="button" class="oc-button oc-danger" disabled={busy()} onClick={() => remove(item.draft)}>
              <IconTrash /> Delete
            </button>
          </Show>
        </div>

        <p class="oc-note oc-faint">
          {item.draft.legacy
            ? "This skill comes from the old .openflow/skills folder and is shown read-only. Save it to copy it into the profile; the next card session then loads it."
            : "Skills are read when a card's Omp session starts. A change applies to the next card session, not to one already running."}
        </p>
      </form>
    )
  }
}
