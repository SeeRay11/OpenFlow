import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { GsdHealth } from "../../shared/harness"

export async function readGsdHealth(env: NodeJS.ProcessEnv = process.env): Promise<GsdHealth> {
  const file = env.GSD_CORE_VERSION_FILE || path.join(os.homedir(), ".agents", "gsd-core", "VERSION")
  try {
    const version = (await fs.readFile(file, "utf8")).trim()
    if (!version) return { installed: false, version: null, health: "unreadable", detail: `${file} is empty` }
    return { installed: true, version, health: "ok", detail: `gsd-core ${version}` }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : ""
    if (code === "ENOENT") return { installed: false, version: null, health: "missing", detail: `gsd-core VERSION was not found at ${file}` }
    return { installed: false, version: null, health: "unreadable", detail: `could not read ${file}` }
  }
}
