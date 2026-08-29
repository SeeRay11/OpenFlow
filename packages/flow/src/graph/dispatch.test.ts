import { describe, expect, test } from "bun:test"
import { DISPATCH_TOOL, FENCE, FINISH_TOOL, fromToolCall, parseDispatch } from "./dispatch"

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

  test("a leaf card told to dispatch is pointed at answering instead", () => {
    // Channel-agnostic wording: the briefing is where the card learns whether
    // it answers with the tool or with a block.
    const result = parseDispatch(block('{ "dispatch": [ { "card": "n1", "task": "x" } ] }'), [])
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("Answer instead"))
  })
})

describe("parseDispatch without a fence", () => {
  // Measured against a real provider: it produced a flawless dispatch object
  // with correct card ids and good task text, and no fence around it. Refusing
  // that cost a paid retry and then the whole run.
  test("a message that is nothing but the JSON is accepted", () => {
    const bare = '{ "dispatch": [ { "card": "n1", "task": "read the file" } ] }'
    expect(parseDispatch(bare, children)).toEqual({
      kind: "dispatch",
      assignments: [{ card: "n1", task: "read the file" }],
    })
    expect(parseDispatch('  { "final": "done" }  ', children)).toEqual({ kind: "final", answer: "done" })
  })

  test("JSON buried in prose is still refused — that is an example, not an instruction", () => {
    const chatty = 'I could send { "dispatch": [ { "card": "n1", "task": "x" } ] } but I will not.'
    expect(parseDispatch(chatty, children).kind).toBe("error")
  })

  test("a fenced block still wins over anything around it", () => {
    const both = '{ "final": "bare" }\n\n' + block('{ "final": "fenced" }')
    expect(parseDispatch(both, children)).toEqual({ kind: "final", answer: "fenced" })
  })

  test("a bare object that is not the protocol is refused on its own terms", () => {
    expect(parseDispatch('{ "notes": "hello" }', children).kind).toBe("error")
  })
})

describe("fromToolCall", () => {
  test("reads a dispatch call", () => {
    expect(
      fromToolCall(DISPATCH_TOOL, { assignments: [{ card: "n1", task: " read it " }] }, children),
    ).toEqual({ kind: "dispatch", assignments: [{ card: "n1", task: "read it" }] })
  })

  test("reads a finish call", () => {
    expect(fromToolCall(FINISH_TOOL, { answer: "  done  " }, children)).toEqual({ kind: "final", answer: "done" })
  })

  test("a tool that is not ours is not a decision", () => {
    // The caller keeps looking back through the turn, so "not mine" has to be
    // distinguishable from "mine and wrong".
    expect(fromToolCall("todowrite", { todos: [] }, children)).toBeUndefined()
    expect(fromToolCall("bash", { command: "ls" }, children)).toBeUndefined()
  })

  test("both channels judge a batch the same way", () => {
    const bad = [{ card: "ghost", task: "x" }]
    const viaTool = fromToolCall(DISPATCH_TOOL, { assignments: bad }, children)
    const viaText = parseDispatch(block(JSON.stringify({ dispatch: bad })), children)
    expect(viaTool).toEqual(viaText)

    const twice = [
      { card: "n1", task: "a" },
      { card: "n1", task: "b" },
    ]
    expect(fromToolCall(DISPATCH_TOOL, { assignments: twice }, children)).toEqual(
      parseDispatch(block(JSON.stringify({ dispatch: twice })), children),
    )
  })

  test("a malformed call is an error, not a shrug", () => {
    expect(fromToolCall(FINISH_TOOL, { answer: "  " }, children)!.kind).toBe("error")
    expect(fromToolCall(DISPATCH_TOOL, {}, children)!.kind).toBe("error")
    expect(fromToolCall(DISPATCH_TOOL, undefined, children)!.kind).toBe("error")
  })
})
