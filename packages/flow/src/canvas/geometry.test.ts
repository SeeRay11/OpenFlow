import { describe, expect, test } from "bun:test"
import { bezier, inPort, NODE_WIDTH, outPort, PORT_Y } from "./geometry"

describe("ports", () => {
  test("the input port sits on the node's left edge", () => {
    expect(inPort({ x: 100, y: 200 })).toEqual({ x: 100, y: 200 + PORT_Y })
  })

  test("the output port sits on the right edge, at the same height", () => {
    expect(outPort({ x: 100, y: 200 })).toEqual({ x: 100 + NODE_WIDTH, y: 200 + PORT_Y })
    expect(outPort({ x: 0, y: 0 }).y).toBe(inPort({ x: 0, y: 0 }).y)
  })
})

describe("bezier", () => {
  test("starts and ends on the two points", () => {
    const path = bezier({ x: 0, y: 0 }, { x: 300, y: 100 })
    expect(path.startsWith("M 0 0 ")).toBe(true)
    expect(path.endsWith(" 300 100")).toBe(true)
  })

  test("control points scale with the horizontal gap", () => {
    expect(bezier({ x: 0, y: 0 }, { x: 400, y: 0 })).toContain("C 200 0, 200 0")
  })

  test("keeps a minimum bow so a short or backwards edge is still a curve", () => {
    expect(bezier({ x: 0, y: 0 }, { x: 10, y: 0 })).toContain("C 40 0, -30 0")
    expect(bezier({ x: 300, y: 0 }, { x: 0, y: 0 })).toContain("C 450 0, -150 0")
  })
})
