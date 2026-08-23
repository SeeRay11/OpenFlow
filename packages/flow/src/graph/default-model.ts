import { createSignal } from "solid-js"

/**
 * One default model preference, applied to every freshly dropped node so a
 * first-timer never has to open the picker before running.
 *
 * It is a preference, not a hardcoded role field, because model ids change and
 * are provider-gated: a role that named a model could name one whose provider
 * is locked. The signal is the source of truth; localStorage only persists it
 * across reloads, best-effort, the same way `roles.ts` treats custom roles.
 */
const KEY = "openflow.defaultModel.v1"

function load(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    // storage disabled — the session still works, it just won't remember.
    return undefined
  }
}

const [defaultModel, setStored] = createSignal<string | undefined>(load())
export { defaultModel }

export function setDefaultModel(id: string | undefined) {
  setStored(id)
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    // see load()
  }
}

/**
 * The models a node could actually run right now — the unlocked, runnable set
 * from the boot model fetch. The app keeps this current after every key change;
 * `nodeModel` reads it so the default is only applied when it is really usable.
 */
const [availableModels, setAvailableModels] = createSignal<Set<string>>(new Set())
export { availableModels, setAvailableModels }

/**
 * The model a freshly built node should carry: its role preset's own model if
 * it has one, otherwise the default — but only when that default is in the
 * available set. A default pointing at a now-locked model yields `undefined`,
 * leaving the node blank for preflight (F4) to flag rather than failing a run.
 */
export function nodeModel(
  presetModel: string | undefined,
  available: Set<string> = availableModels(),
  fallback: string | undefined = defaultModel(),
): string | undefined {
  if (presetModel) return presetModel
  if (fallback && available.has(fallback)) return fallback
  return undefined
}
