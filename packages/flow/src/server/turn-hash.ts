/**
 * Turn hashes — what makes a resumed card's output provably the one this run
 * would have asked for (K7, 12.10.2026).
 *
 * A card's turn k is identified by a chained SHA-256 over its model and every
 * prompt it received up to and including turn k:
 *
 *   h0 = sha256("model:" + model)      hk = sha256(h(k-1) + "\n" + prompt_k)
 *
 * Equal chain ⇒ same model, same prompts in the same order ⇒ the recorded
 * answer is the answer to this exact history. A different task, a changed run
 * input, a changed upstream output or another model breaks the chain from that
 * turn on, and the card runs again.
 *
 * Measured 12.10.2026 (Abnahme R13 K7): a resume of a finished PASS run
 * reported "5 card(s) kept" and re-ran boss, worker-1..3 and critic for 350 s —
 * the orchestrator's seed was its final answer, which is not a control block,
 * so it was briefed afresh and handed out new work. No hash existed anywhere.
 */
/** `legacy`: derived from an old log's last prompt, not recorded per turn. */
/**
 * `started`/`finished`: when the turn ran (R18 K7 (a)). A takeover keeps them,
 * so a worker taken over from the interrupted run shows the time it worked,
 * not the moment it was taken over. Absent in records written before.
 */
export type RecordedTurn = { hash: string; output: string; legacy?: boolean; started?: number; finished?: number }

/**
 * SHA-256, synchronous and dependency-free. Synchronous on purpose: an await
 * between a card's answer and the next dispatch reorders concurrent cards
 * (measured: seven scheduling tests failed with WebCrypto's async digest), and
 * the engine also runs in the page, where `node:crypto` is not available.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])
export function sha256(text: string): string {
  const data = new TextEncoder().encode(text)
  const length = ((data.length + 9 + 63) >> 6) << 6
  const bytes = new Uint8Array(length)
  bytes.set(data)
  bytes[data.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(length - 8, Math.floor((data.length * 8) / 2 ** 32))
  view.setUint32(length - 4, (data.length * 8) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("")
}

export const turnRoot = (model: string | undefined) => sha256(`model:${model ?? ""}`)
export const turnNext = (previous: string, prompt: string) => sha256(`${previous}\n${prompt}`)

/**
 * The recorded turns of a finished card in a run log, for a resume.
 *
 * A log written since K7 carries them (`node.turns`). An older log only has the
 * card's LAST prompt and output; that pair is offered as turn 1, which matches
 * only where the card really had one turn — a later turn's prompt (a results
 * turn, a reassignment) is never what a fresh card is asked first, so a
 * multi-turn card from an old log runs again instead of being guessed at.
 */
export function recordedTurns(node: {
  status?: string
  model?: string
  prompt?: string
  output?: string
  turns?: RecordedTurn[]
}): RecordedTurn[] | undefined {
  // A card that was still working (or stopped, or failed) when the run ended
  // offers the turns it FINISHED — each entry is written only once its answer
  // is in. Abnahme R18 K7 (a): the boss killed on its results turn offered
  // nothing, was re-briefed, wrote its dispatch anew, and every worker it had
  // already been answered by ran again. The old-log fallback stays for done
  // cards: a last prompt without its answer proves nothing.
  if (Array.isArray(node.turns) && node.turns.length && node.turns.every((turn) => !turn.legacy)) return node.turns
  if (node.status !== "done") return undefined
  if (Array.isArray(node.turns) && node.turns.length) return node.turns
  if (typeof node.prompt !== "string" || typeof node.output !== "string") return undefined
  return [{ hash: turnNext(turnRoot(node.model), node.prompt), output: node.output, legacy: true }]
}
