import { describe, expect, test } from "bun:test"
import { lockQuestion, onLock, switchFreeing } from "./project"
import { ProjectBusyError, type FlowPaths } from "./store"

const paths = { project: "/b", pipelines: "", runs: "", generated: "", skills: "" } satisfies FlowPaths
const busy = (sessions: string[]) => new ProjectBusyError("a run is still active in this project", sessions)

describe("a refused project switch", () => {
  test("with cards named, the user is asked how many", () => {
    expect(onLock(busy(["s1", "s2"]))).toEqual({ action: "ask", sessions: ["s1", "s2"], question: lockQuestion(["s1", "s2"]) })
    expect(lockQuestion(["s1", "s2"])).toContain("2 running card(s)")
  })

  test("with none named, only the host's sentence is shown", () => {
    expect(onLock(busy([]))).toEqual({ action: "show", text: "a run is still active in this project" })
  })

  test("any other failure is not a lock", () => {
    expect(onLock(new Error("boom"))).toBeUndefined()
  })

  test("yes stops each named card, then switches once more", async () => {
    const released: string[] = []
    let attempts = 0
    const result = await switchFreeing(
      async () => {
        attempts += 1
        if (attempts === 1) throw busy(["s1", "s2"])
        return paths
      },
      { confirm: () => true, release: async (id) => void released.push(id) },
    )
    expect(result).toBe(paths)
    expect(released.toSorted()).toEqual(["s1", "s2"])
    expect(attempts).toBe(2)
  })

  test("no leaves everything as it was", async () => {
    const released: string[] = []
    let attempts = 0
    const result = await switchFreeing(
      async () => {
        attempts += 1
        throw busy(["s1"])
      },
      { confirm: () => false, release: async (id) => void released.push(id) },
    )
    expect(result).toBeUndefined()
    expect(released).toEqual([])
    expect(attempts).toBe(1)
  })

  test("it is retried once only: a second refusal reaches the caller", async () => {
    let attempts = 0
    const switching = switchFreeing(
      async () => {
        attempts += 1
        throw busy(["s1"])
      },
      { confirm: () => true, release: async () => undefined },
    )
    await expect(switching).rejects.toThrow("still active")
    expect(attempts).toBe(2)
  })

  test("an empty lock is never offered, and other errors pass through unasked", async () => {
    let asked = 0
    const io = { confirm: () => (asked += 1) > 0, release: async () => undefined }
    await expect(switchFreeing(async () => Promise.reject(busy([])), io)).rejects.toThrow("still active")
    await expect(switchFreeing(async () => Promise.reject(new Error("nope")), io)).rejects.toThrow("nope")
    expect(asked).toBe(0)
  })
})
