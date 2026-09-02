import type { NodeEvent } from "./types"

/**
 * Tools that change a file, and the field naming what they changed.
 *
 * The v2 registry calls it `path` on both writers (`packages/core/src/tool/
 * write.ts`, `edit.ts`); `filePath` is here because the model-facing schema
 * carries a standing TODO to rename it that way for trained-in compatibility,
 * and a card that guesses the trained name should still be counted rather than
 * silently dropped.
 */
const WRITERS = new Set(["write", "edit", "apply_patch", "apply-patch"])

/**
 * The path a shell command that rewrites the working tree is recorded under —
 * `git checkout`, `git stash`, `git reset` and their kin touch every file the
 * other cards wrote, so a card that ran one collides with all of them.
 */
export const TREE = "<the whole working tree>"

/** One file a card wrote. `probable` when the only evidence is a shell command. */
export type Write = { path: string; probable?: boolean }

/**
 * One file two cards in the same batch both wrote, in the order they wrote it.
 * `probable` lists the cards among them whose write was read off a shell line
 * rather than a write tool — a guess the orchestrator should weigh as one.
 */
export type Collision = { path: string; cards: string[]; probable: string[] }

/**
 * Files this card wrote, read off the tool calls it made.
 *
 * The events are the ones the activity stream already keeps for the card, so
 * this costs no extra request: `input` is the tool's arguments as sent, which
 * is where the path is. A failed call is not a write — a tool the provider
 * rejected never touched the disk, and counting it would report a collision
 * between a card that wrote and a card that was refused.
 *
 * `bash` is read too, but only as far as a shell line can honestly be read:
 * `shellWrites` below knows redirects, `tee`, `sed -i`, `mv`, `cp`, `rm`,
 * `touch`, package installs and the git commands that rewrite the tree, and
 * nothing else. What it finds is marked probable, because `cat > a.ts` and
 * `cat > "$OUT"` look alike to it; what it cannot find — a build script, a
 * program that writes files, a heredoc into an interpreter — is simply absent,
 * which is why the note still calls the list a floor on a shell-capable card.
 */
export function writesOf(events: NodeEvent[], since = 0) {
  const writes: Write[] = []
  const add = (path: string, probable: boolean) => {
    const seen = writes.find((entry) => entry.path === path)
    if (!seen) return writes.push({ path, ...(probable ? { probable } : {}) })
    // A write tool is the better evidence; a shell guess never downgrades it.
    if (!probable) delete seen.probable
  }
  for (const event of events) {
    if (event.kind !== "tool" || event.at < since || event.status === "error") continue
    const tool = event.title.split(" ")[0]
    if (WRITERS.has(tool)) {
      const path = pathIn(event.input)
      if (path) add(path, false)
      continue
    }
    if (tool !== "bash") continue
    const command = parse(event.input ?? "")?.command
    if (typeof command !== "string") continue
    for (const path of shellWrites(command)) add(path, true)
  }
  return writes
}

/**
 * Where two cards in one batch wrote the same file.
 *
 * Batch-scoped on purpose. Two cards writing one file in *different* batches is
 * ordinary iteration — the orchestrator dispatched them in sequence and knows
 * which came second. Within one batch nothing ordered them: the pool ran them
 * at once, no lock exists anywhere in this fork, and the later write wins with
 * nothing anywhere reporting that the earlier one is gone.
 *
 * `wrote` maps a dispatched card to the paths it and everything below it
 * touched, because the card the orchestrator can re-dispatch is the one at the
 * top of that subtree, not whichever leaf held the pen.
 *
 * A card that rewrote the working tree (`TREE`) collides with every file any
 * other card wrote: a `git checkout .` does not care which file it reverts.
 */
export function collisionsIn(wrote: Map<string, Write[]>) {
  const byPath = new Map<string, { display: string; cards: string[]; probable: string[] }>()
  const claim = (key: string, display: string, card: string, probable: boolean) => {
    const seen = byPath.get(key) ?? { display, cards: [], probable: [] }
    if (!seen.cards.includes(card)) {
      seen.cards.push(card)
      if (probable) seen.probable.push(card)
    } else if (!probable) seen.probable = seen.probable.filter((entry) => entry !== card)
    byPath.set(key, seen)
  }
  for (const [card, writes] of wrote) {
    for (const write of writes) {
      // Two cards can name one file differently — `src/game.ts` and
      // `./src/game.ts`, or either case of a Windows drive letter — and a
      // collision the check misses because of punctuation is the collision it
      // exists to find. Comparison is normalised; what the user is shown is
      // what the card actually sent.
      claim(normalizePath(write.path), write.path, card, !!write.probable)
    }
  }
  const treeCards = [...wrote].filter(([, writes]) => writes.some((write) => write.path === TREE)).map(([card]) => card)
  for (const [key, entry] of byPath) {
    if (key === normalizePath(TREE)) continue
    for (const card of treeCards) if (!entry.cards.includes(card)) claim(key, entry.display, card, true)
  }
  return [...byPath.values()]
    .filter((entry) => entry.cards.length > 1)
    .map<Collision>((entry) => ({ path: entry.display, cards: entry.cards, probable: entry.probable }))
}

/**
 * What the orchestrator is told about the collisions its last batch produced.
 *
 * Written as a finding rather than an instruction: the engine does not know
 * which of the two writes was the one worth keeping, and a card told "revert
 * b" when b was right would spend a round undoing the good half. It states
 * what happened, names the rule the batch broke, and leaves the decision where
 * the decision belongs.
 *
 * Returns undefined when there is nothing to report, so the caller can leave
 * the prompt exactly as it was.
 */
export function collisionNote(collisions: Collision[], hasShell: boolean) {
  if (!collisions.length) return undefined
  const probable = collisions.some((collision) => collision.probable.length)
  return [
    "# Your cards wrote over each other",
    "",
    "These files were written by more than one card in the batch you just dispatched. Nothing",
    "orders writes inside a batch and nothing locks a file, so for each of these only the last",
    "write survives and the earlier one is gone — including any part of it the later card had",
    "no idea existed.",
    "",
    ...collisions.map(
      (collision) =>
        `- \`${collision.path}\` — ${collision.cards
          .map((card) => (collision.probable.includes(card) ? `${card} (probable, from a shell command)` : card))
          .join(", ")}`,
    ),
    "",
    "Check what survived before you build on it. A card whose work was overwritten did not fail",
    "and will report success, so its answer above describes a file that no longer says that.",
    ...(probable
      ? [
          "",
          "A write marked *probable* was read off a shell command rather than a write tool — a",
          "redirect, `sed -i`, `mv`, a package install, or a git command that rewrites the whole",
          "tree. The command was seen; whether it wrote what it looks like it wrote was not.",
        ]
      : []),
    "",
    "This is the split that caused it: work on one file belongs to **one** card. Give the file to",
    "a single card and let it make every change in sequence, or split the work so that no two",
    "cards need the same file. Cards cannot see each other, so two of them editing one file are",
    "each writing against a version they imagined.",
    ...(hasShell
      ? [
          "",
          "Some of these cards can also run shell commands, and only the plain ones — redirects,",
          "`sed -i`, `mv`, installs, git — can be read for the files they touch. A build script or a",
          "program that writes files leaves no trace here, so treat the list above as the least that",
          "collided, not all of it.",
        ]
      : []),
  ].join("\n")
}

/**
 * The files a shell command probably writes, as far as one can be read.
 *
 * Deliberately narrow. It knows the plain forms — `> file`, `>> file`, `tee`,
 * `sed -i`, `mv`/`cp` to a destination, `rm`, `touch`, a package manager
 * installing or adding, and the git commands that rewrite the working tree —
 * and nothing else. A build script, an interpreter fed a heredoc, a program
 * that writes on its own account, `cd` before a relative path: all invisible
 * here. Everything it returns is a guess, which is why the caller marks it so.
 */
export function shellWrites(command: string) {
  const paths: string[] = []
  const add = (path: string) => {
    if (!path || path.startsWith("/dev/") || path.startsWith("&") || paths.includes(path)) return
    paths.push(path)
  }
  for (const words of segments(command)) {
    const rest: string[] = []
    for (let i = 0; i < words.length; i++) {
      // A quoted `>` is text, not a redirect.
      const match = words[i].quoted ? null : words[i].text.match(/^\d?(>>|>|&>)(.*)$/)
      if (!match) {
        rest.push(words[i].text)
        continue
      }
      // `> file` and `>file` both happen; `2>&1` and `> /dev/null` are not writes.
      if (match[2]) add(match[2])
      else if (i + 1 < words.length) add(words[++i].text)
    }
    // `FOO=bar cmd`, `sudo cmd`, `env cmd` — the command is further along.
    while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || rest[0] === "sudo" || rest[0] === "env")) rest.shift()
    const [cmd, ...args] = rest
    if (!cmd) continue
    const positional = args.filter((arg) => !arg.startsWith("-"))
    switch (cmd) {
      case "tee":
        positional.forEach(add)
        break
      case "sed": {
        if (!args.some((arg) => /^-i|^--in-place/.test(arg))) break
        // Without `-e` the first positional is the script, not a file.
        const files: string[] = []
        let scripted = false
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-e" || args[i] === "--expression" || args[i] === "-f" || args[i] === "--file") {
            scripted = true
            i++
            continue
          }
          if (args[i].startsWith("-")) continue
          files.push(args[i])
        }
        ;(scripted ? files : files.slice(1)).forEach(add)
        break
      }
      case "mv":
      case "cp":
        if (positional.length >= 2) add(positional[positional.length - 1])
        break
      case "rm":
      case "touch":
        positional.forEach(add)
        break
      case "git": {
        // `git -C dir sub` and `git -c k=v sub`: the option takes the next word.
        const rest = args.filter((arg, i) => !(i > 0 && (args[i - 1] === "-C" || args[i - 1] === "-c")))
        const [sub, next] = rest.filter((arg) => !arg.startsWith("-"))
        if (sub === "stash" && ["list", "show"].includes(next)) break
        if (sub && TREE_OPS.has(sub)) add(TREE)
        break
      }
      case "npm":
      case "pnpm":
      case "yarn":
      case "bun": {
        const sub = positional[0]
        // `yarn` alone installs; the rest need a subcommand.
        if (!(INSTALLS.has(sub) || (cmd === "yarn" && !sub))) break
        add("package.json")
        add("node_modules")
        break
      }
    }
  }
  return paths
}

/** Git subcommands that replace files in the working tree wholesale. */
const TREE_OPS = new Set([
  "checkout",
  "switch",
  "restore",
  "reset",
  "stash",
  "clean",
  "merge",
  "rebase",
  "pull",
  "revert",
  "cherry-pick",
  "apply",
  "am",
])

/** Package-manager subcommands that rewrite `package.json` and `node_modules`. */
const INSTALLS = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "ci"])

/**
 * A command line as a list of simple commands, each a list of words.
 *
 * Splits on newlines, `;`, `|`, `&&` and `||` outside quotes, keeps quoted
 * text together with the quotes stripped, and treats a backslash as escaping
 * the next character. That is the whole grammar it knows; subshells, heredocs
 * and `$(...)` pass through as words.
 */
function segments(command: string) {
  const out: { text: string; quoted: boolean }[][] = []
  let words: { text: string; quoted: boolean }[] = []
  let word = ""
  let has = false
  let quoted = false
  let quote: "'" | '"' | undefined
  const endWord = () => {
    if (has) words.push({ text: word, quoted })
    word = ""
    has = false
    quoted = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      has = true
      quoted = true
      continue
    }
    if (char === "\\" && i + 1 < command.length) {
      const next = command[++i]
      if (next !== "\n") {
        word += next
        has = true
      }
      continue
    }
    if (char === "\n" || char === ";") {
      endSegment()
      continue
    }
    if (char === "|" || char === "&") {
      // `||`, `|`, `&&`, and a trailing `&`: all end the simple command. `&>`
      // is a redirect and stays a word.
      if (char === "&" && command[i + 1] === ">") {
        endWord()
        word = "&"
        has = true
        continue
      }
      if (command[i + 1] === char) i++
      endSegment()
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    word += char
    has = true
  }
  endSegment()
  return out
}

/** The path a writing tool was given, from the arguments as sent. */
function pathIn(input: string | undefined) {
  if (!input) return undefined
  const parsed = parse(input)
  if (!parsed) return undefined
  for (const key of ["path", "filePath"]) {
    const value = parsed[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function parse(input: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * One spelling for one file: forward slashes, no leading `./`, no trailing
 * slash, case folded. Shared with the dispatch parser so a declared path and
 * a written one are compared the same way.
 */
export function normalizePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}
