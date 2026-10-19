import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import { checkOmp, resetOmpCheck } from "./binary"

const dirs: string[] = []

afterEach(() => {
  resetOmpCheck()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An executable that answers `--version` only when none of the named variables reached it. */
function probe(secrets: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-binary-test-"))
  dirs.push(dir)
  const binary = path.join(dir, "omp")
  const leaked = secrets.map((name) => `"$${name}"`).join("")
  writeFileSync(binary, `#!/bin/sh\nif [ -n ${leaked} ]; then echo leaked; exit 0; fi\necho omp/99.0.0\n`)
  chmodSync(binary, 0o755)
  return binary
}

// The probe is a `#!/bin/sh` script; Windows cannot run that.
describe.skipIf(process.platform === "win32")("checkOmp", () => {
  test("the version probe runs the binary with the allowlisted environment, not the whole host environment", async () => {
    const binary = probe(["SOME_TOKEN", "SUBSTRATE_URL", "SWARM_ED25519_KEY"])
    const status = await checkOmp(
      { ...DEFAULT_OMP_SETTINGS, binary },
      { PATH: process.env.PATH, SOME_TOKEN: "t", SUBSTRATE_URL: "u", SWARM_ED25519_KEY: "k" },
    )
    expect(status.problems).toEqual([])
    expect(status.version).toBe("99.0.0")
  })
})
