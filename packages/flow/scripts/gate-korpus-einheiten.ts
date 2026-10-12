/**
 * Vorab-Satz K2c (12.10.2026): VOR dem Einheiten-Fix geschrieben und in
 * einem eigenen Commit festgehalten — danach nicht mehr geändert, damit die
 * Regel nicht gegen die eigenen Sätze überangepasst wird.
 * soll = true: ≥ 2 unabhängige Einheiten mit je eigenem Ergebnis.
 * soll = false: Umfangs-Zahl, Kontextbindung oder nur EINE Einheit.
 */
import type { Fall } from "./gate-korpus"

export const VORAB_AUFTRAEGE: Fall[] = [
  ["Erstelle für jedes der sieben Pakete unter packages/ einen Steckbrief mit Zweck und Abhängigkeiten.", true],
  ["Recherchiere die Datenschutzerklärungen von Hetzner, IONOS und Strato und fasse jede in einer eigenen Tabelle zusammen.", true],
  ["Schreib je Anbieter einen kurzen Bericht über die Ausfälle im September.", true],
  ["Teste alle neun Endpunkte von rille gegen die Live-Instanz und halte die Ergebnisse in einer Tabelle fest.", true],
  ["Ich möchte für jeden unserer Cron-Jobs eine Laufzeitanalyse als Markdown-Datei.", true],
  ["Analysiere pro Sprache (Deutsch, Englisch, Spanisch) die Fehlerquote und schreib einen Vergleichsbericht.", true],
  ["Prüfe parallel die Lizenzen aller Abhängigkeiten von wortwert und memex und liste Auffälligkeiten in einer Tabelle auf.", true],
  ["Write a short review for each of the four open pull requests.", true],
  ["Benchmark Redis, KeyDB and Dragonfly separately and put the numbers in a comparison table.", true],
  ["Bitte untersuche die drei Worker rille, thoth und dharma auf ungenutzte Exporte und erstelle pro Worker eine Liste.", true],
  ["Kannst du über mehrere Quellen hinweg recherchieren, wie sich die Strompreise 2026 entwickelt haben, und mir einen Bericht schreiben?", true],
  ["Generate test cases for every public function in src/utils and save them as separate test files.", true],
  ["Mach mir für Berlin, Hamburg und München je eine Übersicht der Coworking-Preise.", true],
  ["Vergleiche die Antworten von Z.AI, ClinePass und OpenCode Go auf denselben Prompt und dokumentiere die Unterschiede in docs/anbieter-antworten.md.", true],
  ["Draft three alternative intros for the eclipse article and rate each one in a table.", true],
  ["Ich brauche für alle 13 Worker eine Übersicht der Cron-Zeitpläne als Tabelle.", true],
]

export const VORAB_KEIN_AUFTRAG: Fall[] = [
  ["Fass die Diskussion oben in fünf Stichpunkten zusammen.", false],
  ["Schreib mir zu diesem Fehler eine kurze Erklärung in drei Sätzen.", false],
  ["Erstelle eine Tabelle aus den vier Zahlen, die du gerade gemessen hast.", false],
  ["Vergleiche die zwei Lösungen aus deiner letzten Antwort und sag mir, welche besser ist.", false],
  ["Mach aus diesem Absatz eine Liste mit fünf Punkten.", false],
  ["Analysiere den Stacktrace hier und schreib mir kurz, was schiefgeht.", false],
  ["Schreib eine Commit-Nachricht für die drei geänderten Dateien.", false],
  ["Fasse den letzten Fabrik-Bericht in einem Absatz zusammen.", false],
  ["Erstelle mir eine Checkliste mit zehn Punkten für das Onboarding.", false],
  ["Summarize the last three commits in two sentences.", false],
  ["Make a table of the five numbers above.", false],
  ["Review this function and tell me if the three branches are correct.", false],
  ["Gib mir die drei wichtigsten Erkenntnisse aus der Analyse von eben als Liste.", false],
  ["Schreib einen Bericht über den Ausfall von gestern.", false],
  ["Erstelle eine kurze Zusammenfassung der vier Kommentare in diesem Thread.", false],
  ["Vergleiche diese beiden Tabellen und markiere die Unterschiede.", false],
  ["Write a summary of this PR in five bullet points.", false],
  ["Teste die Funktion parseDate mit drei Beispielen und zeig mir das Ergebnis.", false],
  ["Erstelle eine Tabelle mit drei Spalten für Name, Preis und Link.", false],
  ["Analysiere die vier Fehlermeldungen von vorhin und schreib einen kurzen Bericht dazu.", false],
]
