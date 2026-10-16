import { describe, expect, test } from "bun:test"
import {
  parseNextMoveSuggestion,
  stripFooter,
  vertragsZeile,
} from "@/pages/session/loop/nextMove"

// Die Beispiel-Schritte stammen wörtlich aus der Abnahme R14 des Vertrags
// (~/.config/opencode/plugins-shared/naechster-schritt.ts, Zeilen 7–9).
const mensch = (schritt: string) => `NEXT MOVE (Mensch): ${schritt}`

describe("vertragsZeile (Kopf 1:1 aus plugins-shared)", () => {
  test("Doppelpunkt, Gedankenstrich und Kategorie+Leerzeichen als Trenner", () => {
    expect(vertragsZeile("NEXT MOVE (Mensch): PR mergen.")?.schritt).toBe("PR mergen.")
    expect(vertragsZeile("NEXT MOVE (Mensch) – PR mergen.")?.schritt).toBe("PR mergen.")
    expect(vertragsZeile("NEXT MOVE (Mensch) b.md prüfen")?.schritt).toBe("b.md prüfen")
    expect(vertragsZeile("next_move (mensch): PR mergen.")?.schritt).toBe("PR mergen.")
  })

  test("keine Vertragszeile: Zitat, Prosa, NEXT MOVE ohne Kategorie-Trenner", () => {
    expect(vertragsZeile("> NEXT MOVE (Mensch): PR mergen.")).toBeNull()
    expect(vertragsZeile("Der nächste Schritt ist der Merge.")).toBeNull()
    expect(vertragsZeile("NEXTMOVELIST (Mensch): x")).toBeNull()
  })
})

describe("stripFooter (dharma-Fußzeile)", () => {
  test("entfernt nur Zeilen, die nur die Fußzeile tragen", () => {
    const text = `${mensch("PR mergen.")}\n⎯⎯ gpt-oss-20b · fast · nvidia ⎯⎯`
    expect(stripFooter(text)).toBe(mensch("PR mergen."))
    expect(stripFooter("Ergebnis ⎯⎯ modell ⎯⎯ im Satz")).toContain("⎯⎯ modell ⎯⎯")
  })
})

describe("parseNextMoveSuggestion T-01", () => {
  test("(Mensch)-Zeile → Vorschlag: die drei R14-Beispiele", () => {
    expect(parseNextMoveSuggestion(mensch("PR mergen, nachdem Thomas ihn sich angesehen hat."))).toEqual({
      schritt: "PR mergen, nachdem Thomas ihn sich angesehen hat.",
    })
    expect(parseNextMoveSuggestion(mensch("Abstimmen mit dem Security-Team, danach mergen."))).toEqual({
      schritt: "Abstimmen mit dem Security-Team, danach mergen.",
    })
    expect(parseNextMoveSuggestion("NEXT MOVE (Mensch): Merge after Lisa takes a look.")).toEqual({
      schritt: "Merge after Lisa takes a look.",
    })
  })

  test("kein Vorschlag: ohne Kategorie, keiner, leer, (selbst), (human) ja", () => {
    // „Weiter mit Phase 2: …“ ohne Kategorie → kein Vorschlag.
    expect(parseNextMoveSuggestion("NEXT MOVE: Weiter mit Phase 2: Datenbank-Migration")).toBeNull()
    expect(parseNextMoveSuggestion("NEXT MOVE: keiner")).toBeNull()
    expect(parseNextMoveSuggestion("NEXT MOVE (keiner)")).toBeNull()
    expect(parseNextMoveSuggestion("NEXT MOVE (Mensch)")).toBeNull() // kein Schritt
    expect(parseNextMoveSuggestion("NEXT MOVE (selbst): Tests laufen lassen.")).toBeNull()
    // mensch-Kategorie case-insensitive, (human) als englische Form.
    expect(parseNextMoveSuggestion("NEXT MOVE (MENSCH): PR mergen.")?.schritt).toBe("PR mergen.")
    expect(parseNextMoveSuggestion("NEXT MOVE (human): Merge after Lisa takes a look.")?.schritt).toBe(
      "Merge after Lisa takes a look.",
    )
  })

  test("dharma-Footer unter dem Absatz wird abgezogen", () => {
    const text = `${mensch("PR mergen, nachdem Thomas ihn sich angesehen hat.")}\n\n⎯⎯ gpt-oss-20b · fast · nvidia ⎯⎯`
    expect(parseNextMoveSuggestion(text)?.schritt).toBe("PR mergen, nachdem Thomas ihn sich angesehen hat.")
  })

  test("ganze Vertragszeile in Backticks ist Form, kein Code (R16)", () => {
    expect(parseNextMoveSuggestion("`NEXT MOVE (Mensch): PR mergen.`")?.schritt).toBe("PR mergen.")
    expect(parseNextMoveSuggestion("- `NEXT MOVE (Mensch): PR mergen.`")?.schritt).toBe("PR mergen.")
  })

  test("Fettdruck um Kopf oder ganze Zeile", () => {
    expect(parseNextMoveSuggestion("**NEXT MOVE (Mensch):** PR mergen.")?.schritt).toBe("PR mergen.")
    expect(parseNextMoveSuggestion("**NEXT MOVE (Mensch): PR mergen.**")?.schritt).toBe("PR mergen.")
  })

  test("Überschrift „## NEXT MOVE (Mensch)“ mit Schritt im Absatz darunter", () => {
    const text = "Fertig bis hier.\n\n## NEXT MOVE (Mensch)\n\nPR mergen, nachdem Thomas ihn sich angesehen hat."
    expect(parseNextMoveSuggestion(text)?.schritt).toBe("PR mergen, nachdem Thomas ihn sich angesehen hat.")
  })

  test("Aufzählungszeichen und Gedankenstrich-Trenner", () => {
    expect(parseNextMoveSuggestion("- NEXT MOVE (Mensch) – Abstimmen mit dem Security-Team.")?.schritt).toBe(
      "Abstimmen mit dem Security-Team.",
    )
  })

  test("Inline-Code: Erkennung ohne Code, Schritt-Text mit Code (R16 (2))", () => {
    // Beispiel im Fließtext ist keine Anweisung → keine Karte.
    expect(
      parseNextMoveSuggestion("Der Vertrag zeigt: `NEXT MOVE (Mensch): PR mergen.` — so endet ein Subagent."),
    ).toBeNull()
    // Code im Schritt bleibt im Schritt-Text.
    expect(parseNextMoveSuggestion("NEXT MOVE (Mensch): Release freigeben, sobald `gh pr checks` grün ist.")?.schritt).toBe(
      "Release freigeben, sobald `gh pr checks` grün ist.",
    )
  })

  test("Code-Zäune werden ignoriert, auch abgeschnitten offen", () => {
    expect(
      parseNextMoveSuggestion("```\nNEXT MOVE (Mensch): Fake aus einem Codeblock\n```"),
    ).toBeNull()
    expect(parseNextMoveSuggestion("~~~\nNEXT MOVE (Mensch): Fake\n")).toBeNull()
    expect(parseNextMoveSuggestion("Text\n\n```\nNEXT MOVE (Mensch): Fake\n```\n\nNoch Prosa danach.")).toBeNull()
  })

  test("eingerückter Code zählt nicht", () => {
    expect(parseNextMoveSuggestion("Beispiel:\n\n    NEXT MOVE (Mensch): Fake")).toBeNull()
  })

  test("leerer Text ohne Vertrag → null", () => {
    expect(parseNextMoveSuggestion("")).toBeNull()
    expect(parseNextMoveSuggestion("Nur Prosa, kein Vertrag, alte Antworten ohne Marker.")).toBeNull()
  })
})

describe("parseNextMoveSuggestion T-02 (E5: letzte Zeile gewinnt)", () => {
  test("zwei (Mensch)-Zeilen im letzten Absatz → nur der letzte Schritt", () => {
    const text = `${mensch("PR mergen, nachdem Thomas ihn sich angesehen hat.")}\n${mensch("Abstimmen mit dem Security-Team, danach mergen.")}`
    expect(parseNextMoveSuggestion(text)).toEqual({
      schritt: "Abstimmen mit dem Security-Team, danach mergen.",
    })
  })

  test("letzte Zeile ohne Kategorie verdrängt früheren (Mensch)-Vorschlag nicht", () => {
    // Nur EINE Vertragszeile + Prosa-Zeile danach: die Prosa-Zeile gehört zum Schritt
    // (Zeilen nach dem Treffer im selben Absatz), wie in naechster-schritt.ts:672.
    const text = `${mensch("PR mergen.")}\nDetails im report.md.`
    expect(parseNextMoveSuggestion(text)).toEqual({ schritt: "PR mergen.\nDetails im report.md." })
  })
})
