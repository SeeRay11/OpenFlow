import { describe, expect, test } from "bun:test"
import { collisionNote, collisionsIn, shellWrites, TREE, writesOf, type Write } from "./collisions"
import type { NodeEvent } from "./types"

/** One tool call as the activity stream records it: title, and input as sent. */
function call(tool: string, input: unknown, options: { at?: number; status?: NodeEvent["status"] } = {}): NodeEvent {
  return {
    id: `tool:${tool}:${options.at ?? 1}`,
    at: options.at ?? 1,
    kind: "tool",
    depth: 0,
    title: input && typeof input === "object" ? `${tool} path=${(input as any).path}` : tool,
    status: options.status ?? "done",
    input: JSON.stringify(input),
  }
}

const sure = (...paths: string[]): Write[] => paths.map((path) => ({ path }))

describe("writesOf", () => {
  test("reads the path off the writing tools and ignores the reading ones", () => {
    expect(
      writesOf([
        call("read", { path: "src/read-only.ts" }),
        call("write", { path: "src/game.ts", content: "x" }),
        call("grep", { pattern: "foo" }),
        call("edit", { path: "src/bird.ts" }),
      ]),
    ).toEqual(sure("src/game.ts", "src/bird.ts"))
  })

  test("a rejected tool call never touched the disk", () => {
    // A card with `edit: deny` is still handed the tool and still calls it —
    // counting the refusal would report a collision between a card that wrote
    // and a card that was stopped from writing.
    expect(writesOf([call("write", { path: "src/game.ts" }, { status: "error" })])).toEqual([])
  })

  test("only calls from this batch count", () => {
    const events = [call("write", { path: "old.ts" }, { at: 10 }), call("write", { path: "new.ts" }, { at: 30 })]
    expect(writesOf(events, 20)).toEqual(sure("new.ts"))
  })

  test("one card writing one file twice is one path, not a collision with itself", () => {
    expect(
      writesOf([call("write", { path: "src/game.ts" }, { at: 1 }), call("edit", { path: "src/game.ts" }, { at: 2 })]),
    ).toEqual(sure("src/game.ts"))
  })

  test("a shell redirect is a write, marked as the guess it is", () => {
    expect(writesOf([call("bash", { command: "echo hi > src/game.ts" })])).toEqual([
      { path: "src/game.ts", probable: true },
    ])
  })

  test("a write tool outranks a shell guess at the same file", () => {
    expect(
      writesOf([
        call("bash", { command: "echo hi > src/game.ts" }, { at: 1 }),
        call("write", { path: "src/game.ts" }, { at: 2 }),
      ]),
    ).toEqual(sure("src/game.ts"))
    expect(
      writesOf([
        call("write", { path: "src/game.ts" }, { at: 1 }),
        call("bash", { command: "echo hi > src/game.ts" }, { at: 2 }),
      ]),
    ).toEqual(sure("src/game.ts"))
  })

  test("a shell command that only reads is not a writer", () => {
    expect(writesOf([call("bash", { command: "cat src/game.ts | grep bird && bun test" })])).toEqual([])
  })

  test("a tool call with no parseable input is skipped rather than throwing", () => {
    const broken: NodeEvent = { id: "t", at: 1, kind: "tool", depth: 0, title: "write", status: "done", input: "{oops" }
    expect(writesOf([broken, { ...broken, id: "u", input: undefined }])).toEqual([])
  })
})

describe("shellWrites", () => {
  test("redirects, spaced or not, appending or not", () => {
    expect(shellWrites("echo a > out.txt")).toEqual(["out.txt"])
    expect(shellWrites("echo a >out.txt")).toEqual(["out.txt"])
    expect(shellWrites("echo a >> log.txt")).toEqual(["log.txt"])
    expect(shellWrites("cmd &> both.txt")).toEqual(["both.txt"])
  })

  test("a redirect to nowhere, or to another descriptor, is not a write", () => {
    expect(shellWrites("bun test > /dev/null 2>&1")).toEqual([])
    expect(shellWrites("bun test 2>/dev/null")).toEqual([])
  })

  test("quotes keep a path with spaces together and are stripped", () => {
    expect(shellWrites('echo a > "my file.txt"')).toEqual(["my file.txt"])
    expect(shellWrites("echo a > 'my file.txt'")).toEqual(["my file.txt"])
    // A `>` inside quotes is text, not a redirect.
    expect(shellWrites("echo '>' > out.txt")).toEqual(["out.txt"])
  })

  test("every simple command in a line is read", () => {
    expect(shellWrites("cd src && echo a > a.ts; echo b > b.ts || echo c > c.ts\necho d | tee d.ts")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
    ])
  })

  test("tee writes every file it is given", () => {
    expect(shellWrites("cat x | tee -a one.log two.log")).toEqual(["one.log", "two.log"])
  })

  test("sed only writes with -i, and the script is not a file", () => {
    expect(shellWrites("sed 's/a/b/' src/x.ts")).toEqual([])
    expect(shellWrites("sed -i 's/a/b/' src/x.ts src/y.ts")).toEqual(["src/x.ts", "src/y.ts"])
    expect(shellWrites("sed -i.bak -e 's/a/b/' src/x.ts")).toEqual(["src/x.ts"])
    expect(shellWrites("sed --in-place -e s/a/b/ -e s/c/d/ src/x.ts")).toEqual(["src/x.ts"])
  })

  test("mv and cp write their destination; rm and touch write every argument", () => {
    expect(shellWrites("mv a.ts b.ts")).toEqual(["b.ts"])
    expect(shellWrites("cp -r src dist")).toEqual(["dist"])
    expect(shellWrites("rm -rf a.ts b.ts")).toEqual(["a.ts", "b.ts"])
    expect(shellWrites("touch new.ts")).toEqual(["new.ts"])
    // A `mv` with one argument is an error, not a write.
    expect(shellWrites("mv a.ts")).toEqual([])
  })

  test("git commands that rewrite the tree are the whole tree; the rest are nothing", () => {
    expect(shellWrites("git checkout .")).toEqual([TREE])
    expect(shellWrites("git stash")).toEqual([TREE])
    expect(shellWrites("git reset --hard HEAD~1")).toEqual([TREE])
    expect(shellWrites("git -C sub restore src/x.ts")).toEqual([TREE])
    expect(shellWrites("git status && git diff && git log --oneline")).toEqual([])
    expect(shellWrites("git stash list")).toEqual([])
    expect(shellWrites("git add . && git commit -m x")).toEqual([])
  })

  test("a package install rewrites the manifest and node_modules", () => {
    expect(shellWrites("bun add zod")).toEqual(["package.json", "node_modules"])
    expect(shellWrites("npm i")).toEqual(["package.json", "node_modules"])
    expect(shellWrites("yarn")).toEqual(["package.json", "node_modules"])
    expect(shellWrites("bun test && bun run build")).toEqual([])
  })

  test("an env prefix or sudo does not hide the command", () => {
    expect(shellWrites("CI=1 sudo tee out.txt")).toEqual(["out.txt"])
  })

  test("what it does not know, it does not guess", () => {
    expect(shellWrites("bun run build")).toEqual([])
    expect(shellWrites("node scripts/generate.js")).toEqual([])
    expect(shellWrites("python - <<'EOF'\nopen('x.txt','w').write('hi')\nEOF")).toEqual([])
  })
})

describe("collisionsIn", () => {
  test("two cards on one file collide; a file only one card wrote does not", () => {
    const collisions = collisionsIn(
      new Map([
        ["coder-a", sure("src/game.ts", "src/only-mine.ts")],
        ["coder-b", sure("src/game.ts")],
      ]),
    )
    expect(collisions).toEqual([{ path: "src/game.ts", cards: ["coder-a", "coder-b"], probable: [] }])
  })

  test("paths that differ only in punctuation or case are the same file", () => {
    // The collision a check misses because one card wrote `./src/game.ts` is
    // exactly the collision it exists to find.
    const collisions = collisionsIn(
      new Map([
        ["a", sure("./src/Game.ts")],
        ["b", sure("src\\game.ts")],
      ]),
    )
    expect(collisions.map((collision) => collision.cards)).toEqual([["a", "b"]])
  })

  test("what is shown is what the card sent, not the normalised form", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", sure("./src/Game.ts")],
        ["b", sure("src/game.ts")],
      ]),
    )
    expect(collisions[0].path).toBe("./src/Game.ts")
  })

  test("three cards on one file are one finding naming all three", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", sure("x.ts")],
        ["b", sure("x.ts")],
        ["c", sure("x.ts")],
      ]),
    )
    expect(collisions).toEqual([{ path: "x.ts", cards: ["a", "b", "c"], probable: [] }])
  })

  test("a batch where everyone stayed in their own territory reports nothing", () => {
    expect(
      collisionsIn(
        new Map([
          ["a", sure("a.ts")],
          ["b", sure("b.ts")],
        ]),
      ),
    ).toEqual([])
  })

  test("a card there on a shell guess is named as such", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", sure("x.ts")],
        ["b", [{ path: "x.ts", probable: true }]],
      ]),
    )
    expect(collisions).toEqual([{ path: "x.ts", cards: ["a", "b"], probable: ["b"] }])
  })

  test("a card that rewrote the tree collides with every file the others wrote", () => {
    const collisions = collisionsIn(
      new Map([
        ["a", sure("x.ts", "y.ts")],
        ["b", [{ path: TREE, probable: true }]],
      ]),
    )
    expect(collisions).toEqual([
      { path: "x.ts", cards: ["a", "b"], probable: ["b"] },
      { path: "y.ts", cards: ["a", "b"], probable: ["b"] },
    ])
  })

  test("a tree rewrite alone, with nothing else written, is nothing to report", () => {
    expect(collisionsIn(new Map([["a", [{ path: TREE, probable: true }]]]))).toEqual([])
  })
})

describe("collisionNote", () => {
  const plain = (path: string, ...cards: string[]) => ({ path, cards, probable: [] })

  test("nothing to report leaves the prompt alone", () => {
    expect(collisionNote([], false)).toBeUndefined()
  })

  test("names the file, names the cards, and says the earlier write is gone", () => {
    const note = collisionNote([plain("src/game.ts", "coder-a", "coder-b")], false)!
    expect(note).toContain("src/game.ts")
    expect(note).toContain("coder-a, coder-b")
    expect(note).toContain("only the last")
    // The card whose work went under still reported success — the orchestrator
    // has to be told that, or it builds on an answer describing a file that no
    // longer says that.
    expect(note).toContain("did not fail")
  })

  test("it reports rather than orders a revert", () => {
    // The engine does not know which of the two writes was worth keeping, and a
    // card told to undo the right half spends a round making the work worse.
    const note = collisionNote([plain("a.ts", "a", "b")], false)!
    expect(note).not.toContain("revert")
    expect(note).toContain("belongs to **one** card")
  })

  test("a card there on a guess is marked, and the guess explained once", () => {
    const note = collisionNote([{ path: "a.ts", cards: ["a", "b"], probable: ["b"] }], true)!
    expect(note).toContain("a, b (probable, from a shell command)")
    expect(note).toContain("marked *probable*")
    expect(collisionNote([plain("a.ts", "a", "b")], false)).not.toContain("marked *probable*")
  })

  test("a shell-capable card makes the list a floor, and says so", () => {
    expect(collisionNote([plain("a.ts", "a", "b")], true)).toContain("least that")
    expect(collisionNote([plain("a.ts", "a", "b")], false)).not.toContain("least that")
  })
})
