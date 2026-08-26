import { describe, expect, test } from "bun:test"
import { launchPlan } from "./launch"

const repo = "/repo"

describe("launchPlan", () => {
  test("defaults to port 4096 and the localhost canvas", async () => {
    const plan = await launchPlan({ env: {}, repo })
    expect(plan.engineUrl).toBe("http://127.0.0.1:4096")
    expect(plan.canvasUrl).toBe("http://localhost:5174")
    expect(plan.engine.argv).toEqual([
      "bun",
      "run",
      "--cwd",
      "packages/opencode",
      "--conditions=browser",
      "src/index.ts",
      "serve",
      "--port",
      "4096",
    ])
    expect(plan.canvas.argv).toEqual(["bun", "--cwd", "packages/flow", "dev"])
    expect(plan.canvas.prebuild).toBeUndefined()
    expect(plan.built).toBe(false)
    expect(plan.managed).toBe(false)
  })

  test("OPENCODE_SERVER_URL wins and its port reaches the engine argv", async () => {
    const plan = await launchPlan({ env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4097" }, repo })
    expect(plan.engineUrl).toBe("http://127.0.0.1:4097")
    expect(plan.engine.argv.at(-1)).toBe("4097")
  })

  test("nothing is skipped when no port answers", async () => {
    const plan = await launchPlan({ env: {}, repo, probe: async () => false })
    expect(plan.engine.skip).toBe(false)
    expect(plan.canvas.skip).toBe(false)
  })

  test("a probe that reports the engine up skips only the engine", async () => {
    const plan = await launchPlan({ env: {}, repo, probe: async (url) => url.includes("4096") })
    expect(plan.engine.skip).toBe(true)
    expect(plan.canvas.skip).toBe(false)
  })

  test("a probe that reports the canvas up skips only the canvas", async () => {
    const plan = await launchPlan({ env: {}, repo, probe: async (url) => url.includes("5174") })
    expect(plan.engine.skip).toBe(false)
    expect(plan.canvas.skip).toBe(true)
  })

  test("OPENFLOW_BUILT builds then serves the bundle instead of running vite", async () => {
    const plan = await launchPlan({ env: { OPENFLOW_BUILT: "1" }, repo })
    expect(plan.built).toBe(true)
    expect(plan.canvas.prebuild).toEqual(["bun", "run", "--cwd", "packages/flow", "build"])
    expect(plan.canvas.argv).toEqual(["bun", "run", "--cwd", "packages/flow", "serve"])
    expect(plan.canvas.argv).not.toContain("dev")
  })

  test("built mode leaves the engine plan alone", async () => {
    const plan = await launchPlan({ env: { OPENFLOW_BUILT: "1", OPENCODE_SERVER_URL: "http://127.0.0.1:4097" }, repo })
    expect(plan.engine.skip).toBe(false)
    expect(plan.engine.argv.at(-1)).toBe("4097")
  })

  test("FLOW_MANAGE_SERVER hands the engine to the canvas, so the launcher skips it", async () => {
    const plan = await launchPlan({ env: { FLOW_MANAGE_SERVER: "1" }, repo, probe: async () => false })
    expect(plan.managed).toBe(true)
    expect(plan.engine.skip).toBe(true)
    expect(plan.canvas.skip).toBe(false)
  })

  test("a managed engine is never probed — nothing is serving it yet", async () => {
    const probed: string[] = []
    const plan = await launchPlan({
      env: { FLOW_MANAGE_SERVER: "1" },
      repo,
      probe: async (url) => {
        probed.push(url)
        return false
      },
    })
    expect(probed).toEqual([plan.canvasUrl])
  })

  test("built and manage combine, and the port override still reaches the engine argv", async () => {
    const plan = await launchPlan({
      env: { OPENFLOW_BUILT: "1", FLOW_MANAGE_SERVER: "1", OPENCODE_SERVER_URL: "http://127.0.0.1:4097" },
      repo,
    })
    expect(plan.built).toBe(true)
    expect(plan.managed).toBe(true)
    expect(plan.engineUrl).toBe("http://127.0.0.1:4097")
    expect(plan.engine.argv.at(-1)).toBe("4097")
    expect(plan.canvas.argv).toEqual(["bun", "run", "--cwd", "packages/flow", "serve"])
  })

  test("an explicitly off flag reads as off", async () => {
    const plan = await launchPlan({ env: { OPENFLOW_BUILT: "0", FLOW_MANAGE_SERVER: "false" }, repo })
    expect(plan.built).toBe(false)
    expect(plan.managed).toBe(false)
    expect(plan.canvas.argv).toEqual(["bun", "--cwd", "packages/flow", "dev"])
    expect(plan.engine.skip).toBe(false)
  })
})
