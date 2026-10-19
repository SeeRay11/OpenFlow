/**
 * Omp RPC framing: JSONL on stdio, plus the protocol-v2 `rpc_chunk` envelope
 * (`omp://rpc.md`, "Transport and Framing"). Pure and I/O-free; `rpc.ts` feeds
 * it the child's stdout.
 *
 * Runs under both hosts (Bun and Node), so `Buffer` and `TextDecoder` only.
 */

import type { OmpFrame } from "./rpc-types"

/** What a line that is not one JSON object becomes. The reader never throws on garbage from the child. */
export type ParseError = { type: "parse_error"; line: string; reason?: string }

/** One logical frame, or why a chunk sequence was dropped. `undefined` from `push` means "chunk accepted, more to come". */
export type ChunkResult = { frame: OmpFrame } | { error: string }

/** A bad line is reported with at most this much of its text: frames can carry transcripts. */
const LINE_SAMPLE_CHARS = 2_048
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024

/** A frame is a JSON object with a string `type`; anything else on the wire is noise. */
function isFrame(value: unknown): value is OmpFrame {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

function sample(line: string) {
  return line.length > LINE_SAMPLE_CHARS ? `${line.slice(0, LINE_SAMPLE_CHARS)}…` : line
}

/**
 * Splits a byte or text stream into JSON objects, one per `\n`-terminated line.
 * A multibyte character split across chunks is held until it is whole; blank
 * lines are skipped; a line that is not a JSON object, or that exceeds
 * `maxLineBytes` (the rest of it is discarded up to the next newline), yields a
 * `parse_error` entry in its place so frame order is preserved.
 */
export class JsonlDecoder {
  private readonly decoder = new TextDecoder("utf-8")
  private readonly maxLineChars: number
  private pending = ""
  private skipping = false

  constructor(options: { maxLineBytes?: number } = {}) {
    // Characters, not bytes: a UTF-16 unit is at most 3 UTF-8 bytes, so this never under-reports a huge line.
    this.maxLineChars = Math.ceil((options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES) / 3)
  }

  push(chunk: string | Uint8Array): OmpFrame[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })
    return this.feed(text)
  }

  /** The stream ended: a final line without a trailing newline is still a frame. */
  flush(): OmpFrame[] {
    const tail = this.feed(this.decoder.decode())
    if (this.skipping) {
      this.skipping = false
      this.pending = ""
      return tail
    }
    const line = this.pending
    this.pending = ""
    if (line.trim().length > 0) tail.push(this.parse(line))
    return tail
  }

  private feed(text: string): OmpFrame[] {
    const out: OmpFrame[] = []
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf("\n", start)
      if (newline === -1) {
        this.append(text.slice(start), out)
        return out
      }
      const piece = text.slice(start, newline)
      start = newline + 1
      if (this.skipping) {
        this.skipping = false
        this.pending = ""
        continue
      }
      const line = this.pending + piece
      this.pending = ""
      if (line.length > this.maxLineChars) {
        out.push({ type: "parse_error", line: sample(line), reason: "line too long" })
        continue
      }
      if (line.trim().length === 0) continue
      out.push(this.parse(line))
    }
    return out
  }

  private append(piece: string, out: OmpFrame[]) {
    if (this.skipping) return
    this.pending += piece
    if (this.pending.length <= this.maxLineChars) return
    out.push({ type: "parse_error", line: sample(this.pending), reason: "line too long" })
    this.pending = ""
    this.skipping = true
  }

  private parse(line: string): OmpFrame {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isFrame(value)) return value
      return { type: "parse_error", line: sample(trimmed), reason: "not a frame object" }
    } catch {
      return { type: "parse_error", line: sample(trimmed), reason: "invalid JSON" }
    }
  }
}

type Sequence = { chunkId: string; count: number; byteLength: number; next: number; parts: Buffer[]; size: number }

/**
 * Reassembles protocol-v2 `rpc_chunk` frames. Each `chunkId` is one JSON object
 * split into base64 slices of its UTF-8 bytes, sent as an uninterrupted run.
 * A gap, a duplicate, an interleaved sequence, a size that disagrees with
 * `byteLength`, or a total over `maxReassembledFrameBytes` drops the whole
 * sequence and reports it once; the remaining chunks of a dropped sequence are
 * swallowed silently so one fault is one report.
 */
export class ChunkAssembler {
  private readonly max: number
  private current: Sequence | undefined
  private dropped: string | undefined

  constructor(options: { maxReassembledFrameBytes?: number } = {}) {
    this.max = options.maxReassembledFrameBytes ?? DEFAULT_MAX_REASSEMBLED_BYTES
  }

  push(frame: OmpFrame): ChunkResult | undefined {
    const chunkId = frame.chunkId
    const index = frame.index
    const count = frame.count
    const byteLength = frame.byteLength
    const data = frame.data
    if (
      typeof chunkId !== "string" ||
      typeof data !== "string" ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 1 ||
      byteLength < 0 ||
      index >= count
    ) {
      return this.drop(typeof chunkId === "string" ? chunkId : undefined, "malformed rpc_chunk")
    }
    if (chunkId === this.dropped) {
      if (index === count - 1) this.dropped = undefined
      return undefined
    }
    return this.accept(chunkId, index, count, byteLength, data)
  }

  /** Forget a half-built sequence (the stream ended mid-run). */
  reset() {
    this.current = undefined
    this.dropped = undefined
  }

  private accept(chunkId: string, index: number, count: number, byteLength: number, data: string): ChunkResult | undefined {
    let sequence = this.current
    if (sequence && sequence.chunkId !== chunkId) {
      const interrupted = sequence.chunkId
      this.current = undefined
      // The interrupting sequence may itself be fine: report the loss, then judge it on its own merits.
      const lost = { error: `rpc_chunk sequence ${interrupted} interrupted by ${chunkId}` }
      const next = this.accept(chunkId, index, count, byteLength, data)
      return next && "error" in next ? { error: `${lost.error}; ${next.error}` } : lost
    }
    if (!sequence) {
      if (index !== 0) return this.drop(chunkId, `rpc_chunk gap: ${chunkId} starts at index ${index}`, count)
      if (byteLength > this.max) return this.drop(chunkId, `rpc_chunk oversize: ${byteLength} bytes exceeds ${this.max}`, count)
      sequence = { chunkId, count, byteLength, next: 0, parts: [], size: 0 }
      this.current = sequence
    }
    if (count !== sequence.count || byteLength !== sequence.byteLength) {
      return this.drop(chunkId, `rpc_chunk ${chunkId} changed its count or byteLength mid-sequence`, count)
    }
    if (index < sequence.next) return this.drop(chunkId, `rpc_chunk duplicate: ${chunkId} index ${index}`, count)
    if (index > sequence.next) {
      return this.drop(chunkId, `rpc_chunk gap: ${chunkId} expected index ${sequence.next}, got ${index}`, count)
    }
    const bytes = Buffer.from(data, "base64")
    sequence.size += bytes.length
    if (sequence.size > sequence.byteLength) {
      return this.drop(chunkId, `rpc_chunk oversize: ${chunkId} exceeds its declared ${sequence.byteLength} bytes`, count)
    }
    sequence.parts.push(bytes)
    sequence.next += 1
    if (sequence.next < sequence.count) return undefined
    this.current = undefined
    if (sequence.size !== sequence.byteLength) {
      return { error: `rpc_chunk ${chunkId} reassembled ${sequence.size} bytes, declared ${sequence.byteLength}` }
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(sequence.parts)))
      if (isFrame(value)) return { frame: value }
      return { error: `rpc_chunk ${chunkId} did not reassemble into a frame object` }
    } catch {
      return { error: `rpc_chunk ${chunkId} did not reassemble into valid UTF-8 JSON` }
    }
  }

  private drop(chunkId: string | undefined, error: string, count?: number): ChunkResult {
    this.current = undefined
    // A single-chunk sequence has nothing left to swallow.
    this.dropped = chunkId !== undefined && count !== undefined && count > 1 ? chunkId : undefined
    return { error }
  }
}
