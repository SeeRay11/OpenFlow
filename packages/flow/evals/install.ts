/**
 * Writes every corpus canvas into a project, ready to open and run.
 *
 * The corpus is TypeScript, not a folder of JSON, because the cases are built
 * from the shipped templates and a checked-in copy would drift from them
 * silently. This turns it into the pipeline files the store serves, so the
 * paid half of the eval is "open each of these and press Run" rather than
 * "rebuild six canvases by hand and hope they match".
 *
 *   bun evals/install.ts <project directory>
 */

import fs from "node:fs/promises"
import path from "node:path"
import { CORPUS } from "../src/graph/corpus"
import { shapeOf } from "../src/graph/evals"

const project = process.argv[2]
if (!project) {
  console.error("usage: bun evals/install.ts <project directory>")
  process.exit(1)
}

const dir = path.join(project, ".openflow", "pipelines")
await fs.mkdir(dir, { recursive: true })
for (const entry of CORPUS) {
  // The file is addressed by the case id, so a scorecard row and the canvas
  // that produced it are named the same thing.
  const pipeline = { ...entry.pipeline, name: entry.id }
  await fs.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(pipeline, null, 2) + "\n", "utf8")
  console.log(`${entry.id.padEnd(24)} ${shapeOf(entry.pipeline)}`)
}
console.log(`\n${CORPUS.length} canvases written to ${dir}`)
