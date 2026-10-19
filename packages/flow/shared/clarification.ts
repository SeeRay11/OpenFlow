/**
 * A clarifying question the uplift planner drafted. The host passes them
 * through from ultrathink's `SessionRecord.clarifications`; the UI may render
 * them, the engine never answers them on the user's behalf.
 */
export type ClarificationInfo = {
  id: string
  header: string
  question: string
  /** Why the answer would change the work. */
  why?: string
  blocking: boolean
  options: Array<{ label: string; description?: string }>
  default?: string
}
