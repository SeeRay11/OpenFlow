import { describe, expect, test } from "bun:test"
import { FENCE, parseDispatch } from "./dispatch"

const children = ["n1", "n2"]
const block = (body: string) => "```" + FENCE + "\n" + body + "\n```"

describe("parseDispatch", () => {
  test("reads an assignment for every card named", () => {
    const result = parseDispatch(
      "Here is what I want.\n\n" +
        block('{ "dispatch": [ { "card": "n1", "task": "read the file" }, { "card": "n2", "task": "check it" } ] }'),
      children,
    )
    expect(result).toEqual({
      kind: "dispatch",
      assignments: [
        { card: "n1", task: "read the file" },
        { card: "n2", task: "check it" },
      ],
    })
  })

  test("reads a final answer", () => {
    expect(parseDispatch(block('{ "final": "  the answer  " }'), children)).toEqual({
      kind: "final",
      answer: "the answer",
    })
  })

  test("prose around the block is reasoning, not instruction", () => {
    const result = parseDispatch(
      `I thought about dispatching n2 but it is not needed.\n\n${block('{ "final": "done" }')}\n\nThat is all.`,
      children,
    )
    expect(result).toEqual({ kind: "final", answer: "done" })
  })

  test("the last block wins — a model often quotes the protocol before using it", () => {
    const result = parseDispatch(
      `The format is:\n\n${block('{ "dispatch": [ { "card": "<id>", "task": "..." } ] }')}\n\n` +
        `So here is mine:\n\n${block('{ "final": "no dispatch needed" }')}`,
      children,
    )
    expect(result).toEqual({ kind: "final", answer: "no dispatch needed" })
  })

  test("no block at all is an error the model can act on", () => {
    const result = parseDispatch("I have decided to hand this to n1.", children)
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining(FENCE))
  })

  test("a block that is not JSON, or not an object, is refused", () => {
    expect(parseDispatch(block("{ not json }"), children).kind).toBe("error")
    expect(parseDispatch(block('["n1"]'), children).kind).toBe("error")
    expect(parseDispatch(block('"just a string"'), children).kind).toBe("error")
  })

  test("exactly one of dispatch and final", () => {
    expect(parseDispatch(block('{ "dispatch": [{"card":"n1","task":"x"}], "final": "y" }'), children).kind).toBe(
      "error",
    )
    expect(parseDispatch(block('{ "notes": "hello" }'), children).kind).toBe("error")
  })

  test("an empty final is refused — an empty answer would end the run with nothing", () => {
    expect(parseDispatch(block('{ "final": "   " }'), children).kind).toBe("error")
    expect(parseDispatch(block('{ "final": 42 }'), children).kind).toBe("error")
  })

  test("a card that does not exist is refused, and the real ones are listed", () => {
    const result = parseDispatch(block('{ "dispatch": [ { "card": "ghost", "task": "x" } ] }'), children)
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("n1, n2"))
  })

  test("a card outside this orchestrator's own children is refused", () => {
    // The roster it was given is the whole of what it may reach — dispatching
    // sideways would re-prompt a session somebody else is waiting on.
    expect(parseDispatch(block('{ "dispatch": [ { "card": "n9", "task": "x" } ] }'), children).kind).toBe("error")
  })

  test("an assignment with no task is refused", () => {
    expect(parseDispatch(block('{ "dispatch": [ { "card": "n1", "task": "  " } ] }'), children).kind).toBe("error")
    expect(parseDispatch(block('{ "dispatch": [ { "card": "n1" } ] }'), children).kind).toBe("error")
  })

  test("the same card twice in one batch is refused — one card is one session", () => {
    const result = parseDispatch(
      block('{ "dispatch": [ { "card": "n1", "task": "a" }, { "card": "n1", "task": "b" } ] }'),
      children,
    )
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("twice"))
  })

  test("an empty dispatch array is refused", () => {
    expect(parseDispatch(block('{ "dispatch": [] }'), children).kind).toBe("error")
  })

  test("a leaf card told to dispatch is pointed at final instead", () => {
    const result = parseDispatch(block('{ "dispatch": [ { "card": "n1", "task": "x" } ] }'), [])
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("final"))
  })
})
