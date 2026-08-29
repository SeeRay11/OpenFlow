import { describe, expect, test } from "bun:test"
import { pipeline } from "./test-support"
import { emptyPipeline, modeOf, MODES, type Pipeline } from "./types"

describe("modeOf", () => {
  test("a canvas saved before modes existed reads as pipeline", () => {
    const graph = pipeline("a->b")
    expect(graph.mode).toBeUndefined()
    expect(modeOf(graph)).toBe("pipeline")
    expect(modeOf(emptyPipeline())).toBe("pipeline")
  })

  test("every declared mode round-trips", () => {
    for (const mode of MODES) expect(modeOf({ ...pipeline("a"), mode })).toBe(mode)
  })

  test("a mode this build does not know reads as pipeline, not as whatever came last", () => {
    // A hand-edited store file must open as the safest graph there is rather
    // than falling through a scheduler switch.
    const graph = { ...pipeline("a"), mode: "quantum" } as unknown as Pipeline
    expect(modeOf(graph)).toBe("pipeline")
  })
})
