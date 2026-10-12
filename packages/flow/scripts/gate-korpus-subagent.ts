/**
 * Vorab-Satz K2d (12.10.2026, nach Abnahme R15 5/10): VOR dem Fix geschrieben
 * und in einem eigenen Commit festgehalten — danach nicht mehr geändert, damit
 * die Regel nicht gegen die eigenen Sätze überangepasst wird. Fehltreffer nach
 * dem Fix werden in gate.test.ts als bekannte Lücke ausgewiesen, nicht hier
 * umgeschrieben.
 *
 * SUBAGENT_AUFTRAEGE: so, wie ein Modell einen explore-/general-Subagenten
 *   beauftragt — je EINE Datei bzw. EIN Gegenstand, mit Kommas, Pfaden,
 *   Versionsnummern und Partizipien. soll = false (keine Einheitenmenge).
 * FANOUT_NUTZER: echte Fan-out-Aufträge eines Nutzers, ≥ 2 benannte
 *   Gegenstände mit je eigenem Ergebnis. soll = true.
 * PRUEFFRAGEN: Ja/Nein-Prüffragen, deren Gegenstand Dateinamen mit Punkt bzw.
 *   Komma trägt. soll = false.
 */
import type { Fall } from "./gate-korpus"

export const SUBAGENT_AUFTRAEGE: Fall[] = [
  ["Lies packages/flow/scripts/of-gate.ts, prüfe, wo der Wert injizieren gesetzt wird, und berichte die Zeilennummern.", false],
  ["Lies src/credits.ts und prüfe, ob joinphrase als Suffix behandelt wird. Berichte mit Zeilenangabe.", false],
  ["Öffne docs/RUNBOOK.md, finde den Abschnitt zum Deploy, prüfe, ob dort noch wrangler 3 genannt wird, und gib mir das Zitat zurück.", false],
  ["Read src/router.ts, check where the cooldown value is set, and report the line numbers.", false],
  ["Untersuche packages/workers/dharma/src/brain.ts: wo wird reasoning_effort gesetzt, und welcher Wert, low oder medium? Antworte knapp.", false],
  ["Lies TODO.md und zähle alle als erledigt markierten Einträge, gib nur die Zahl zurück.", false],
  ["Prüfe in package.json, ob die Version 0.6.24 lautet, und melde Abweichungen.", false],
  ["Lies tests/unit/klein-fassung.test.ts, prüfe, ob der Fall ohne Quelle abgedeckt ist, und berichte, welche Testnamen ihn abdecken.", false],
  ["Suche in src/zeichensatz.ts nach der Funktion, die CP1252 erkennt, lies sie, und erkläre in zwei Sätzen, wann sie null liefert.", false],
  ["Lies die Datei wrangler.toml, prüfe, ob CF_ACCESS_TEAM_DOMAIN unter [vars] steht, und gib die Zeile zurück.", false],
  ["Analysiere src/opus-lokal.ts: Wo wird die Abtastrate, falls vorhanden, auf 48000 gesetzt? Berichte Datei:Zeile.", false],
  ["Read README.md, find the section about authentication, and summarize it in three sentences.", false],
  ["Lies src/tool-groups.ts und berichte, wie ANGEMELDETE_WERKZEUGE berechnet wird, mit Zitat.", false],
  ["Prüfe in der Datei .github/ci/version-gate.json, ob wortwert gegatet ist, und antworte mit ja oder nein plus Zitat.", false],
  ["Lies CHANGELOG.md, finde den Eintrag für 2.241.0, und gib wieder, was dort zum Interpretenbild steht.", false],
  ["Untersuche die Funktion tonAntwort in src/strom.ts, prüfe, ob bytes=0- mit 206 beantwortet wird, und berichte.", false],
  ["Lies scripts/of-run.sh, prüfe, wo --scorecard ausgewertet wird, und nenne die Zeilen.", false],
  ["Look at src/oauth/token-validator.ts and tell me where audienzPasst is called, with line numbers.", false],
  ["Lies packages/shared/src/monitoring/canary.ts, prüfe, ob ein Fehlschlag mit isError: true als Fehler zählt, und zitiere die Stelle.", false],
  ["Öffne die Datei src/register.ts, zähle die Einträge in LUECKEN, die als teilweise markiert sind, und gib die Zahl zurück.", false],
  ["Lies vitest.config.ts und prüfe, welche Testordner eingeschlossen sind, z. B. tests/unit oder src/**/__tests__.", false],
  ["Read the file src/queue.ts, check whether a version conflict returns 409, and report the relevant snippet.", false],
  ["Lies docs/VERTRAEGE.md, Abschnitt zai-pay, prüfe, ob der Abrechnungszyklus genannt ist, und berichte wörtlich.", false],
  ["Prüfe in src/klein-fassung.ts, wo kleineAntwort null liefert, und liste die Bedingungen mit Zeilennummer auf.", false],
  ["Lies die Datei of-gate.ts, Zeilen 300 bis 360, prüfe, wo die Ob-Klausel abgeschnitten wird, und berichte.", false],
  ["Untersuche src/player.ts, Funktion playerFelder, prüfe, ob der Token gesetzt wird, und gib das Zitat zurück.", false],
  ["Lies die gesamte Datei MESSSTAND.md und fasse den Abschnitt Offenes in fünf Stichpunkten zusammen.", false],
  ["Check package.json in packages/workers/rille, read the version field, and report whether it is 2.241.0.", false],
]

export const FANOUT_NUTZER: Fall[] = [
  ["Recherchiere die Preismodelle von Hetzner, Netcup und Contabo und schreib mir eine Vergleichstabelle.", true],
  ["Prüfe für jeden der 13 Worker die Canary-Ergebnisse der letzten Woche und erstelle je Worker eine Fehlerliste.", true],
  ["Analysiere die Testabdeckung von rille, merkspur und dharma und schreib je Paket einen kurzen Bericht.", true],
  ["Schreib je einen Artikel über die Sonnenfinsternisse 2026, 2027 und 2028.", true],
  ["Erstelle für alle Tools von wortwert eine Übersicht mit Modi und Parametern als Tabelle.", true],
  ["Vergleiche Vitest, Jest und Bun test anhand unseres Monorepos und schreib eine Empfehlung.", true],
  ["Teste alle 20 rille-Werkzeuge gegen wrangler dev und dokumentiere die Ergebnisse in einer Tabelle.", true],
  ["Review the open pull requests in OpenFlow, mcp-workers and claude_ai and write a short report for each repository.", true],
  ["Recherchiere für jede der drei Wallbox-Marken ABL, Heidelberg und go-e Preise und Lieferzeiten und stell sie gegenüber.", true],
  ["Benchmark D1, KV und R2 mit unserem Leseprofil und schreib die Zahlen in docs/benchmark.md.", true],
  ["Erstelle Steckbriefe zu den Georgia Guidestones, dem Bohemian Grove und dem Denver Airport.", true],
  ["Audit the CSP headers of rille, memex and thoth and write a recommendation per worker.", true],
  ["Untersuche die Logs aller Worker auf 5xx-Fehler und fasse sie je Worker in einer Tabelle zusammen.", true],
  ["Bewerte die drei Embedding-Modelle in Workers AI auf unserem Testkorpus und erstelle eine Rangliste.", true],
  ["Durchsuche die Doku aller 13 Worker nach toten Links und erstelle pro Worker eine Liste.", true],
  ["Research how Anthropic, OpenAI and Google bill cached tokens and write a comparison memo.", true],
]

export const PRUEFFRAGEN: Fall[] = [
  ["Prüfe, ob die Tests in auth.spec.ts, oauth.spec.ts und token.spec.ts grün sind.", false],
  ["Prüf, ob die Version in package.json, wrangler.toml und CHANGELOG.md übereinstimmt.", false],
  ["Sieh nach, ob v2.241.0, v2.240.1 und v2.239.0 alle deployt sind.", false],
  ["Check whether config.prod.json, config.dev.json and config.test.json contain the same keys.", false],
  ["Teste, ob die Dateien a.md, b.md und c.md noch verlinkt sind.", false],
  ["Prüfe bitte, ob in src/a.ts, src/b.ts und src/c.ts noch console.log steht.", false],
]
