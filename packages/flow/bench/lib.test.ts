/**
 * Die Regeln der Autonomie-Messung gegen Feldfälle.
 *
 * Die Shell-Zeilen und der Schlussbericht stammen wörtlich aus den
 * W4-Benchmarkläufen vom 23.10.2026 (Testdienst, opencode.db unter
 * w0/xdg). Wo die erste Fassung (Python, Regex auf den ersten 160 Zeichen)
 * falsch lag, steht sie als `alteRegel` daneben: Der Test beweist damit
 * zugleich, dass er die alte Fassung ROT gemeldet hätte.
 */
import { describe, expect, it } from "bun:test"
import {
  type Nachricht,
  ausschlussGrund,
  fanoutKennzahlen,
  fuehrtSkriptAus,
  istArbeitsaufruf,
  istStichprobe,
  istTestZeile,
  istWarteAbfrage,
  pruefeKontrollwerte,
  quantil,
  segmente,
} from "./lib"

const AUS = /(\.\/|bash |sh |[\w.-]+\/)pruefe\.sh/
const LES = /^\s*(grep|cat|sed|head|tail|less|wc|ls)\b/
const alteRegel = (cmd: string) => AUS.test(cmd.slice(0, 160)) && !LES.test(cmd.slice(0, 160))

describe("fuehrtSkriptAus — Arbeitsaufruf (Ausführung) vs. Stichprobe (Lesen)", () => {
  const ausfuehrung = [
    "./pruefe.sh",
    './pruefe.sh 2>&1; echo "EXIT=$?"',
    "./pruefe.sh > /tmp/opencode/gamma-pruefe-stdout.log 2> /tmp/opencode/gamma-pruefe-stderr.log; printf 'EXIT_CODE=%s\\n' \"$?\"",
    "bash ./pruefe.sh",
    "cd alpha && ./pruefe.sh",
    "cd /home/x/bench/laeufe/B1-dharma_power-2/beta && ./pruefe.sh",
    "cd /home/x/bench/laeufe/B1-dharma_power-0/beta && timeout 60 ./pruefe.sh >/tmp/opencode/beta_out.txt 2>/tmp/opencode/beta_err.txt;",
    'cd alpha && ./pruefe.sh; echo "ERGEBNIS-Code:$?"; echo "TODO-Anzahl:$(grep -rIn \'TODO\' src/ 2>/dev/null | wc -l)"',
    'for p in alpha beta gamma; do echo "== $p =="; (cd "$p" && ./pruefe.sh; echo "EXIT=$?"; echo "TODOs=$(grep -rn \'TODO\' src/ | wc -l)"); done',
    'timeout 60 ./pruefe.sh >/tmp/opencode/alpha_pruefe_stdout.txt 2>/tmp/opencode/alpha_pruefe_stderr.txt; echo "EXIT_CODE=$?"',
  ]
  const stichprobe = [
    "cat epsilon/pruefe.sh",
    'grep -H "ERGEBNIS" alpha/pruefe.sh beta/pruefe.sh gamma/pruefe.sh delta/pruefe.sh; ls .git/worktrees 2>/dev/null',
    'ls -la alpha/ && ls -d alpha/src 2>&1; test -x alpha/pruefe.sh && echo "EXECUTABLE=yes" || echo "EXECUTABLE=no"',
    'pwd && ls -la && echo "---" && find . -maxdepth 3 -name "pruefe.sh" 2>/dev/null',
    "ls -l pruefe.sh src",
    'git add delta/src/rechne.js && git commit -m "fix(delta): add() subtrahierte statt addiert (a - b -> a + b)\n\npruefe.sh schlug fehl, weil add(2,3)=-1 statt 5 lieferte"',
  ]
  // Feldfälle, an denen die erste Fassung irrte
  const alteIrrte: [string, boolean][] = [
    ['echo "=== beta/pruefe.sh ==="; cat beta/pruefe.sh; echo "=== TODO-Zählung beta (Stichprobe) ==="; grep -rn "TODO" beta/src/ | wc -l', false],
    ['echo "--- ls gamma ---"; ls -la gamma/; echo "--- pruefe.sh ---"; cat gamma/pruefe.sh; echo "--- TODO-Zaehlung ---"; grep -rn "TODO" gamma/src/ | wc -l', false],
    ['pwd && echo "=== STRUKTUR ===" && ls -la && for p in alpha beta gamma; do echo "=== $p ==="; ls -la "$p" 2>&1; echo "--- $p/pruefe.sh ---"; cat "$p/pruefe.sh" 2>&1; done', false],
    ['cd /home/x/bench/laeufe/B4-dharma_power-3 && echo "=== epsilon/pruefe.sh ==="; cat -n epsilon/pruefe.sh; echo "=== gamma/pruefe.sh ==="; cat -n gamma/pruefe.sh', false],
    ['ls -la .erster-lauf && git status --short && echo "--- Testlauf ---" && ./pruefe.sh; echo "exit=$?"', true],
    [
      'git merge ses-b2/wt-delta-fix && echo "=== MERGE OK ===" && git log --oneline -2 && git diff 243bd30 HEAD --stat && echo "=== STICHPROBE ===" && cd delta && ./pruefe.sh; echo "EXIT:$?"',
      true,
    ],
  ]

  for (const c of ausfuehrung) it(`führt aus: ${c.slice(0, 60)}`, () => expect(fuehrtSkriptAus(c)).toBe(true))
  for (const c of stichprobe) it(`liest nur: ${c.slice(0, 60)}`, () => expect(fuehrtSkriptAus(c)).toBe(false))
  for (const [c, soll] of alteIrrte) {
    it(`Feldfall (alte Regel irrte): ${c.slice(0, 50)}`, () => {
      expect(fuehrtSkriptAus(c)).toBe(soll)
      expect(alteRegel(c)).toBe(!soll) // Gegenprobe: die erste Fassung wäre hier rot
    })
  }

  it("Trenner in Anführungszeichen trennen nicht, 2>&1 trennt nicht", () => {
    expect(segmente('echo "a; ./pruefe.sh" && cat x 2>&1')).toEqual(['echo "a; ./pruefe.sh"', "cat x 2>&1"])
  })
})

describe("Stichprobe und Warte-Abfrage (Feld)", () => {
  it("reine Lesezeilen sind Stichproben", () => {
    expect(istStichprobe('grep -rn "TODO" src/ | wc -l && grep -rn "TODO" src/')).toBe(true)
    expect(istStichprobe("git status --short && git log --oneline -3")).toBe(true)
    expect(istStichprobe("cd x && sed -n 1,20p a.ts")).toBe(true)
  })
  it("schreibende oder ausführende Zeilen sind keine Stichproben", () => {
    expect(istStichprobe("sed -i s/a/b/ x.ts")).toBe(false)
    expect(istStichprobe("npm test")).toBe(false)
    expect(istStichprobe("git worktree add /tmp/x -b y")).toBe(false)
    expect(istStichprobe("git commit -m x")).toBe(false)
    expect(istStichprobe("tail -f /tmp/x.log")).toBe(false)
  })
  it("sleep/ps/pgrep/tail -f sind Warte-Abfragen, auch hinter 160 Zeichen", () => {
    expect(istWarteAbfrage("sleep 30; cat log")).toBe(true)
    expect(istWarteAbfrage("tail -f /tmp/x.log")).toBe(true)
    expect(istWarteAbfrage(`echo "${"x".repeat(200)}"; ps aux | grep -i w0`)).toBe(true)
    expect(istWarteAbfrage('echo "sleep gut"; tail -n 5 x')).toBe(false)
  })
  it("Arbeitsaufruf im Feld: subagent immer, shell nur ohne Lesen/Warten", () => {
    expect(istArbeitsaufruf({ tool: "subagent", cmd: "" })).toBe(true)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "npm run test:unit" })).toBe(true)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "cat x" })).toBe(false)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "sleep 60" })).toBe(false)
    expect(istArbeitsaufruf({ tool: "read", cmd: "" })).toBe(false)
  })
})

describe("pruefeKontrollwerte — Tabellenzeile entscheidet", () => {
  const SOLL = { alpha: ["A-4417", 3], beta: ["B-9062", 5], gamma: ["G-1385", 2] } as const
  const soll = SOLL as unknown as Record<string, [string, number | null]>
  // Feldfall B1 dharma/power #3 (ses_e958fdfbdffeIeEEFMJrqIMEQ6), wörtlich
  const FELD =
    "Alle drei Pakete geprüft.\n\n| Paket | ERGEBNIS-Code | TODO-Anzahl |\n|---|---|---|\n| alpha | 0 | 3 |\n| beta | 0 | 5 |\n| gamma | 0 | 2 |\n\n" +
    "Alle drei Läufe endeten mit Exit-Code 0; die `pruefe.sh`-Ausgaben waren `ERGEBNIS alpha A-4417`, `ERGEBNIS beta B-9062` und `ERGEBNIS gamma G-1385`. [9/10]"

  it("Feldfall: Exit-Code 0 in der Code-Spalte ist falsch, auch wenn die Codes im Fließtext stehen", () => {
    expect(pruefeKontrollwerte(FELD, soll)).toEqual({ alpha: false, beta: false, gamma: false })
  })

  it("Gegenprobe: die alte Zeilenregel lässt sich vom Fließtext retten", () => {
    const text = FELD.replace("[9/10]", "[3/10]")
    const alt = (t: string, p: string, code: string, n: number) =>
      t.includes(code) && t.split("\n").some((z) => z.includes(p) && z.includes(code) && new RegExp(`(?<![\\d-])${n}(?![\\d-])`).test(z.replaceAll(code, "")))
    expect(alt(text, "alpha", "A-4417", 3)).toBe(true)
    expect(pruefeKontrollwerte(text, soll).alpha).toBe(false)
  })

  it("richtige Tabelle (auch mit Backticks) besteht", () => {
    const t = "| Paket | ERGEBNIS-Code | TODO-Anzahl |\n|---|---|---|\n| alpha | `A-4417` | 3 |\n| **beta** | B-9062 | 5 |\n| gamma | G-1385 | 2 |"
    expect(pruefeKontrollwerte(t, soll)).toEqual({ alpha: true, beta: true, gamma: true })
  })

  it("falsche Zahl in der Tabelle fällt durch", () => {
    const t = "| alpha | A-4417 | 4 |\n| beta | B-9062 | 5 |\n| gamma | G-1385 | 2 |"
    expect(pruefeKontrollwerte(t, soll)).toEqual({ alpha: false, beta: true, gamma: true })
  })

  it("ohne Tabelle: Code-Aufgaben (B2/B4) genügt der Code im Text", () => {
    expect(pruefeKontrollwerte("delta D-7720, alpha A-4417", { delta: ["D-7720", null], alpha: ["A-4417", null], beta: ["B-9062", null] })).toEqual({
      delta: true,
      alpha: true,
      beta: false,
    })
  })

  it("ohne Tabelle: die Zahl darf nicht Teil des Codes sein", () => {
    expect(pruefeKontrollwerte("gamma G-1385 erledigt", { gamma: ["G-1385", 3] }).gamma).toBe(false)
    expect(pruefeKontrollwerte("gamma G-1385, 2 TODOs", { gamma: ["G-1385", 2] }).gamma).toBe(true)
  })
})

describe("ausschlussGrund — Benchmark-, Abnahme- und Testsitzungen", () => {
  const alle = new Map([
    ["ses_b", { id: "ses_b", directory: "/home/t/workspace/OpenFlow/packages/flow/bench/laeufe/B1-dharma_power-1" }],
    ["ses_j", { id: "ses_j", directory: "/home/t/.claude/jobs/9de35ddc/tmp/ab/repo", title: "ab-neu-1" }],
    ["ses_a", { id: "ses_a", directory: "/home/t/workspace/mcp-workers", title: "abnahme-live W1 23.10." }],
    ["ses_k", { id: "ses_k", parent_id: "ses_a", directory: "/home/t/workspace/mcp-workers", title: "Tests dharma" }],
    ["ses_f", { id: "ses_f", directory: "/home/t/workspace/mcp-workers", title: "Abnahme Loop-Fixes" }],
    ["ses_testende1", { id: "ses_testende1" }],
  ])
  it("Gründe", () => {
    expect(ausschlussGrund(alle.get("ses_b")!, alle)).toBe("benchmark")
    expect(ausschlussGrund(alle.get("ses_j")!, alle)).toBe("job-tmp")
    expect(ausschlussGrund(alle.get("ses_a")!, alle)).toBe("abnahme-live")
    expect(ausschlussGrund(alle.get("ses_testende1")!, alle)).toBe("test")
  })
  it("ein Kind erbt den Grund seiner Wurzel", () => {
    expect(ausschlussGrund(alle.get("ses_k")!, alle)).toBe("abnahme-live")
  })
  it("Feldsitzung zählt — auch „Abnahme …“ ohne den festen Präfix", () => {
    expect(ausschlussGrund(alle.get("ses_f")!, alle)).toBeNull()
  })
  it("Ledger-Testzeilen", () => {
    expect(istTestZeile({ sessionID: "ses_testende2", parent: "ses_parent1" })).toBe(true)
    expect(istTestZeile({ sessionID: "ses_ed3448f73ffeu8KolaC6zDJu9f" })).toBe(false)
  })
})

describe("fanoutKennzahlen", () => {
  const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool", name, state: { input } })
  const ms: Nachricht[] = [
    { type: "user" },
    // ganz im Hintergrund
    { type: "assistant", content: [tool("subagent", { background: true }), tool("subagent", { background: true })] },
    // halb im Hintergrund: Fan-out, aber nicht „mit background"
    { type: "assistant", content: [tool("shell", { command: "npm test", background: true }), tool("subagent", {})] },
    // zwei Stichproben: kein Fan-out
    { type: "assistant", content: [tool("shell", { command: "cat a" }), tool("shell", { command: "grep x b" })] },
    // Warte-Abfrage
    { type: "assistant", content: [tool("shell", { command: "sleep 20; tail -n 5 log" })] },
  ]
  it("Feld: Fan-outs, davon ganz im Hintergrund, Warte-Abfragen", () => {
    expect(fanoutKennzahlen(ms)).toEqual({
      arbeitsaufrufe: 4,
      davon_bg: 3,
      fanouts: 2,
      fanouts_bg: 1,
      max_parallel_in_einer_nachricht: 2,
      warte_abfragen: 1,
    })
  })
  it("Benchmark: nur Ausführungen des Skripts zählen", () => {
    const b: Nachricht[] = [
      { type: "assistant", content: [tool("shell", { command: "cd alpha && ./pruefe.sh", background: true }), tool("shell", { command: "cat beta/pruefe.sh" })] },
    ]
    expect(fanoutKennzahlen(b, "pruefe.sh")).toMatchObject({ arbeitsaufrufe: 1, fanouts: 0 })
  })
})

describe("quantil", () => {
  it("wie die Auswertung vom 23.10.: Index floor(p·n)", () => {
    expect(quantil([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(quantil([1, 2, 3, 4], 0.9)).toBe(4)
    expect(quantil([], 0.5)).toBeNull()
  })
})
