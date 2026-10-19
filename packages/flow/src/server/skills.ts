/** What the editor knows about the skill it holds: the folder it was opened from, and the name that folder's SKILL.md shows. */
export type SkillDraft = { original?: string; shown?: string; name: string; legacy?: boolean }

/**
 * How a skill save is addressed.
 *
 * A new skill, or one whose name was really changed, is addressed by the typed name and asks the
 * host to refuse a name that is already taken. An edit that leaves the name alone is addressed by
 * the folder the skill was opened from: a folder `my-skill` whose SKILL.md says `My Skill` is
 * not found under the shown name, and the host would take that for a different skill. A skill
 * from the old project folder (`legacy`) has no profile folder yet, so it keeps its own name.
 */
export function skillTarget(draft: SkillDraft) {
  const name = draft.name.trim()
  const renaming = !draft.original || (name !== draft.original && name !== draft.shown)
  return { name, create: renaming, address: renaming || draft.legacy ? name : draft.original! }
}
