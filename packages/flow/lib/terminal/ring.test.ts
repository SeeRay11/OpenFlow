import { describe, expect, test } from "bun:test"
import { Ring } from "./ring"

describe("Ring", () => {
  test("replays everything retained, a tail from a cursor, nothing for the end and for -1", () => {
    const ring = new Ring(100)
    ring.push("hello ")
    ring.push("world")
    expect(ring.cursor).toBe(11)
    expect(ring.from(undefined)).toEqual({ text: "hello world", cursor: 11 })
    expect(ring.from(6)).toEqual({ text: "world", cursor: 11 })
    expect(ring.from(11)).toEqual({ text: "", cursor: 11 })
    expect(ring.from(500)).toEqual({ text: "", cursor: 11 })
    expect(ring.from(-1)).toEqual({ text: "", cursor: 11 })
    expect(ring.from(Number.NaN).text).toBe("hello world")
  })

  test("past its limit it keeps the tail and the cursor keeps counting", () => {
    const ring = new Ring(10)
    const seen: number[] = []
    for (let i = 0; i < 20; i++) {
      ring.push(`chunk${String(i).padStart(2, "0")}`)
      seen.push(ring.cursor)
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 7))
    expect(ring.cursor).toBe(140)
    const all = ring.from(undefined)
    expect(all.text.length).toBe(10)
    expect(all.text).toBe("chunk18chunk19".slice(-10))
    expect(ring.start).toBe(130)
  })

  test("a cursor older than the retained start gets the oldest tail held", () => {
    const ring = new Ring(5)
    ring.push("abcdefghij")
    expect(ring.from(2)).toEqual({ text: "fghij", cursor: 10 })
    expect(ring.from(7)).toEqual({ text: "hij", cursor: 10 })
  })

  test("one chunk larger than the whole limit is trimmed to the limit", () => {
    const ring = new Ring(4)
    ring.push("0123456789")
    expect(ring.from(undefined)).toEqual({ text: "6789", cursor: 10 })
  })

  test("never hands out half of a surrogate pair", () => {
    const ring = new Ring(2)
    ring.push("a😀b")
    // "a", high, low, "b" is 4 units; trimming to 2 would start on the low half.
    const { text } = ring.from(undefined)
    expect(text).toBe("b")
    expect(ring.start).toBe(3)
    const ringTwo = new Ring(100)
    ringTwo.push("a😀b")
    expect(ringTwo.from(2).text).toBe("b")
  })

  test("ignores empty chunks", () => {
    const ring = new Ring(4)
    ring.push("")
    expect(ring.cursor).toBe(0)
  })
})
