import { describe, expect, test } from "bun:test"
import { ChunkAssembler, JsonlDecoder } from "./frame"
import type { OmpFrame } from "./rpc-types"

function chunks(frame: object, size: number, chunkId = "rpc-1"): OmpFrame[] {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8")
  const count = Math.ceil(bytes.length / size)
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }))
}

describe("JsonlDecoder", () => {
  test("splits lines and keeps a partial line until it completes", () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"type":"a"}\n{"type":')).toEqual([{ type: "a" }])
    expect(decoder.push('"b"}\n')).toEqual([{ type: "b" }])
  })

  test("skips blank lines and tolerates CRLF", () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('\n  \n{"type":"a"}\r\n\n')).toEqual([{ type: "a" }])
  })

  test("a multibyte character split across byte chunks survives", () => {
    const decoder = new JsonlDecoder()
    const bytes = Buffer.from('{"type":"a","text":"é€😀"}\n', "utf8")
    const frames: OmpFrame[] = []
    for (let at = 0; at < bytes.length; at += 1) frames.push(...decoder.push(bytes.subarray(at, at + 1)))
    expect(frames).toEqual([{ type: "a", text: "é€😀" }])
  })

  test("a malformed line becomes a parse_error in place and the stream goes on", () => {
    const decoder = new JsonlDecoder()
    const frames = decoder.push('{"type":"a"}\nnot json\n[1,2]\n{"no":"type"}\n{"type":"b"}\n')
    expect(frames.map((frame) => frame.type)).toEqual(["a", "parse_error", "parse_error", "parse_error", "b"])
    expect(frames[1]).toMatchObject({ line: "not json", reason: "invalid JSON" })
    expect(frames[2]).toMatchObject({ line: "[1,2]", reason: "not a frame object" })
  })

  test("flush emits a final line that has no newline", () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"type":"a"}')).toEqual([])
    expect(decoder.flush()).toEqual([{ type: "a" }])
    expect(decoder.flush()).toEqual([])
  })

  test("an over-long line is reported once, discarded to its newline, and does not poison the next", () => {
    const decoder = new JsonlDecoder({ maxLineBytes: 90 })
    const frames = [...decoder.push(`{"type":"a","pad":"${"x".repeat(100)}`), ...decoder.push(`${"y".repeat(100)}"}\n{"type":"b"}\n`)]
    expect(frames.map((frame) => frame.type)).toEqual(["parse_error", "b"])
    expect(frames[0]).toMatchObject({ reason: "line too long" })
  })

  test("a complete over-long line is reported as one parse_error", () => {
    const decoder = new JsonlDecoder({ maxLineBytes: 90 })
    const frames = decoder.push(`{"type":"a","pad":"${"x".repeat(100)}"}\n{"type":"b"}\n`)
    expect(frames.map((frame) => frame.type)).toEqual(["parse_error", "b"])
  })
})

describe("ChunkAssembler", () => {
  const original = { type: "response", id: "c1", data: { text: "héllo €😀 ".repeat(50) } }

  test("reassembles one object from ordered chunks, splitting inside multibyte characters", () => {
    const assembler = new ChunkAssembler()
    const parts = chunks(original, 7)
    expect(parts.length).toBeGreaterThan(3)
    const results = parts.map((part) => assembler.push(part))
    expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true)
    expect(results.at(-1)).toEqual({ frame: original })
  })

  test("a single-chunk sequence completes at once", () => {
    const assembler = new ChunkAssembler()
    expect(assembler.push(chunks({ type: "x" }, 1024)[0])).toEqual({ frame: { type: "x" } })
  })

  test("a gap drops the sequence, reports once and swallows the rest", () => {
    const assembler = new ChunkAssembler()
    const parts = chunks(original, 40)
    expect(assembler.push(parts[0])).toBeUndefined()
    expect(assembler.push(parts[2])).toEqual({ error: expect.stringContaining("gap") })
    for (const part of parts.slice(3)) expect(assembler.push(part)).toBeUndefined()
    // The assembler is clean again for the next sequence.
    const next = chunks({ type: "next" }, 4, "rpc-2")
    const last = next.map((part) => assembler.push(part)).at(-1)
    expect(last).toEqual({ frame: { type: "next" } })
  })

  test("a sequence that does not start at index 0 is a gap", () => {
    const assembler = new ChunkAssembler()
    const parts = chunks(original, 40)
    expect(assembler.push(parts[1])).toEqual({ error: expect.stringContaining("gap") })
  })

  test("a duplicated chunk drops the sequence", () => {
    const assembler = new ChunkAssembler()
    const parts = chunks(original, 40)
    assembler.push(parts[0])
    assembler.push(parts[1])
    expect(assembler.push(parts[1])).toEqual({ error: expect.stringContaining("duplicate") })
    for (const part of parts.slice(2)) expect(assembler.push(part)).toBeUndefined()
  })

  test("a declared size over the limit is refused before any data is buffered", () => {
    const assembler = new ChunkAssembler({ maxReassembledFrameBytes: 100 })
    const parts = chunks(original, 40)
    expect(assembler.push(parts[0])).toEqual({ error: expect.stringContaining("oversize") })
    for (const part of parts.slice(1)) expect(assembler.push(part)).toBeUndefined()
  })

  test("more bytes than declared is oversize", () => {
    const assembler = new ChunkAssembler()
    const parts = chunks(original, 40).map((part) => ({ ...part, byteLength: 50 }))
    assembler.push(parts[0])
    expect(assembler.push(parts[1])).toEqual({ error: expect.stringContaining("oversize") })
  })

  test("an interleaved sequence reports the interrupted one and still starts the new one", () => {
    const assembler = new ChunkAssembler()
    const first = chunks(original, 40, "rpc-1")
    const second = chunks({ type: "other" }, 4, "rpc-2")
    assembler.push(first[0])
    const interrupted = assembler.push(second[0])
    expect(interrupted).toEqual({ error: expect.stringContaining("interrupted") })
    const results = second.slice(1).map((part) => assembler.push(part))
    expect(results.at(-1)).toEqual({ frame: { type: "other" } })
  })

  test("a malformed chunk is an error, not a throw", () => {
    const assembler = new ChunkAssembler()
    expect(assembler.push({ type: "rpc_chunk", chunkId: "x" })).toEqual({ error: expect.stringContaining("malformed") })
    expect(assembler.push({ type: "rpc_chunk", chunkId: "x", index: 5, count: 2, byteLength: 1, data: "" })).toEqual({
      error: expect.stringContaining("malformed"),
    })
  })

  test("bytes that are not a JSON frame object are reported", () => {
    const assembler = new ChunkAssembler()
    const bytes = Buffer.from("[1,2,3]")
    const result = assembler.push({ type: "rpc_chunk", chunkId: "x", index: 0, count: 1, byteLength: bytes.length, data: bytes.toString("base64") })
    expect(result).toEqual({ error: expect.stringContaining("frame object") })
  })

  test("a byteLength that disagrees with the decoded bytes is reported", () => {
    const assembler = new ChunkAssembler()
    const bytes = Buffer.from('{"type":"x"}')
    const result = assembler.push({ type: "rpc_chunk", chunkId: "x", index: 0, count: 1, byteLength: bytes.length - 1, data: bytes.toString("base64") })
    expect(result).toEqual({ error: expect.stringContaining("oversize") })
    const short = assembler.push({ type: "rpc_chunk", chunkId: "y", index: 0, count: 1, byteLength: bytes.length + 5, data: bytes.toString("base64") })
    expect(short).toEqual({ error: expect.stringContaining("declared") })
  })
})
