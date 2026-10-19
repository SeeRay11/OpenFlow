import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { cleanScratch, goneWithin, scratch } from "./test-harness"

/**
 * The vite dev host runs under Node, and node-pty is what it spawns with, so
 * this runs `pty-node.ts` in a real `node` process (the file is written to be
 * strip-and-run). It is a long-lived child on purpose: the same node-pty is
 * what fails under Bun, and the difference only shows once a read finds no data.
 */

afterEach(cleanScratch)

// Real PTYs, `/bin/sh` and POSIX process groups: this does not run on Windows.
test.skipIf(process.platform === "win32")("node-pty backend under Node: long-lived output, input, resize, group hangup", async () => {
  const dir = await scratch()
  const entry = path.join(import.meta.dir, "pty-node.ts")
  const script = path.join(dir, "probe.mjs")
  await fs.writeFile(
    script,
    `
import { spawnNodePty } from ${JSON.stringify(entry)}
const proc = await spawnNodePty("/bin/sh", ["-c", "stty size; echo first; read x; stty size; echo got:$x; sleep 0.3; echo last; sleep 300 & echo CH:$!; wait"], {
  name: "xterm-256color", cols: 100, rows: 30, cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH },
})
let out = ""
let sent = false
let hung = false
proc.onData((data) => {
  out += data
  if (out.includes("first") && !sent) {
    sent = true
    proc.resize(120, 40)
    proc.write("hi\\n")
  }
  if (/CH:\\d+/.test(out) && !hung) {
    hung = true
    process.kill(-proc.pid, "SIGHUP")
  }
})
const exited = Promise.withResolvers()
proc.onExit(exited.resolve)
const exit = await exited.promise
console.log(JSON.stringify({ out, exit }))
`,
  )
  const child = Bun.spawn(["node", "--no-warnings", script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })

  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { out: string; exit: { exitCode: number; signal?: number } }
  expect(result.out).toContain("30 100\r\nfirst")
  expect(result.out).toContain("40 120")
  expect(result.out).toContain("got:hi")
  expect(result.out).toContain("last")
  expect(result.exit.signal).toBe(1)
  const grandchild = Number(/CH:(\d+)/.exec(result.out)![1])
  expect(await goneWithin(grandchild)).toBe(true)
})
