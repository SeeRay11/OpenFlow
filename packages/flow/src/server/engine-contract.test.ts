import { defineEngineContract } from "./engine-contract"
import { createFakeEngine } from "./testing/fake-engine"

/** The in-memory engine against the shared contract; `lib/host/engine-contract.test.ts` runs the same suite on the real adapter. */
defineEngineContract("fake engine", async () => {
  const engine = createFakeEngine()
  return {
    api: engine,
    driver: engine.driver,
    directory: "/fake/project",
    close: () => engine.close(),
    leftovers: async () => engine.driver.live(),
  }
})
