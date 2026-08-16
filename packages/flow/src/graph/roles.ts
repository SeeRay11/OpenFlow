import { createSignal } from "solid-js"
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

// User-defined roles, saved globally (not per-pipeline) so a role built once
// is reusable across every workflow. Kept flat in localStorage — this is a
// single-user desktop-style app with no backend concept of "my roles" yet.
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

function persistCustomRoles(roles: Role[]) {
  try {
    localStorage.setItem(CUSTOM_ROLES_KEY, JSON.stringify(roles))
  } catch {
    // storage disabled or full — the session still works, it just won't remember next time
  }
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
 */
export function saveCustomRole(input: { id?: string; label: string; color: string; agent: FlowAgent }) {
  const next: Role = { id: input.label, label: input.label, color: input.color, agent: input.agent }
  setCustomRoles((roles) => {
    const others = roles.filter((entry) => entry.id !== input.id && entry.id !== next.id)
    const merged = [...others, next]
    persistCustomRoles(merged)
    return merged
  })
  return next
}

export function removeCustomRole(id: string) {
  setCustomRoles((roles) => {
    const next = roles.filter((entry) => entry.id !== id)
    persistCustomRoles(next)
    return next
  })
}

export function role(id: string) {
  return ROLES.find((entry) => entry.id === id) ?? customRoles().find((entry) => entry.id === id)
}

export function roleColor(id: string) {
  return role(id)?.color ?? "#aeaeae"
}
