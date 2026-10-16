/**
 * NEXT-MOVE-Parser für den Session-Loop-Tab (Stufe 2): findet die LETZTE
 * Vertragszeile „NEXT MOVE (Mensch): <Schritt>“ in einem Assistant-Text.
 *
 * Der Parser-Kopf (VERTRAG_KOPF, zeilenKern, vertragsZeile) und der
 * Footer-Abzug (FOOTER_LINE, stripFooter) sind 1:1 übernommen aus
 * ~/.config/opencode/plugins-shared/naechster-schritt.ts
 * (VERTRAG_KOPF/zeilenKern/vertragsZeile: Zeilen 35–66; FOOTER_LINE: Zeile 631;
 * stripFooter: Zeilen 711–717; Code-Behandlung: extractNextMove, Zeilen 639–690),
 * Stand 16.10.2026. Quelle der Wahrheit bleibt plugins-shared — dieses Modul
 * zeigt nur an (Anzeige ≠ Resume-Entscheidung), daher KEIN Sicherheitsnetz
 * (keinSchritt/sichererSchritt) und keine max-steps-Erkennung.
 */

// Vertragszeile, nach Abzug von Überschrift/Aufzählung/Emoji. Gruppe 1 = Kategorie, 2 = Schritt.
// Ohne Doppelpunkt nur als Überschrift ohne Schritt („## NEXT MOVE (selbst)“, Schritt im Absatz darunter).
// Kein `>`: Eine Zitatzeile ist ein Zitat, keine Anweisung (Abnahme R10).
const VERTRAG_KOPF =
  /^[*_]*\s*NEXT[\s_-]*MOVE(?![\p{L}\p{N}])\s*[*_]*\s*(?:[(\[]\s*[*_]*\s*([\p{L}\s/-]*?)\s*[*_]*\s*[)\]])?\s*[*_]*/iu
// case-insensitiv exakt im Stil des SELBST-Checks in naechster-schritt.ts (Zeile 37,
// /^(?:selbst|self)$/i) — hier nur die Anzeige-Kategorie; „selbst“/„keiner“/leer fallen
// durch und ergeben null.
const MENSCH = /^(?:mensch|human)$/i
// dharma hängt jeder Antwort eine Fußzeile „⎯⎯ modell · tier · anbieter ⎯⎯" an.
const FOOTER_LINE = /^\s*⎯⎯ [^\n⎯]* ⎯⎯\s*$/

export type NextMoveSuggestion = {
  /** Der Schritt-Text der (Mensch)-Vertragszeile, inkl. Inline-Code. */
  schritt: string
}

function zeilenKern(z: string): string {
  return z
    .replace(/^[\p{So}\p{Sk}\uFE0F\u200D\s]+/u, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, "")
    .replace(/^[\p{So}\p{Sk}\uFE0F\u200D\s]+/u, "")
}

/**
 * Vertragszeile zerlegen; null = keine Vertragszeile.
 * Trenner zwischen Kopf und Schritt: Doppelpunkt, Gedanken-/Bindestrich mit Leerzeichen
 * danach (R16 (3): „NEXT MOVE (selbst) – Schritt“), oder — nur MIT Kategorie — ein
 * Leerzeichen („NEXT MOVE (selbst) b.md prüfen“). Ohne Trenner und ohne Schritt nur als
 * Überschrift („## NEXT MOVE (selbst)“, Schritt im Absatz darunter).
 */
export function vertragsZeile(z: string): { kategorie: string; schritt: string } | null {
  const kern = zeilenKern(z)
  const m = VERTRAG_KOPF.exec(kern)
  if (!m) return null
  const kategorie = (m[1] ?? "").trim()
  const rest = kern.slice(m[0].length)
  let schritt: string
  if (!rest.trim()) schritt = ""
  else if (/^\s*[:：]/.test(rest)) schritt = rest.replace(/^\s*[:：]/, "")
  else if (/^\s*[–—-]+(?:\s|$)/.test(rest)) schritt = rest.replace(/^\s*[–—-]+/, "")
  else if (m[1] !== undefined && (/\s$/.test(m[0]) || /^\s/.test(rest))) schritt = rest
  else return null
  return { kategorie, schritt: schritt.replace(/^[\s*_]+/, "").replace(/[\s*_]+$/, "") }
}

/** dharma-Fußzeilen zeilengenau entfernen (nur Zeilen, die NUR die Fußzeile tragen). */
export function stripFooter(text: string): string {
  return String(text ?? "")
    .split("\n")
    .filter((z) => !FOOTER_LINE.test(z))
    .join("\n")
}

/**
 * Letzte (Mensch)-Vertragszeile im Text finden; null = kein Vorschlag.
 *
 * Wie extractNextMove (naechster-schritt.ts:639–690): dharma-Fußzeilen abziehen,
 * Code-Zäune und Inline-Code für die ERKENNUNG ausblenden (eine Vertragszeile in
 * Backticks im Fließtext ist ein Beispiel, keine Anweisung), nur der letzte Absatz
 * zählt — bzw. eine Überschrift ohne Schritt in der letzten Zeile des vorletzten
 * Absatzes mit dem Schritt im letzten Absatz. Die LETZTE Vertragszeile gewinnt
 * (Spec E5: ein Vorschlag pro Session). Nur kategorie „mensch“ (case-insensitive)
 * zeigt an; „selbst“ ist auto-resume-Territorium, „keiner“/leer/ohne Vertrag ist
 * kein Vorschlag (Spec E1/E2).
 */
export function parseNextMoveSuggestion(text: string): NextMoveSuggestion | null {
  const trimmed = stripFooter(String(text ?? "")).trim()
  if (!trimmed) return null
  const codes: string[] = []
  const zurueck = (x: string) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "")
  const mitPlatzhalter = trimmed
    // Eine GANZE Zeile in Backticks, die die Vertragszeile ist, ist Form, kein Code
    // (der Vertrag zeigt sie selbst in Backticks).
    .replace(/^(\s*(?:[-*+•]\s+)?)`(\s*[*_]*\s*NEXT[\s_-]*MOVE[^`\n]*)`\s*$/gim, "$1$2")
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, "") // Code-Zäune beider Formen, auch ein abgeschnittener offener
    // Inline-Code wird für die ERKENNUNG ausgeblendet, im Schritt-Text aber
    // wiederhergestellt (R16 (2) in naechster-schritt.ts:649–652).
    .replace(/`[^`\n]*`/g, (m) => `\u0000${codes.push(m) - 1}\u0000`)
    .split("\n").filter((z) => !/^( {4}|\t)/.test(z)).join("\n") // eingerückter Code
  const absaetze = mitPlatzhalter.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const letzter = absaetze[absaetze.length - 1] ?? ""
  const vorletzter = absaetze[absaetze.length - 2] ?? ""

  const zeilen = letzter.split("\n")
  const treffer = zeilen.map((z, i) => ({ i, v: vertragsZeile(z) })).filter((x) => x.v)
  let kategorie: string | null = null
  let schritt = ""
  if (treffer.length) {
    // E5: die LETZTE Vertragszeile im letzten Absatz gewinnt.
    const t = treffer[treffer.length - 1]!
    kategorie = t.v!.kategorie
    schritt = [t.v!.schritt, ...zeilen.slice(t.i + 1)].join("\n").trim()
  } else {
    // Überschrift „## NEXT MOVE (Mensch)“ ohne Schritt als letzte Zeile des
    // vorletzten Absatzes, Schritt im letzten Absatz.
    const kopf = vertragsZeile(vorletzter.split("\n").pop() ?? "")
    if (kopf && !kopf.schritt) {
      kategorie = kopf.kategorie
      schritt = letzter
    }
  }
  if (kategorie === null || !MENSCH.test(kategorie)) return null
  if (!schritt) return null
  return { schritt: zurueck(schritt) }
}
