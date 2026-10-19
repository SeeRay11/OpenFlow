import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Fails when a fork-owned file still mentions the OpenCode engine OpenFlow
 * replaced with Omp.
 *
 * Only the fork-owned surfaces are scanned (`SURFACES`). Everything else under
 * `packages/*` is a vendored upstream that says OpenCode everywhere on purpose
 * and must not be touched, so it is never read.
 *
 *   bun scripts/check-no-opencode.ts            # the repo this file lives in
 *   bun scripts/check-no-opencode.ts <root>     # any tree laid out like the repo
 *
 * Exit 0 prints `check:no-opencode: clean (N allowlisted files)`. Exit 1 prints
 * one `path:line: text` per hit (line 0 is the path itself). On the repo, an
 * allowlist entry that no longer matches anything also fails, so the list
 * cannot outlive the thing it excused.
 */

/** One file (or a directory prefix ending in `/`) allowed to mention the removed engine, and why. */
export type Allowed = {
  /** Repo-relative, forward slashes. */
  path: string
  reason: string
  /** Narrows the entry to lines that match: everything else in the file is still a hit. */
  pattern?: RegExp
}

export const ALLOWLIST: readonly Allowed[] = [
  { path: "packages/flow/CHANGELOG.md", reason: "history: released versions describe the removed engine" },
  { path: "packages/flow/GAUNTLET-FIELD-LOG.md", reason: "history: a field log written against the removed engine" },
  { path: "packages/flow/docs/", reason: "history: plans written for the removed engine, bannered as such" },
  { path: "packages/flow/src/graph/migrate.ts", reason: "legacy-pipeline migration: it has to recognise the removed engine's ids, agents and sessions" },
  { path: "packages/flow/src/graph/migrate.test.ts", reason: "legacy-pipeline migration tests: they feed it the removed engine's ids" },
  { path: "packages/flow/src/graph/__fixtures__/legacy/", reason: "documents saved by the removed engine: the migration's real input" },
  { path: "packages/flow/lib/launch.test.ts", pattern: /OPENCODE_SERVER_URL/, reason: "asserts a retired variable no longer changes the launch plan" },
  { path: "packages/flow/src/graph/prompt.test.ts", pattern: /names opencode|not\.toContain\("opencode"\)/, reason: "asserts no prompt names the removed engine" },
  { path: "packages/flow/package.json", pattern: /check:no-opencode/, reason: "the script entry that runs this gate" },
  { path: "packages/flow/scripts/check-no-opencode.ts", reason: "this script names what it looks for" },
  { path: "packages/flow/scripts/check-no-opencode.test.ts", reason: "its test plants strays to prove the gate fails" },
  { path: "FLOW.md", pattern: /vendored|upstream|check[:-]no-opencode/i, reason: "states vendored-upstream facts and names this gate" },
  { path: ".github/workflows/test.yml", reason: "upstream CI" },
  { path: ".github/actions/setup-git-committer/action.yml", reason: "upstream CI" },
  { path: ".github/ISSUE_TEMPLATE/bug-report.yml", reason: "upstream issue template" },
]

/** Fork-owned, repo-relative: a directory is walked, a file is read. Absent ones are skipped. */
const SURFACES = [
  "packages/flow",
  "openflow.ts",
  "openflow.sh",
  "openflow.ps1",
  ".claude/launch.json",
  "FLOW.md",
  ".github",
  ".openflow/pipelines",
]

const SKIPPED_DIRECTORIES: Record<string, true> = { node_modules: true, dist: true, ".git": true }
const BINARY = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|ico|pdf|zip|gz)$/i
const REMOVED = /opencode/i
const SHOWN_CHARS = 200

export type Hit = { file: string; line: number; text: string }

export type Report = {
  hits: Hit[]
  /** Files whose every mention was excused by the allowlist. */
  allowedFiles: string[]
  /** Entries that excused nothing. */
  unused: Allowed[]
}

async function walk(root: string, relative: string, found: string[]) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => undefined)
  if (!entries) return
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = `${relative}/${entry.name}`
    if (entry.isDirectory() && !Object.hasOwn(SKIPPED_DIRECTORIES, entry.name)) await walk(root, next, found)
    if (entry.isFile() && !BINARY.test(entry.name)) found.push(next)
  }
}

async function collect(root: string) {
  const found: string[] = []
  for (const surface of SURFACES) {
    const entries = await readdir(path.join(root, path.dirname(surface)), { withFileTypes: true }).catch(() => [])
    const entry = entries.find((candidate) => candidate.name === path.basename(surface))
    if (entry?.isDirectory()) await walk(root, surface, found)
    if (entry?.isFile()) found.push(surface)
  }
  return found
}

/** Every mention of the removed engine under `root` that the allowlist does not excuse. */
export async function scan(root: string, allow: readonly Allowed[] = ALLOWLIST): Promise<Report> {
  const hits: Hit[] = []
  const used = new Set<Allowed>()
  const allowedFiles: string[] = []

  for (const file of await collect(root)) {
    const candidates = allow.filter((entry) => (entry.path.endsWith("/") ? file.startsWith(entry.path) : file === entry.path))
    let excused = false
    const check = (line: number, text: string) => {
      if (!REMOVED.test(text)) return
      const entry = candidates.find((candidate) => !candidate.pattern || candidate.pattern.test(text))
      if (!entry) return void hits.push({ file, line, text: text.trim().slice(0, SHOWN_CHARS) })
      used.add(entry)
      excused = true
    }

    // The path itself counts: a file called `x.opencode.json` is as stale as a line that says so.
    check(0, file)
    const content = await readFile(path.join(root, file))
    if (content.includes(0)) continue
    const lines = content.toString("utf8").split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) check(index + 1, lines[index])
    if (excused) allowedFiles.push(file)
  }

  return { hits, allowedFiles, unused: allow.filter((entry) => !used.has(entry)) }
}

const repoRoot = path.resolve(import.meta.dir, "../../..")

export async function main(argv: string[]) {
  const given = argv[0]
  const report = await scan(given ? path.resolve(given) : repoRoot)
  // A tree other than this repo cannot be expected to hold every allowlisted path.
  const unused = given ? [] : report.unused

  for (const hit of report.hits) console.error(`${hit.file}:${hit.line}: ${hit.text}`)
  for (const entry of unused) console.error(`allowlist: ${entry.path} excuses nothing; remove it (${entry.reason})`)
  if (report.hits.length || unused.length) {
    console.error(`check:no-opencode: ${report.hits.length} hit(s), ${unused.length} stale allowlist entr${unused.length === 1 ? "y" : "ies"}`)
    return 1
  }
  console.log(`check:no-opencode: clean (${report.allowedFiles.length} allowlisted files)`)
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
