import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ALLOWLIST, scan, type Allowed } from "./check-no-opencode"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-gate-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function put(file: string, text: string) {
  const target = path.join(root, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, text)
}

async function run(...argv: string[]) {
  const child = Bun.spawn(["bun", path.join(import.meta.dir, "check-no-opencode.ts"), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

describe("scan", () => {
  test("a clean tree has no hits", async () => {
    await put("packages/flow/src/app.ts", "export const engine = 'omp'\n")
    await put("FLOW.md", "# rules\n")
    const report = await scan(root, [])
    expect(report.hits).toEqual([])
    expect(report.allowedFiles).toEqual([])
  })

  test("a stray mention is a hit at its file and line, in any case", async () => {
    await put("packages/flow/src/app.ts", "const a = 1\nconst b = 2\n// talks to OpenCode here\n")
    const report = await scan(root, [])
    expect(report.hits).toEqual([{ file: "packages/flow/src/app.ts", line: 3, text: "// talks to OpenCode here" }])
  })

  test("every fork-owned surface is read", async () => {
    await put("packages/flow/README.md", "opencode\n")
    await put("openflow.ts", "opencode\n")
    await put("openflow.sh", "opencode\n")
    await put("openflow.ps1", "opencode\n")
    await put(".claude/launch.json", '{"name": "opencode-server"}\n')
    await put("FLOW.md", "opencode\n")
    await put(".github/workflows/openflow.yml", "run: opencode\n")
    await put(".openflow/pipelines/p.json", '{"model": "opencode/x"}\n')
    const files = (await scan(root, [])).hits.map((hit) => hit.file).sort()
    expect(files).toEqual([
      ".claude/launch.json",
      ".github/workflows/openflow.yml",
      ".openflow/pipelines/p.json",
      "FLOW.md",
      "openflow.ps1",
      "openflow.sh",
      "openflow.ts",
      "packages/flow/README.md",
    ])
  })

  test("vendored packages, dependencies and build output are never read", async () => {
    await put("packages/opencode/src/index.ts", "opencode\n")
    await put("packages/web/page.ts", "opencode\n")
    await put("packages/flow/node_modules/dep/index.js", "opencode\n")
    await put("packages/flow/dist/app.js", "opencode\n")
    await put(".openflow/runs/run-1.json", "opencode\n")
    await put("README.md", "opencode\n")
    expect((await scan(root, [])).hits).toEqual([])
  })

  test("a path that names the removed engine is a hit on line 0", async () => {
    await put("packages/flow/src/opencode-client.ts", "export {}\n")
    expect((await scan(root, [])).hits).toEqual([{ file: "packages/flow/src/opencode-client.ts", line: 0, text: "packages/flow/src/opencode-client.ts" }])
  })

  test("binary files are skipped", async () => {
    const target = path.join(root, "packages/flow/public/blob.dat")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from([0, 1, 2, ...Buffer.from("opencode"), 0]))
    expect((await scan(root, [])).hits).toEqual([])
  })
})

describe("the allowlist", () => {
  const history: Allowed = { path: "packages/flow/CHANGELOG.md", reason: "history" }

  test("excuses an exact file, and counts it", async () => {
    await put("packages/flow/CHANGELOG.md", "- removed opencode\n")
    const report = await scan(root, [history])
    expect(report.hits).toEqual([])
    expect(report.allowedFiles).toEqual(["packages/flow/CHANGELOG.md"])
  })

  test("excuses a directory prefix but not a sibling that merely starts the same", async () => {
    await put("packages/flow/docs/plan.md", "opencode\n")
    await put("packages/flow/docs-extra/plan.md", "opencode\n")
    const report = await scan(root, [{ path: "packages/flow/docs/", reason: "history" }])
    expect(report.hits.map((hit) => hit.file)).toEqual(["packages/flow/docs-extra/plan.md"])
  })

  test("a pattern excuses only the lines it matches", async () => {
    await put("FLOW.md", "a vendored fork of opencode\nthe engine is opencode serve\n")
    const report = await scan(root, [{ path: "FLOW.md", pattern: /vendored/, reason: "upstream fact" }])
    expect(report.hits).toEqual([{ file: "FLOW.md", line: 2, text: "the engine is opencode serve" }])
  })

  test("reports an entry that excused nothing", async () => {
    await put("packages/flow/src/app.ts", "export {}\n")
    const report = await scan(root, [history])
    expect(report.unused).toEqual([history])
  })

  test("every entry says why, and names a path inside a fork-owned surface", () => {
    const surfaces = ["packages/flow/", "FLOW.md", ".github/"]
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      expect(surfaces.some((surface) => entry.path.startsWith(surface))).toBe(true)
    }
  })
})

describe("the command", () => {
  test("fails with one `path:line: text` per hit", async () => {
    await put("packages/flow/src/app.ts", "const a = 1\n// opencode serve\n")
    const result = await run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("packages/flow/src/app.ts:2: // opencode serve")
    expect(result.stdout).not.toContain("clean")
  })

  test("passes on a clean tree and says how many files were excused", async () => {
    await put("packages/flow/src/app.ts", "export const engine = 'omp'\n")
    await put("packages/flow/CHANGELOG.md", "- removed opencode\n")
    const result = await run(root)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("check:no-opencode: clean (1 allowlisted files)")
  })
})
