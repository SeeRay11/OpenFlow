import { describe, expect, test } from "bun:test"
import { launchPlan } from "./launch"

const repo = "/repo"

describe("launchPlan", () => {
  test("defaults to the localhost canvas under vite", async () => {
    const plan = await launchPlan({ env: {}, repo })
    expect(plan.canvasUrl).toBe("http://localhost:5174")
    expect(plan.canvas.argv).toEqual(["bun", "--cwd", "packages/flow", "dev"])
    expect(plan.canvas.prebuild).toBeUndefined()
    expect(plan.built).toBe(false)
  })

  test("plans a canvas and nothing else", async () => {
    const plan = await launchPlan({ env: {}, repo })
    expect(Object.keys(plan).sort()).toEqual(["built", "canvas", "canvasUrl"])
  })

  test("no engine variable changes the plan", async () => {
    const plain = await launchPlan({ env: {}, repo })
    const stale = await launchPlan({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4097", FLOW_MANAGE_SERVER: "1" },
      repo,
    })
    expect(stale).toEqual(plain)
  })

  test("nothing is skipped when the port does not answer", async () => {
    const plan = await launchPlan({ env: {}, repo, probe: async () => false })
    expect(plan.canvas.skip).toBe(false)
  })

  test("a probe that reports the canvas up skips it", async () => {
    const plan = await launchPlan({ env: {}, repo, probe: async (url) => url.includes("5174") })
    expect(plan.canvas.skip).toBe(true)
  })

  test("only the canvas is probed", async () => {
    const probed: string[] = []
    const plan = await launchPlan({
      env: {},
      repo,
      probe: async (url) => {
        probed.push(url)
        return false
      },
    })
    expect(probed).toEqual([plan.canvasUrl])
  })

  test("OPENFLOW_BUILT builds then serves the bundle instead of running vite", async () => {
    const plan = await launchPlan({ env: { OPENFLOW_BUILT: "1" }, repo })
    expect(plan.built).toBe(true)
    expect(plan.canvas.prebuild).toEqual(["bun", "run", "--cwd", "packages/flow", "build"])
    expect(plan.canvas.argv).toEqual(["bun", "run", "--cwd", "packages/flow", "serve"])
    expect(plan.canvas.argv).not.toContain("dev")
  })

  test("a reachable canvas is reused in built mode too, build included", async () => {
    const plan = await launchPlan({ env: { OPENFLOW_BUILT: "1" }, repo, probe: async () => true })
    expect(plan.canvas.skip).toBe(true)
    expect(plan.canvas.prebuild).toBeDefined()
  })

  test("an explicitly off flag reads as off", async () => {
    for (const value of ["0", "false", " FALSE ", ""]) {
      const plan = await launchPlan({ env: { OPENFLOW_BUILT: value }, repo })
      expect(plan.built).toBe(false)
      expect(plan.canvas.argv).toEqual(["bun", "--cwd", "packages/flow", "dev"])
    }
  })
})
