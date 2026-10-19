/**
 * Operator script (not a test): proves shared memory against a REAL Agent Substrate.
 *
 *   bun lib/substrate/live-check.ts --pipeline demo [--project <dir>] [--repo owner/name]
 *
 * Reads SUBSTRATE_URL and the omp token the way the host does (SUBSTRATE_TOKEN,
 * SUBSTRATE_TOKEN_FILE, /etc/substrate/tokens/omp). It WRITES one fact into the
 * project's `repo:` scope and a retraction marker for it; the entry lapses on its 30d ttl.
 * Prints PASS/FAIL per step and never a token, header or URL path.
 *
 *   run A, card X : read (any answer but disabled) -> write a marker outcome (stored)
 *   run B, card Y : read -> the block contains run A's marker
 *   forget run A  : retracted; run B card Z reads without the marker
 */
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import { createSubstrate } from "./index"

const { values } = parseArgs({
  options: {
    pipeline: { type: "string", default: "demo" },
    project: { type: "string", default: process.cwd() },
    repo: { type: "string", default: "" },
  },
})

const pipeline = values.pipeline ?? "demo"
const suffix = randomBytes(4).toString("hex")
const marker = `livecheck-${suffix}`
const runA = `livecheck-a-${suffix}`
const runB = `livecheck-b-${suffix}`
// The ignore list is this script's own: a real run's `~/.openflow/memory-ignore.json` stays untouched.
const stateDir = await mkdtemp(join(tmpdir(), "openflow-live-check-"))

const substrate = createSubstrate({
  project: () => values.project ?? process.cwd(),
  settings: async () => ({
    ...DEFAULT_OMP_SETTINGS,
    memory: { ...DEFAULT_OMP_SETTINGS.memory, repo: values.repo ?? "" },
  }),
  env: { ...process.env, OPENFLOW_STATE_DIR: stateDir },
})

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures += 1
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`)
}

try {
  const status = await substrate.status()
  console.log(`substrate ${status.url ?? "(no url)"} surface=${status.surface} project=${status.project || "(none)"} ttl=${status.retention.ttl}`)
  check("status: enabled and reachable", status.enabled && status.reachable, status.problems.join(" | "))
  for (const problem of status.problems) console.log(`      problem: ${problem}`)
  if (!status.enabled || !status.reachable) throw new Error("memory is not usable; fix the problems above")

  const card = { pipeline, role: "live-check", query: "live check" }
  const first = await substrate.read({ ...card, runId: runA, nodeId: "x" })
  check("run A card X: read does not fail", first.status === "ok" || first.status === "empty", first.error)

  const written = await substrate.write({
    ...card,
    runId: runA,
    nodeId: "x",
    outcome: "done",
    output: `The live check marker is ${marker}.`,
  })
  check("run A card X: write is stored and verified", written.status === "stored", written.error ?? written.status)

  const second = await substrate.read({ ...card, runId: runB, nodeId: "y" })
  check("run B card Y: read returns run A's outcome", second.status === "ok" && second.block.includes(marker), second.error ?? `status ${second.status}`)
  check(
    "run B card Y: the item names run A / card X",
    second.items.some((item) => item.run === runA && item.card === "x" && item.origin === "search"),
  )

  const forgotten = await substrate.forget({ pipeline, runId: runA })
  check("forget run A: retracted without a marker error", forgotten.status === "retracted" && forgotten.retracted === 1 && !forgotten.error, forgotten.error ?? forgotten.status)

  const third = await substrate.read({ ...card, runId: runB, nodeId: "z" })
  check("run B card Z: run A's outcome is gone", !third.block.includes(marker), third.status)
} catch (error) {
  failures += 1
  console.log(`FAIL  ${error instanceof Error ? error.message : "unexpected error"}`)
} finally {
  await substrate.dispose()
  await rm(stateDir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nPASS: shared memory works end to end" : `\nFAIL: ${failures} check${failures === 1 ? "" : "s"} failed`)
process.exit(failures === 0 ? 0 : 1)
