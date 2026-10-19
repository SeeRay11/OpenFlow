/**
 * The scrollback a session keeps for a client that reconnects.
 *
 * Same scheme as upstream's PTY service: a bounded buffer plus a monotonic
 * cursor that counts every UTF-16 unit ever written, so a client holding cursor
 * N asks for "everything after N" and gets either exactly that or, when N has
 * already been trimmed away, the oldest tail still held. Chunks are kept whole
 * rather than as one string so a write never copies the whole buffer.
 */

export class Ring {
  readonly limit: number
  #chunks: string[] = []
  #size = 0
  #start = 0

  constructor(limit: number) {
    this.limit = limit
  }

  /** Total units ever written. Never decreases. */
  get cursor() {
    return this.#start + this.#size
  }

  /** Cursor of the oldest retained unit. */
  get start() {
    return this.#start
  }

  push(chunk: string) {
    if (!chunk) return
    this.#chunks.push(chunk)
    this.#size += chunk.length
    let excess = this.#size - this.limit
    while (excess > 0) {
      const first = this.#chunks[0]!
      if (first.length <= excess) {
        this.#chunks.shift()
        this.#size -= first.length
        this.#start += first.length
        excess -= first.length
        continue
      }
      this.#chunks[0] = first.slice(excess)
      this.#size -= excess
      this.#start += excess
      excess = 0
    }
    // Trimming must not leave half of a surrogate pair at the front: the client
    // would be handed an unpaired low surrogate.
    const head = this.#chunks[0]
    if (head && head.charCodeAt(0) >= 0xdc00 && head.charCodeAt(0) <= 0xdfff) {
      this.#chunks[0] = head.slice(1)
      this.#size -= 1
      this.#start += 1
    }
  }

  /**
   * What a client at `cursor` has missed. `-1` means "tail only" (nothing
   * replayed); `undefined` means everything still retained. `cursor` in the
   * result is where live output continues from.
   */
  from(cursor: number | undefined): { text: string; cursor: number } {
    const end = this.cursor
    if (cursor === -1) return { text: "", cursor: end }
    const wanted = typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
    if (wanted >= end) return { text: "", cursor: end }
    const joined = this.#chunks.length === 1 ? this.#chunks[0]! : this.#chunks.join("")
    let text = joined.slice(Math.max(0, wanted - this.#start))
    if (text && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) text = text.slice(1)
    return { text, cursor: end }
  }
}
