import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * A stand-in `omp` executable for the tests of this module: a real file the
 * module really executes, answering the `omp config` CLI the way omp 18.12.2 was
 * observed to (see `config.ts`). Settings live in `<dir>/state.json`, every call
 * is appended to `<dir>/calls.jsonl`, and `set` / `reset` / `get` echo the value
 * on stdout exactly like the real binary does, so a leak shows up as a failure.
 */

const SCRIPT = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"

const dir = path.dirname(process.argv[1])
const argv = process.argv.slice(2)
appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, leaked: Object.keys(process.env).filter((name) => /^(SUBSTRATE_|SWARM_|OPENROUTER_|ANTHROPIC_)/.test(name)) }) + "\n")

const VERSION = process.env.FAKE_OMP_VERSION ?? "18.12.2"
const SCHEMA = [
  ["appearance", "symbolPreset", "enum", "unicode", ["unicode", "nerd", "ascii"], "Glyph set"],
  ["appearance", "colorBlindMode", "boolean", false, undefined, "Color blind mode"],
  ["context", "compaction.thresholdPercent", "number", -1, undefined, "Threshold"],
  ["context", "theme.dark", "string", "titanium", undefined, "Dark theme"],
  ["internal", "auth.broker.token", "string", undefined, undefined, ""],
  ["internal", "enabledProviders", "array", [], undefined, ""],
  ["internal", "modelRoles", "record", {}, undefined, ""],
]
const statePath = path.join(dir, "state.json")
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
const save = () => writeFileSync(statePath, JSON.stringify(state))
const fail = (message) => {
  console.error("Error: " + message)
  process.exit(1)
}
const find = (key) => SCHEMA.find((row) => row[1] === key) ?? fail("Unknown setting: " + key)
const current = (row) => (row[1] in state ? state[row[1]] : row[3])
const shape = (row) => (row[2] === "enum" ? row[4].join("|") : row[2])

let rest = argv
let profile = ""
if (rest[0] === "--profile") {
  profile = rest[1]
  rest = rest.slice(2)
}
if (rest[0] === "--version") {
  console.log("omp/" + VERSION)
  process.exit(0)
}
if (rest[0] === "auth") {
  const readFlag = (name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : undefined)
  if (readFlag("hang") !== undefined) {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    writeFileSync(path.join(dir, "pids.json"), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))
    setInterval(() => {}, 1000)
  } else if (rest[1] === "export") {
    const store = path.join(dir, "credentials.json")
    if (readFlag("fail-export") !== undefined || !existsSync(store)) fail("No stored credentials")
    process.stdout.write(readFileSync(store))
    process.exit(0)
  } else if (rest[1] === "import" && rest[2] === "-") {
    const input = readFileSync(0)
    const failure = readFlag("fail-import")
    if (failure !== undefined) fail(failure)
    try {
      JSON.parse(input.toString("utf8"))
    } catch {
      fail("not a credentials file")
    }
    const target = path.join(dir, "profiles", profile || "default")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "credentials.json"), input)
    process.exit(0)
  } else fail("unsupported auth call")
} else if (rest[0] !== "config") fail("unsupported: " + rest.join(" "))
const [, action, key, ...values] = rest

if (rest[0] === "auth") {
  // Only the hanging variant gets here; the event loop stays alive on purpose.
} else if (action === "path") console.log(path.join(dir, "profiles", profile || "default", "agent"))
else if (action === "list" && key === "--json") {
  const out = {}
  for (const row of SCHEMA) {
    const value = current(row)
    const item = { type: row[2], description: row[5] }
    if (row[1] === "auth.broker.token") {
      if (value !== undefined) item.redacted = true
    } else if (value !== undefined) item.value = value
    out[row[1]] = item
  }
  console.log(JSON.stringify(out, null, 2))
} else if (action === "list") {
  const lines = ["Settings:"]
  let group
  for (const row of SCHEMA) {
    if (row[0] !== group) {
      group = row[0]
      lines.push("", "[" + group + "]")
    }
    const value = current(row)
    const text = row[1] === "auth.broker.token" ? (value === undefined ? "(not set)" : "********") : value === undefined ? "(not set)" : typeof value === "string" ? value : JSON.stringify(value)
    lines.push("  " + row[1] + " = " + text + " (" + shape(row) + ")")
  }
  console.log(lines.join("\n"))
} else if (action === "get") {
  const row = find(key)
  console.log(JSON.stringify({ key, value: current(row), type: row[2] }))
} else if (action === "set") {
  const row = find(key)
  const text = values[0] === "--" ? values[1] : values[0]
  if (text === undefined) fail("Usage: omp config set <key> <value>")
  let value = text
  if (row[2] === "boolean") {
    if (!["true", "false"].includes(text)) fail("Invalid boolean value: " + text)
    value = text === "true"
  } else if (row[2] === "number") {
    value = Number(text)
    if (!Number.isFinite(value)) fail("Invalid number: " + text)
  } else if (row[2] === "enum" && !row[4].includes(text)) fail("Invalid value: " + text + ". Valid values: " + row[4].join(", "))
  state[key] = value
  save()
  console.log("[ok] Set " + key + " = " + text)
} else if (action === "reset") {
  const row = find(key)
  delete state[key]
  save()
  console.log("[ok] Reset " + key + " to " + current(row))
} else fail("unsupported action " + action)
`

/** Writes the fake binary into `dir` and returns its absolute path. */
export async function installFakeOmp(dir: string, version = "18.12.2"): Promise<string> {
  await mkdir(dir, { recursive: true })
  const binary = path.join(dir, "omp")
  const versionLine = version === "18.12.2" ? "" : `process.env.FAKE_OMP_VERSION = ${JSON.stringify(version)}\n`
  await writeFile(binary, `#!${process.execPath}\n${versionLine}${SCRIPT}`)
  await chmod(binary, 0o755)
  return binary
}
