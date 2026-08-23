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
})
