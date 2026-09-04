import { describe, expect, test } from "bun:test"
import { verdictIn } from "./verdict"

describe("verdictIn", () => {
  test("reads a marker on its own line", () => {
    expect(verdictIn("It builds and the tests pass.\n\nVERDICT: PASS")).toEqual({ kind: "pass" })
  })

  test("keeps everything above a failure as the reason", () => {
    const verdict = verdictIn("The retry loop is missing.\n\nVERDICT: FAIL")
    expect(verdict).toMatchObject({ kind: "fail" })
    expect(verdict).toMatchObject({ reason: "The retry loop is missing." })
  })

  test("the last marker wins, because a critic quotes both before choosing", () => {
    // Measured shape, not hypothetical: the briefing shows the two lines, and a
    // model that repeats its instructions before following them is ordinary.
    const text = ["I must end with VERDICT: PASS or VERDICT: FAIL.", "", "The bar is not met.", "", "VERDICT: FAIL"].join(
      "\n",
    )
    expect(verdictIn(text)).toMatchObject({ kind: "fail" })
  })

  test("tolerates the decoration models put around it", () => {
    expect(verdictIn("- **Verdict: pass**")).toEqual({ kind: "pass" })
    expect(verdictIn("> verdict:fail")).toMatchObject({ kind: "fail" })
  })

  test("a message with no marker is unreadable, not a pass", () => {
    // The dangerous default. A critic that wrote a glowing review and forgot the
    // line has not passed the work; it has failed to answer the question.
    expect(verdictIn("Looks great to me, ship it.")).toEqual({ kind: "unreadable" })
  })

  test("a marker inside a word is not a marker", () => {
    expect(verdictIn("the verdicts: passing grades all round")).toEqual({ kind: "unreadable" })
  })
})
