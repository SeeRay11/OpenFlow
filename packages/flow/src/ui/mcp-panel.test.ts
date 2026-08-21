import { describe, expect, test } from "bun:test"
import { splitCommand } from "./mcp-panel"

/**
 * The command box takes one line and the config stores argv, so this split is
 * the only thing between a typed command and a server that fails to start.
 */
describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("bunx -y @upstash/context7-mcp")).toEqual(["bunx", "-y", "@upstash/context7-mcp"])
  })

  test("keeps a quoted path with spaces in one argument", () => {
    expect(splitCommand('node "C:\Program Files\mcp\server.js" --port 3000')).toEqual([
      "node",
      "C:\Program Files\mcp\server.js",
      "--port",
      "3000",
    ])
  })

  test("keeps a deliberately empty argument", () => {
    expect(splitCommand('run --flag ""')).toEqual(["run", "--flag", ""])
  })

  test("collapses runs of whitespace and trims", () => {
    expect(splitCommand("  a   b  ")).toEqual(["a", "b"])
  })
})
