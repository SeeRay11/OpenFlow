/** What the editor knows about the skill it holds: the folder it was opened from, and the name that folder's SKILL.md shows. */
export type SkillDraft = { original?: string; shown?: string; name: string; legacy?: boolean }

/**
 * The folder the host puts a new skill name in: `slug` in `lib/store.ts` (`src/` never imports `lib/`, so this is a copy;
 * the table in `skills.test.ts` holds the two together).
 */
export function folderOf(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\-_ .]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/^\.+|\.+$/g, "") || "untitled"
  )
}

/** The key the host gives a new MCP server name: `mcpName` in `lib/store.ts`, copied for the same reason. */
export function serverKeyOf(name: string) {
  return name.trim().replace(/[^a-zA-Z0-9-_]/g, "-")
}

/**
 * How a skill save is addressed.
 *
 * A new skill, or one moved to a different folder, is addressed by the typed name and asks the host to refuse a
 * name that is already taken. An edit that stays in the folder the skill was opened from is addressed by that
 * folder and asks for nothing: that covers the name left alone (a folder `my-skill` whose SKILL.md says
 * `My Skill` is not found under the shown name, and the host would take that for a different skill), and a
 * rename that only changes case or punctuation and so slugs to the same folder (the host would otherwise find
 * the skill's own folder and call it taken). A skill from the old project folder (`legacy`) has no profile
 * folder yet, so it keeps its own name.
 */
export function skillTarget(draft: SkillDraft) {
  const name = draft.name.trim()
  if (!draft.original) return { name, create: true, address: name }
  // Under its own name it is the plain migration into the profile; under any other the profile may already hold that name.
  if (draft.legacy) return { name, create: name !== draft.original && name !== draft.shown, address: name }
  const stays = name === draft.original || name === draft.shown || folderOf(name) === draft.original
  return stays ? { name, create: false, address: draft.original } : { name, create: true, address: name }
}

/**
 * How an MCP server save is addressed: a new key, or one that is not the stored key and does not reduce to it,
 * is created (refused when taken); typing the stored key, or something the host would reduce to it, is an edit
 * of the server as it is stored.
 */
export function mcpTarget(original: string | undefined, typed: string) {
  const name = typed.trim()
  if (!original) return { create: true, address: name }
  return name === original || serverKeyOf(name) === original ? { create: false, address: original } : { create: true, address: name }
}
