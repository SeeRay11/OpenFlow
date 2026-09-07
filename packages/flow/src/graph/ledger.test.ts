import { describe, expect, test } from "bun:test"
import { bestRound, ledgerNote, progressed, stalledRounds, verdictSummary, type LedgerRound } from "./ledger"

const round = (patch: Partial<LedgerRound> = {}): LedgerRound => ({
  card: "root",
  round: 1,
  at: 0,
  cards: [{ card: "coder", ok: true }],
  added: 0,
  removed: 0,
  files: 0,
  ...patch,
})

describe("progressed", () => {
  test("the first round is always progress — there is nothing to repeat yet", () => {
    expect(progressed(undefined, round())).toBe(true)
  })

  test("lines in the tree are progress, in either direction", () => {
    expect(progressed(round(), round({ round: 2, added: 12, removed: 0 }))).toBe(true)
    // A round that only deleted still moved the tree, and a run undoing itself
    // is not a run doing nothing.
    expect(progressed(round(), round({ round: 2, added: 0, removed: 30 }))).toBe(true)
  })

  test("a different set of cards is progress", () => {
    expect(progressed(round(), round({ round: 2, cards: [{ card: "tester", ok: true }] }))).toBe(true)
  })

  test("a card that recovered, or one that broke, is progress", () => {
    const failing = round({ cards: [{ card: "coder", ok: false }] })
    expect(progressed(failing, round({ round: 2 }))).toBe(true)
    expect(progressed(round(), round({ round: 2, cards: [{ card: "coder", ok: false }] }))).toBe(true)
  })

  test("a verdict that changed is progress, including a first one", () => {
    const judged = round({ cards: [{ card: "reviewer", ok: true, verdict: "FAIL — the tests do not pass" }] })
    expect(progressed(round({ cards: [{ card: "reviewer", ok: true }] }), judged)).toBe(true)
    expect(progressed(judged, round({ round: 2, cards: [{ card: "reviewer", ok: true, verdict: "PASS" }] }))).toBe(true)
  })

  test("the same cards, the same outcomes and no lines is not progress", () => {
    expect(progressed(round(), round({ round: 2 }))).toBe(false)
  })

  test("rewording the task does not count as progress", () => {
    // The measured failure: a model rewrites "fix the ground plane" as "correct
    // the ground plane position" and the old exact-string stall check read it
    // as fresh work. Nothing here consults the task text at all.
    const first = round({ cards: [{ card: "coder", ok: true }] })
    const second = round({ round: 2, cards: [{ card: "coder", ok: true }] })
    expect(progressed(first, second)).toBe(false)
  })

  test("a round nobody could measure is judged on its other evidence", () => {
    // Off git there are no line counts, so a repeat has to be visible from the
    // cards alone rather than defaulting to "something must have happened".
    const off = { added: undefined, removed: undefined, files: undefined }
    expect(progressed(round(off), round({ ...off, round: 2 }))).toBe(false)
    expect(progressed(round(off), round({ ...off, round: 2, cards: [{ card: "other", ok: true }] }))).toBe(true)
  })
})

describe("stalledRounds", () => {
  test("counts only the run of unchanged rounds at the end", () => {
    const rounds = [round({ round: 1, added: 10 }), round({ round: 2 }), round({ round: 3 }), round({ round: 4 })]
    expect(stalledRounds(rounds, "root")).toBe(3)
  })

  test("a round that changed something resets it", () => {
    const rounds = [round({ round: 1 }), round({ round: 2 }), round({ round: 3, added: 5 })]
    expect(stalledRounds(rounds, "root")).toBe(0)
  })

  test("each orchestrator is counted on its own rounds", () => {
    // A subtree orchestrator dispatching in circles must not be charged to its
    // parent, and vice versa — they are separate loops with separate budgets.
    const rounds = [
      round({ card: "root", round: 1 }),
      round({ card: "sub", round: 1 }),
      round({ card: "sub", round: 2 }),
      round({ card: "root", round: 2, added: 9 }),
    ]
    expect(stalledRounds(rounds, "root")).toBe(0)
    expect(stalledRounds(rounds, "sub")).toBe(1)
  })
})

describe("ledgerNote", () => {
  test("a first round has no history to carry", () => {
    expect(ledgerNote([], "root")).toBeUndefined()
  })

  test("one line per round, with what changed and who judged", () => {
    const note = ledgerNote(
      [
        round({
          round: 1,
          cards: [
            { card: "coder", ok: true },
            { card: "reviewer", ok: true, verdict: "FAIL — the tests do not pass" },
          ],
          added: 42,
          removed: 3,
          files: 2,
        }),
      ],
      "root",
    )!
    expect(note).toContain("round 1: coder, reviewer")
    expect(note).toContain("+42 −3 in 2 files")
    expect(note).toContain("reviewer: FAIL — the tests do not pass")
  })

  test("a card that failed is named", () => {
    const note = ledgerNote([round({ cards: [{ card: "coder", ok: false }] })], "root")!
    expect(note).toContain("coder failed")
  })

  test("a round that wrote nothing says so, and an unmeasured one says nothing", () => {
    expect(ledgerNote([round()], "root")!).toContain("changed no lines")
    expect(ledgerNote([round({ added: undefined, removed: undefined })], "root")!).not.toContain("changed no lines")
  })

  test("older rounds are counted rather than printed", () => {
    const rounds = Array.from({ length: 9 }, (_, index) => round({ round: index + 1, added: index }))
    const note = ledgerNote(rounds, "root")!
    expect(note).toContain("(3 earlier rounds not shown)")
    expect(note).toContain("round 9")
    expect(note).not.toContain("round 3:")
  })

  test("a run of unchanged rounds is stated, once it is worth stating", () => {
    const rounds = [round({ round: 1 }), round({ round: 2 }), round({ round: 3 })]
    expect(ledgerNote(rounds, "root")!).toContain("last 3 rounds changed nothing measurable")
    expect(ledgerNote([round({ round: 1 }), round({ round: 2 })], "root")!).not.toContain("changed nothing measurable")
  })

  test("another orchestrator's rounds are not this one's history", () => {
    expect(ledgerNote([round({ card: "sub" })], "root")).toBeUndefined()
  })
})

describe("verdictSummary", () => {
  test("a marker is quoted exactly", () => {
    expect(verdictSummary("Everything checks out.\n\nVERDICT: PASS")).toBe("PASS")
    expect(verdictSummary("The build fails.\nVERDICT: FAIL")).toBe("FAIL — The build fails.")
  })

  test("a message with no marker is unreadable, not guessed at", () => {
    // Measured 2026-09-07 on a live gauntlet: the critic cleared the bar and
    // opened `**CLEAR**`. Reading its first line as a verdict recorded the
    // string `CLEAR**` — not a verdict, not comparable against the next
    // round's, and worth nothing to `bestRound`.
    const summary = verdictSummary("**CLEAR**\n\nAll 7 bar items pass.")
    expect(summary).toContain("no verdict line")
    expect(summary).toContain("CLEAR")
    expect(summary).not.toContain("CLEAR**")
  })

  test("emphasis comes off both ends of the quoted line", () => {
    expect(verdictSummary("Nope.\nVERDICT: FAIL")).toBe("FAIL — Nope.")
    expect(verdictSummary("**the ground plane is wrong**\nVERDICT: FAIL")).toBe("FAIL — the ground plane is wrong")
  })

  test("a heading is skipped rather than quoted as the verdict", () => {
    expect(verdictSummary("## Review\n\nThe ground plane is still wrong.\nVERDICT: FAIL")).toBe(
      "FAIL — The ground plane is still wrong.",
    )
  })

  test("a long line is clipped rather than filling the prompt", () => {
    expect(verdictSummary("x".repeat(400)).length).toBeLessThanOrEqual(120)
  })
})

describe("bestRound", () => {
  test("the most recent round a critic passed", () => {
    const rounds = [
      round({ round: 1, cards: [{ card: "reviewer", ok: true, verdict: "PASS" }], ref: "r1" }),
      round({ round: 2, cards: [{ card: "builder", ok: true }], ref: "r2" }),
      round({ round: 3, cards: [{ card: "reviewer", ok: true, verdict: "PASS" }], ref: "r3" }),
      round({ round: 4, cards: [{ card: "builder", ok: true }], ref: "r4" }),
    ]
    expect(bestRound(rounds)?.ref).toBe("r3")
  })

  test("a failed verdict is not a best round, and neither is an unjudged one", () => {
    expect(bestRound([round({ cards: [{ card: "reviewer", ok: true, verdict: "FAIL — broken" }] })])).toBeUndefined()
    expect(bestRound([round({ cards: [{ card: "builder", ok: true }] })])).toBeUndefined()
  })

  test("nothing to go back to on a run with no rounds", () => {
    expect(bestRound([])).toBeUndefined()
  })
})
