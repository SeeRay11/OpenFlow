import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import { createLifecycle } from "../host/lifecycle"
import { alive, until } from "../uplift/testing/stub-planner"
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

  test("a probe stopped by the lifecycle's dispose dies with its group, answers 503 and is not cached as a missing omp", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-binary-test-"))
    dirs.push(dir)
    const binary = path.join(dir, "omp")
    const hang = path.join(dir, "hang")
    const pids = path.join(dir, "pid")
    writeFileSync(hang, "")
    writeFileSync(binary, `#!/bin/sh\nif [ -f "${hang}" ]; then echo $$ > "${pids}"; exec sleep 300; fi\necho omp/99.0.0\n`)
    chmodSync(binary, 0o755)
    const settings = { ...DEFAULT_OMP_SETTINGS, binary }
    const env = { PATH: process.env.PATH }
    const life = createLifecycle("test")

    const checking = checkOmp(settings, env, life).then(
      () => undefined,
      (error: unknown) => error,
    )
    await until(() => existsSync(pids) && readFileSync(pids, "utf8").endsWith("\n"))
    const pid = Number(readFileSync(pids, "utf8"))
    await life.dispose()

    expect(await alive(pid)).toBe(false)
    expect(await checking).toMatchObject({ status: 503 })
    // The refusal is for the closed host only: nothing was remembered about this omp.
    rmSync(hang)
    expect(await checkOmp(settings, env, life).then(() => undefined, (error: unknown) => error)).toMatchObject({ status: 503 })
    expect((await checkOmp(settings, env)).version).toBe("99.0.0")
  })
})
