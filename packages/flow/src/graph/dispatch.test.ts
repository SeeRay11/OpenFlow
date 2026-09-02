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

  test("declared files ride along, trimmed; an assignment that declares none carries no key", () => {
    const result = parseDispatch(
      block('{ "dispatch": [ { "card": "n1", "task": "a", "files": [" src/a.ts "] }, { "card": "n2", "task": "b" } ] }'),
      children,
    )
    expect(result).toEqual({
      kind: "dispatch",
      assignments: [
        { card: "n1", task: "a", files: ["src/a.ts"] },
        { card: "n2", task: "b" },
      ],
    })
  })

  test("two cards declaring one file is refused before either runs", () => {
    const result = parseDispatch(
      block(
        '{ "dispatch": [ { "card": "n1", "task": "a", "files": ["src/game.ts"] }, { "card": "n2", "task": "b", "files": ["docs.md", "src/game.ts"] } ] }',
      ),
      children,
    )
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("`src/game.ts` is declared by both `n1` and `n2`"))
  })

  test("the same file spelt two ways is still one file", () => {
    const result = parseDispatch(
      block(
        '{ "dispatch": [ { "card": "n1", "task": "a", "files": ["./src/Game.ts"] }, { "card": "n2", "task": "b", "files": ["src\\\\game.ts"] } ] }',
      ),
      children,
    )
    expect(result.kind).toBe("error")
    expect(result).toHaveProperty("reason", expect.stringContaining("declared by both"))
  })

  test("one card declaring a file twice is not a collision with itself", () => {
    const result = parseDispatch(
      block('{ "dispatch": [ { "card": "n1", "task": "a", "files": ["x.ts", "./x.ts"] } ] }'),
      children,
    )
    expect(result.kind).toBe("dispatch")
  })

  test("files that are not an array of paths are refused with the card named", () => {
    for (const files of ['"src/a.ts"', "[1]", '[""]', "{}"]) {
      const result = parseDispatch(block(`{ "dispatch": [ { "card": "n1", "task": "a", "files": ${files} } ] }`), children)
      expect(result.kind).toBe("error")
      expect(result).toHaveProperty("reason", expect.stringContaining("`files` on the assignment for `n1`"))
    }
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

describe("a block with something stuck to the end", () => {
  const block = (body: string) => "```" + FENCE + "\n" + body + "\n```"

  test("a stray character after the closing brace does not cost the run", () => {
    // Measured: a correct dispatch — right card, a task naming the file, the
    // line and the fix — arrived with one `"` after the final `}`.
    const text = block('{ "dispatch": [ { "card": "look", "task": "fix the sky gradient" } ] }"')
    expect(parseDispatch(text, ["look"])).toEqual({
      kind: "dispatch",
      assignments: [{ card: "look", task: "fix the sky gradient" }],
    })
  })

  test("prose after the object is ignored too", () => {
    const text = block('{ "final": "shipped" }\n\nLet me know if you want anything else.')
    expect(parseDispatch(text, ["look"])).toEqual({ kind: "final", answer: "shipped" })
  })

  test("a brace inside a task string does not end the object early", () => {
    const text = block('{ "dispatch": [ { "card": "look", "task": "replace `{ a: 1 }` with `{ a: 2 }`" } ] }')
    expect(parseDispatch(text, ["look"])).toEqual({
      kind: "dispatch",
      assignments: [{ card: "look", task: "replace `{ a: 1 }` with `{ a: 2 }`" }],
    })
  })

  test("an escaped quote inside a string does not end it", () => {
    const text = block('{ "final": "it prints \\"[object Object]\\" instead of a colour" }')
    expect(parseDispatch(text, ["look"])).toEqual({
      kind: "final",
      answer: 'it prints "[object Object]" instead of a colour',
    })
  })

  test("genuinely broken JSON is still refused", () => {
    expect(parseDispatch(block('{ "dispatch": [ { "card": "look" '), ["look"]).kind).toBe("error")
  })
})

describe("a block the model was cut off mid-way through", () => {
  const block = (body: string) => "```" + FENCE + "\n" + body + "\n```"

  test("an object left open at the end is closed rather than thrown away", () => {
    // Measured: an orchestrator wrote a 5.3KB dispatch with a whole verification
    // script inlined in the task and ended `… "priority": "high" } ]` — every
    // brace but the outermost closed. It had reasoned its way to the right card
    // and the right fix; a missing character cost the run.
    const text = block('{ "dispatch": [ { "card": "world", "task": "fix the pipe recycler", "priority": "high" } ]')
    expect(parseDispatch(text, ["world"])).toEqual({
      kind: "dispatch",
      assignments: [{ card: "world", task: "fix the pipe recycler" }],
    })
  })

  test("a string left open is closed too, truncating the value rather than losing the dispatch", () => {
    const text = block('{ "dispatch": [ { "card": "world", "task": "fix the pipe recy')
    expect(parseDispatch(text, ["world"])).toEqual({
      kind: "dispatch",
      assignments: [{ card: "world", task: "fix the pipe recy" }],
    })
  })

  test("a final cut off mid-sentence still answers", () => {
    expect(parseDispatch(block('{ "final": "it clears the bar because'), ["world"])).toEqual({
      kind: "final",
      answer: "it clears the bar because",
    })
  })

  test("closing what was left open cannot invent a card", () => {
    // The repair only ever appends closers; it can never fill in a missing key.
    expect(parseDispatch(block('{ "dispatch": [ { "task": "no card named'), ["world"]).kind).toBe("error")
  })
})
