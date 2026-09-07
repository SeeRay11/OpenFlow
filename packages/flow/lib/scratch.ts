import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Somewhere for a card to put output that is not the work.
 *
 * The write refusal a critic and an orchestrator run under is **soft**: it
 * stops the write tools, not the shell, and a redirect writes a file. Measured
 * on this fork's first gauntlet, a file literally named `0` appeared in the
 * deliverable folder holding the orchestrator's own grep diagnostics — it was
 * investigating exactly what it should have been investigating, and a `2>0`
 * style redirect dropped the output into the project as a file.
 *
 * Refusing `bash` is not the answer: that was tried and it broke the critic's
 * own verification, which is the entire method. So the cards get a directory
 * outside the project instead, and are told about it. It cannot be enforced —
 * nothing here can stop a redirect from naming another path — but a card given
 * a place to put scratch output has no reason to leave it in the deliverable,
 * and one never told has nowhere else to put it.
 */

/** One per run, outside the project, so nothing here can ever be mistaken for the work. */
export function scratchRoot(runID: string) {
  return path.join(os.tmpdir(), "openflow-scratch", runID.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80))
}

/** Makes it, and hands back the path to put in the briefing. Undefined if it cannot be made. */
export async function openScratch(runID: string) {
  const dir = scratchRoot(runID)
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => dir)
    .catch(() => undefined)
}

/**
 * Removes a run's scratch directory.
 *
 * Unlike a checkpoint, this is worth nothing once the run is over: it holds
 * greps and diagnostics that were only ever meaningful to the card that wrote
 * them mid-round. Cleaned when the run's recording is deleted, which is also
 * when the checkpoints go, so a user tidying up gets both.
 */
export async function dropScratch(runID: string) {
  await fs.rm(scratchRoot(runID), { recursive: true, force: true }).catch(() => {})
}
