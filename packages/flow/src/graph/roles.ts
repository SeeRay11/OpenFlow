import type { FlowAgent } from "./types"

export type Role = {
  id: string
  label: string
  color: string
  agent: FlowAgent
}

export const ROLES: Role[] = [
  {
    id: "planner",
    label: "planner",
    color: "#7aa2f7",
    agent: {
      prompt:
        "You are the planner. Break the task into concrete, ordered steps. " +
        "Name the files and interfaces involved. Do not write implementation code. " +
        "End with a numbered plan.",
      tools: { read: true, grep: true, glob: true, write: false, edit: false, bash: false },
    },
  },
  {
    id: "architect",
    label: "architect",
    color: "#bb9af7",
    agent: {
      prompt:
        "You are the architect. Given the plan, decide module boundaries, data shapes, " +
        "and the public interfaces. Output signatures and file layout. No implementation.",
      tools: { read: true, grep: true, glob: true, write: false, edit: false, bash: false },
    },
  },
  {
    id: "coder",
    label: "coder",
    color: "#9ece6a",
    agent: {
      prompt: "You are the coder. Implement exactly what the upstream plan and architecture specify. Keep diffs tight.",
      tools: { read: true, grep: true, glob: true, write: true, edit: true, bash: true },
    },
  },
  {
    id: "reviewer",
    label: "reviewer",
    color: "#e0af68",
    agent: {
      prompt:
        "You are the reviewer. Audit the upstream output for correctness bugs and missed requirements. " +
        "One line per finding, most severe first. No praise.",
      tools: { read: true, grep: true, glob: true, write: false, edit: false, bash: false },
    },
  },
  {
    id: "custom",
    label: "custom",
    color: "#7dcfff",
    agent: { prompt: "", tools: {} },
  },
]

export function role(id: string) {
  return ROLES.find((entry) => entry.id === id)
}

export function roleColor(id: string) {
  return role(id)?.color ?? "#7dcfff"
}
