/**
 * Turns run logs into a scorecard, and two scorecards into a report.
 *
 * The paid half of the eval corpus is a person opening each canvas in
 * `src/graph/corpus.ts`, giving it the task from `evals/README.md`, and pressing
 * Run. That is deliberate — see the note at the top of `src/graph/evals.ts`: an
 * eval harness that re-implemented the run would be measuring itself, and the
 * run log already carries every number this needs.
 *
 * This script is the free half around it:
 *
 *   bun evals/score.ts record <results.json> <case-id>=<run-id> ...
 *   bun evals/score.ts compare <baseline.json> <results.json>
 *
 * `record` reads the named run logs out of the project's `.openflow/runs` and
 * writes one scorecard file. `compare` prints what changed, regressions first.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { CORPUS } from "../src/graph/corpus"
import { compareScores, report, scoreRun, type Score } from "../src/graph/evals"
import type { RunLog } from "../src/graph/types"

const [command, ...rest] = process.argv.slice(2)

if (command === "record") await record(rest)
else if (command === "collect") await collect(rest)
else if (command === "compare") await compare(rest)
else {
  console.error("usage: bun evals/score.ts collect <out.json>")
  console.error("       bun evals/score.ts record <out.json> <case>=<run-id>...")
  console.error("       bun evals/score.ts compare <baseline.json> <results.json>")
  process.exit(1)
}

/**
 * Scores the newest finished run of each corpus case, without being told any
 * run ids.
 *
 * The canvases are installed under their case ids (`evals/install.ts`), so a
 * run log's `pipeline` field already says which case produced it. Collecting on
 * that rather than on ids typed by hand removes the one step of the paid half
 * where a person can silently mismatch a row and a run — and a scorecard
 * attributed to the wrong case is worse than a missing one, because it then
 * compares cleanly against the wrong baseline.
 *
 * A case that was never run is left out and named rather than recorded as a
 * failure: "not run" and "ran and failed" are different facts, and
 * `compareScores` already reports the first on its own.
 */
async function collect([out]: string[]) {
  if (!out) return fail("collect needs an output file")
  const logs = await readRuns()
  const scores: Score[] = []
  const missing: string[] = []
  for (const entry of CORPUS) {
    // Newest first, and only runs that ended: a log still marked `running` is
    // one the page abandoned, and scoring it would record a half-finished case
    // as this release's number.
    const mine = logs
      .filter((log) => log.pipeline === entry.id && log.status !== "running")
      .sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
    if (!mine.length) {
      missing.push(entry.id)
      continue
    }
    scores.push(scoreRun(entry.id, mine[0]))
  }
  await fs.writeFile(out, JSON.stringify(scores, null, 2) + "\n", "utf8")
  console.log(`collected ${scores.length} of ${CORPUS.length} case(s) into ${out}`)
  for (const score of scores) console.log(`  ${line(score)}`)
  if (missing.length) console.log(`not run: ${missing.join(", ")}`)
}

async function readRuns() {
  const files = await fs.readdir(runsDir()).catch(() => [] as string[])
  const logs: RunLog[] = []
  for (const file of files.filter((name) => name.startsWith("run-") && name.endsWith(".json"))) {
    const raw = await fs.readFile(path.join(runsDir(), file), "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const parsed = JSON.parse(raw) as RunLog
    if (parsed?.id) logs.push(parsed)
  }
  return logs
}

function runsDir() {
  return process.env.OPENFLOW_PROJECT
    ? path.join(process.env.OPENFLOW_PROJECT, ".openflow", "runs")
    : path.join(process.cwd(), ".openflow", "runs")
}

/** One scorecard row, as the terminal shows it. */
function line(score: Score) {
  return (
    `${score.id.padEnd(24)} ${score.status}${score.verdict ? ` (${score.verdict})` : ""}` +
    `${score.seconds === undefined ? "" : ` · ${score.seconds}s`}` +
    // Unpriced stays unpriced all the way to the terminal, for the reason it
    // stays unpriced everywhere else here.
    `${score.cost === undefined ? " · cost unknown" : ` · $${score.cost.toFixed(4)}`}` +
    `${score.rounds ? ` · ${score.rounds} round(s)` : ""}` +
    `${score.added === undefined ? "" : ` · +${score.added} −${score.removed}`}` +
    `${score.failed.length ? ` · failed: ${score.failed.join(", ")}` : ""}`
  )
}

async function record([out, ...pairs]: string[]) {
  if (!out || !pairs.length) return fail("record needs an output file and at least one <case>=<run-id>")
  const runs = runsDir()
  const scores: Score[] = []
  for (const pair of pairs) {
    const [id, run] = pair.split("=")
    if (!id || !run) return fail(`"${pair}" is not <case>=<run-id>`)
    const file = path.join(runs, `${run}.json`)
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (raw === undefined) return fail(`no run log at ${file}`)
    scores.push(scoreRun(id, JSON.parse(raw) as RunLog))
  }
  await fs.writeFile(out, JSON.stringify(scores, null, 2) + "\n", "utf8")
  console.log(`recorded ${scores.length} case(s) to ${out}`)
  for (const score of scores) console.log(`  ${line(score)}`)
}

async function compare([baseline, results]: string[]) {
  if (!baseline || !results) return fail("compare needs a baseline file and a results file")
  const before = JSON.parse(await fs.readFile(baseline, "utf8")) as Score[]
  const after = JSON.parse(await fs.readFile(results, "utf8")) as Score[]
  const changes = compareScores(before, after)
  console.log(report(changes))
  // A non-zero exit only for regressions, so this can gate a release without
  // failing on every line-count difference — which every real run will have.
  if (changes.some((change) => change.kind === "worse")) process.exit(1)
}

function fail(message: string) {
  console.error(message)
  process.exit(1)
}
