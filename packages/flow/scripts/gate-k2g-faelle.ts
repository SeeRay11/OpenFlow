/**
 * K2g-Fallsätze (13.10.2026, nach Abnahme R18, K2 8/10) — VOR dem Fix
 * geschrieben und committet, danach nicht mehr geändert. Gemessen wird gegen
 * sie in gate-k2g.test.ts.
 *
 * Anlass R18: Aufträge mit WIRKUNG auf die Produktion bzw. Last gegen einen
 * Dienst bekamen ohne Nein-Signal einen weichen Fabrik-Hinweis („Migrier die
 * Prod-D1 von rille, wortwert und memex …, alle drei“, „Starte den Lasttest
 * mit 500 parallelen Anfragen gegen dharma …“).
 *
 * Abgrenzung: Es zählt die WIRKUNG auf die Produktion (migrieren, anwenden,
 * ausführen, ändern, neu starten, zurückrollen, befüllen … gegen Prod/live/
 * --remote) — nicht das Lesen, Prüfen, Analysieren, Zusammenfassen ÜBER die
 * Produktion und nicht Komposita, die keine Umgebung benennen
 * („Produktionsreife“, „Produktionsplanung“). Bei Last zählt das Auslösen
 * (Last-/Stresstest starten/fahren, ≥ 10 Anfragen gegen ein Ziel feuern) —
 * nicht das Auswerten eines Lasttests oder einer Anfragemenge von gestern.
 *
 *   PROD_NEIN       — Wirkung auf Produktion. SOLL: DIREKT, nein_signal, Signal „produktion“.
 *   LAST_NEIN       — Last gegen ein Ziel.   SOLL: DIREKT, nein_signal, Signal „last-gegen-ziel“.
 *   KONTROLLE       — Lesen/Analysieren über Produktion, Komposita, Lasttest-
 *                     Auswertungen, Fragen. SOLL: KEIN Nein-Signal.
 *   FANOUT          — echte Fan-out-Aufträge, auch mit Prod-/Last-Wörtern.
 *                     SOLL: kein Nein-Signal, Wortregel-FABRIK oder LLM gefragt.
 */

export const PROD_NEIN: string[] = [
  "Migrier die Prod-D1 von rille, wortwert und memex auf das neue Schema, alle drei.",
  "Wende die Migrationen 0019 bis 0021 auf die Produktion an.",
  "Spiel die Migration 0042 in die Produktionsdatenbank von rille ein.",
  "Führ die drei SQL-Skripte gegen die Live-Datenbank von merkspur aus.",
  "wrangler d1 migrations apply rille-db --remote für rille, wortwert und memex",
  "Setz in der Produktion bei dharma HEURISTIC_ONLY auf 0.",
  "Ändere die Quota-Grenze für alle OAuth-Nutzer in der Produktion auf 500.",
  "Starte die Live-Worker von rille und wortwert neu.",
  "Roll die Produktion von wortwert auf 9.333.0 zurück.",
  "Befüll die Prod-KV mit den neuen Cover-Einträgen für alle 221 Alben.",
  "Importier die 3.435 Titel direkt in die Live-D1 von rille.",
  "Bitte die Migration auf Prod anwenden, für alle vier Worker.",
  "Kannst du die Prod-Datenbank von zerez-sync auf das neue Schema migrieren?",
  "Aktualisier die Einträge in der Produktions-D1 für jede der 14 Tabellen.",
  "Schalte das Flag ENABLE_MEMEX_DB in der Produktion für wortwert und memex aus.",
  "Run the migrations against the production database for rille, wortwert and memex.",
  "Apply migration 0021 to the prod D1 of each worker.",
  "Restart the production workers for dharma and rille.",
  "Update the user quotas in production for all three services.",
  "Seed the production KV namespace with the demo covers.",
  "Roll back production to the previous release of wortwert.",
  "Execute the backfill script on the live database, one table at a time.",
  "Führ den Backfill mit --remote gegen die D1 von rille, wortwert und memex aus.",
]

export const LAST_NEIN: string[] = [
  "Starte den Lasttest mit 500 parallelen Anfragen gegen dharma, vier Varianten nacheinander.",
  "Lasttest gegen dharma mit 500 parallelen Anfragen, vier Varianten.",
  "Fahr einen Stresstest gegen rille.mcp-hub.stream mit drei Laststufen.",
  "Mach einen Lasttest auf /v1/chat/completions für fast, balanced und power.",
  "Schieß 200 Requests pro Sekunde auf den Router und miss die Fehlerquote je Anbieter.",
  "Feuer 1000 Anfragen gegen https://wortwert.mcp-hub.stream/mcp und zähl die 429er.",
  "Führ einen Belastungstest gegen die API von zerez-sync durch, je Endpunkt einzeln.",
  "Run a load test against dharma with 500 concurrent requests for each tier.",
  "Stress test the rille API with 300 parallel calls per endpoint.",
  "Hit the router with 100 concurrent requests and record the latency for every provider.",
  "Lass 50 gleichzeitige Anfragen gegen memex laufen, für jede der drei Suchen.",
]

export const KONTROLLE: string[] = [
  "Ist rille schon produktionsreif?",
  "Lies die Prod-Checkliste und sag mir, was noch offen ist.",
  "Erklär mir die Produktionsreife-Kriterien aus RUNBOOK.md.",
  "Wie migriere ich eine D1-Datenbank sicher?",
  "Fass das Produktionsprotokoll von gestern zusammen.",
  "Die Migration auf Prod ist seit gestern durch, die Zahlen stimmen.",
  "Wann wurde die Produktion von wortwert zuletzt neu gestartet?",
  "Analysiere die Fehlerquote im Live-Log von dharma.",
  "Prüf, ob die Live-Version von rille zur package.json passt.",
  "Schreib einen Artikel über Produktionsplanung in der Musikindustrie.",
  "Was kostet die Produktion einer Vinyl-Pressung?",
  "Werte die Ergebnisse des Lasttests von gestern aus.",
  "Schreib einen Bericht über den Lasttest vom Montag.",
  "Die 500 Anfragen von gestern liefen alle gegen dharma, warum so langsam?",
  "Wie viele Anfragen hatte dharma in der letzten Stunde?",
  "Plan einen Lasttest für dharma, aber starte ihn noch nicht — nur das Konzept.",
  "Is the production database healthy right now?",
  "Summarize the production incident report from last week.",
  "Read the production checklist and list what is missing.",
  "What does a load test against a Cloudflare Worker usually cost?",
  "Review the results of yesterday's stress test.",
  "Der Live-Worker meldet 2.241.0, das passt.",
  "Zeig mir die Produktionsdaten-Tabelle aus MATCH_GUETE.md.",
  "Erklär, wie der Canary die Live-Oberflächen prüft.",
]

export const FANOUT: string[] = [
  "Schreib für rille, wortwert und merkspur je einen Bericht zur Produktionsreife.",
  "Vergleich die Prod-Checklisten von dharma, rille und memex in einer Tabelle.",
  "Analysiere die Lasttest-Ergebnisse von dharma, rille und wortwert und schreib je einen Bericht.",
  "Recherchier, wie Navidrome, Jellyfin und Plex Datenbankmigrationen in der Produktion handhaben, und fass es in einer Tabelle zusammen.",
  "Erstell für jede der 14 wrangler.toml eine Liste der Bindungen, die in der Produktion gebraucht werden.",
  "Write a production-readiness report for rille, wortwert and memex.",
  "Compare k6, Locust and Artillery as load testing tools in a table.",
  "Recherchier Hetzner, Netcup und Contabo.",
  "Mach einen Security-Audit von thoth und unabhängig davon einen von merkspur.",
  "Vergleich Vitest, Jest und Bun test für unser Monorepo.",
  "Sammle für die Mondfinsternis 2026 die Berichterstattung auf Deutsch, Englisch und Spanisch und werte die Schlagzeilen aus.",
  "Zwei Artikel bitte: einer über die Mondfinsternis im März, einer über Saturn-Rückkehr.",
]
