import { describe, expect, test } from "bun:test"
import path from "node:path"
import { install, installed, SERVER_NAME, serverEntry, uninstall } from "./dispatch-tool"

const ROOT = path.join("C:", "checkout", "packages", "flow")
const OTHER = path.join("D:", "moved", "packages", "flow")
const BUN = path.join("C:", "bun", "bun.exe")
const OTHER_BUN = path.join("D:", "bun", "bun.exe")

describe("serverEntry", () => {
  test("starts the server from this package with bun", () => {
    expect(serverEntry(ROOT, BUN)).toEqual({
      type: "local",
      command: [BUN, path.join(ROOT, "mcp", "dispatch.ts")],
      enabled: true,
    })
  })
})

describe("installed", () => {
  test("a config with nothing in it has no server", () => {
    expect(installed({}, ROOT, BUN)).toEqual({ present: false, current: false })
    expect(installed(undefined, ROOT, BUN)).toEqual({ present: false, current: false })
  })

  test("recognises its own entry", () => {
    expect(installed(install({}, ROOT, BUN).value, ROOT, BUN)).toEqual({ present: true, current: true })
  })

  test("an entry pointing at a checkout that moved is present but not current", () => {
    // Worse than nothing: the card is told the tool exists, the spawn fails,
    // and the failure reads as a broken model.
    const stale = install({}, OTHER, BUN).value
    expect(installed(stale, ROOT, BUN)).toEqual({ present: true, current: false })
  })
})

describe("install", () => {
  test("adds the server without touching anything else", () => {
    const before = { $schema: "x", mcp: { other: { type: "local", command: ["a"] } }, provider: { p: {} } }
    const after = install(before, ROOT, BUN)

    expect(after.changed).toBe(true)
    expect(after.value.mcp[SERVER_NAME]).toEqual(serverEntry(ROOT, BUN))
    expect(after.value.mcp.other).toEqual(before.mcp.other)
    expect(after.value.provider).toEqual(before.provider)
  })

  test("installing twice changes nothing the second time", () => {
    // The caller skips the write, and the engine restart, on `changed: false`.
    const once = install({}, ROOT, BUN)
    expect(install(once.value, ROOT, BUN).changed).toBe(false)
  })

  test("repoints a stale entry rather than leaving it", () => {
    const stale = install({}, OTHER, BUN)
    const fixed = install(stale.value, ROOT, BUN)
    expect(fixed.changed).toBe(true)
    expect(fixed.value.mcp[SERVER_NAME].command[1]).toBe(path.join(ROOT, "mcp", "dispatch.ts"))
  })

  test("does not mutate the config it was handed", () => {
    const before = { mcp: {} }
    install(before, ROOT, BUN)
    expect(before.mcp).toEqual({})
  })
})

describe("uninstall", () => {
  test("removes only our entry", () => {
    const config = install({ mcp: { other: { type: "local" } } }, ROOT, BUN).value
    const after = uninstall(config)

    expect(after.changed).toBe(true)
    expect(after.value.mcp[SERVER_NAME]).toBeUndefined()
    expect(after.value.mcp.other).toBeTruthy()
  })

  test("removing what is not there is not a change", () => {
    expect(uninstall({ mcp: {} }).changed).toBe(false)
    expect(uninstall({}).changed).toBe(false)
  })
})

describe("the runtime path", () => {
  // Measured: a bare `bun` command never started, because opencode spawns a
  // local MCP server without a shell and Windows does not resolve it through
  // PATHEXT. The card was offered the tool, called it correctly, and was told
  // "Unknown tool".
  test("is written absolute, never as a bare command name", () => {
    expect(serverEntry(ROOT, BUN).command[0]).toBe(BUN)
    expect(serverEntry(ROOT, BUN).command[0]).not.toBe("bun")
  })

  test("a config written by a different runtime is repointed", () => {
    const other = install({}, ROOT, OTHER_BUN).value
    expect(installed(other, ROOT, BUN)).toEqual({ present: true, current: false })
    expect(install(other, ROOT, BUN).changed).toBe(true)
  })
})
