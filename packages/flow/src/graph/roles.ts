import { createSignal } from "solid-js"
import { store } from "../server/store"
import type { FlowAgent } from "./types"

export type Role = {
  id: string
  label: string
  color: string
  agent: FlowAgent
}

// the five colours below are opencode's own agent colours (plan, writer, build,
// review, explore) at their dark values, so a role reads the same here as it
// does in the app — do not "fix" them back to a generic palette.
export const ROLES: Role[] = [
  {
    id: "planner",
    label: "planner",
    color: "#f799c6",
    agent: {
      prompt:
        "You are the planner. Break the task into concrete, ordered steps. " +
        "Name the files and interfaces involved. Do not write implementation code. " +
        "End with a numbered plan.",
      tools: { read: true, grep: true, glob: true, edit: false, bash: false },
    },
  },
  {
    id: "architect",
    label: "architect",
    color: "#9e99f7",
    agent: {
      prompt:
        "You are the architect. Given the plan, decide module boundaries, data shapes, " +
        "and the public interfaces. Output signatures and file layout. No implementation.",
      tools: { read: true, grep: true, glob: true, edit: false, bash: false },
    },
  },
  {
    id: "coder",
    label: "coder",
    color: "#c3d4fd",
    agent: {
      prompt: "You are the coder. Implement exactly what the upstream plan and architecture specify. Keep diffs tight.",
      tools: { read: true, grep: true, glob: true, edit: true, bash: true },
    },
  },
  {
    id: "reviewer",
    label: "reviewer",
    color: "#b8e9c1",
    agent: {
      prompt:
        "You are the reviewer. Audit the upstream output for correctness bugs and missed requirements. " +
        "One line per finding, most severe first. No praise.",
      tools: { read: true, grep: true, glob: true, edit: false, bash: false },
    },
  },
  {
    id: "custom",
    label: "custom",
    color: "#f7e5b5",
    agent: { prompt: "", tools: {} },
  },
]

// User-defined roles, saved per project (not per-pipeline) so a role built once
// is reusable across every workflow in that project.
//
// The durable copy is `.openflow/roles.json`, written through the flow store.
// localStorage is kept as a same-machine mirror and as the migration source for
// roles saved before the store existed — it was the only home once, and
// clearing site data threw away every hand-written role prompt with no warning.
const CUSTOM_ROLES_KEY = "openflow.customRoles.v1"

function loadCustomRoles(): Role[] {
  try {
    const raw = localStorage.getItem(CUSTOM_ROLES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const [customRoles, setCustomRoles] = createSignal<Role[]>(loadCustomRoles())
export { customRoles }

/**
 * Write-through to localStorage. The signal stays the source of truth, so the
 * session works either way — but a `false` return means the role is gone on
 * reload, and every caller has to say so. Silently swallowing this loses a
 * hand-written prompt with the UI still showing it saved.
 */
function persistCustomRoles(roles: Role[]) {
  // The store is the durable copy, but it answers asynchronously and every
  // caller here is synchronous, so its failure is reported through `onSyncError`
  // rather than the return value. Returning the localStorage result keeps the
  // immediate answer honest: "this survives a reload on this machine".
  void store
    .saveRoles(roles)
    .catch((error) => syncError?.(error instanceof Error ? error.message : String(error)))
  try {
    localStorage.setItem(CUSTOM_ROLES_KEY, JSON.stringify(roles))
    return true
  } catch {
    return false
  }
}

let syncError: ((reason: string) => void) | undefined

/** Lets the app surface a failed write to `.openflow/roles.json` as a notice. */
export function onRolesSyncError(handler: (reason: string) => void) {
  syncError = handler
}

/**
 * Adopts the project's saved roles, and migrates a browser-only set the first
 * time a project that has none is opened.
 *
 * Called once at boot, before the palette renders — otherwise the palette
 * flashes the built-ins alone. A store that cannot be read leaves whatever
 * localStorage already gave the signal, so this never empties a working setup.
 */
export async function hydrateCustomRoles() {
  const stored = await store.roles().catch(() => undefined)
  if (!stored) return
  if (stored.length) return setCustomRoles(stored as Role[])
  // Nothing on disk yet: push up whatever this browser was holding, so a role
  // written before the store existed becomes a project file rather than staying
  // one cleared cache away from gone.
  if (customRoles().length) await store.saveRoles(customRoles()).catch(() => undefined)
}

export function isCustomRole(id: string) {
  return customRoles().some((entry) => entry.id === id)
}

/** Built-ins first, then whatever the user has saved, in the order they were added. */
export function allRoles(): Role[] {
  return [...ROLES, ...customRoles()]
}

/**
 * Creates or updates a saved role. The id doubles as the role's label, the
 * same convention the built-ins use — `roleColor` is looked up by the text a
 * node's `role` field holds, not a separate id, so keeping them equal is what
 * lets a custom role's colour resolve at all.
 *
 * Returns `persisted: false` when the role only made it into this session.
 */
export function saveCustomRole(input: { id?: string; label: string; color: string; agent: FlowAgent }) {
  const next: Role = { id: input.label, label: input.label, color: input.color, agent: input.agent }
  const merged = [...customRoles().filter((entry) => entry.id !== input.id && entry.id !== next.id), next]
  setCustomRoles(merged)
  return { role: next, persisted: persistCustomRoles(merged) }
}

/** Returns false when the deletion only applies to this session. */
export function removeCustomRole(id: string) {
  const next = customRoles().filter((entry) => entry.id !== id)
  setCustomRoles(next)
  return persistCustomRoles(next)
}

export function role(id: string) {
  return ROLES.find((entry) => entry.id === id) ?? customRoles().find((entry) => entry.id === id)
}

export function roleColor(id: string) {
  return role(id)?.color ?? "#aeaeae"
}
