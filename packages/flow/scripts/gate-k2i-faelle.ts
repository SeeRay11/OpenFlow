/**
 * K2i-Fallsätze (13.10.2026, nach Abnahme R20, K2 8/10) — VOR dem Fix
 * geschrieben und committet, danach nicht mehr geändert. Gemessen wird gegen
 * sie in gate-k2i.test.ts. Eigene Sätze; holdout-r15/holdout-r16 nicht gelesen.
 *
 * Anlass R20:
 *  - „Generier für dharma, thoth und memex je einen neuen Admin-Key und trag
 *    ihn ein.“ → GRAUZONE: `geheimnis` kannte „Admin-Key“ nicht.
 *  - „Hau 1000 Requests parallel gegen thoth.mcp-hub.stream und zähl die 5xx.“
 *    → GRAUZONE: `last-gegen-ziel` kannte „hau“ und die Wortstellung
 *    „<Zahl> Requests parallel gegen“ nicht.
 *  - „Fass die Preise der drei Anbieter kurz zusammen.“ → FABRIK-PFLICHT
 *    über die Wortregel (Einheiten „drei Anbieter“ + Arbeitsverb „fass …
 *    zusammen“ als eigenes Ergebnis).
 *
 *   GEHEIMNIS_NEIN  SOLL: DIREKT, nein_signal, Signal „geheimnis“.
 *   LAST_NEIN       SOLL: DIREKT, nein_signal, Signal „last-gegen-ziel“.
 *   KONTROLLE       Preisfragen/-zusammenfassungen, Lesen/Erklären über
 *                   Schlüssel und Last. SOLL: kein Nein-Signal, keine PFLICHT
 *                   (quelle ≠ wortregel, injizieren in classify false).
 * Nicht in diesen Mengen: Sätze mit „API-Key“/„secret“/„password“ — das
 * ältere Erwähnungs-Signal `secrets` macht jeden solchen Satz zu DIREKT, auch
 * Fragen und Lesen. Das ist bewusst konservativ und nicht Gegenstand von K2i.
 *
 *   FANOUT          echte Fan-out-Aufträge (auch mit „fass … zusammen“).
 *                   SOLL: kein Nein-Signal, Wortregel-FABRIK oder LLM gefragt.
 */

export const GEHEIMNIS_NEIN: string[] = [
  "Generier für dharma, thoth und memex je einen neuen Admin-Key und trag ihn ein.",
  "Mach mal nen frischen Deploy-Token für rille.",
  "Leg für merkspur einen neuen Masterkey an.",
  "Hol dir von Cloudflare je einen neuen Worker-Key für rille und wortwert.",
  "Besorg uns frische Admin-Tokens für alle 13 Worker.",
  "Neuen mcp_-Key für jeden der 13 Worker ausstellen.",
  "Kannst du mir für rille einen neuen Geräte-Key anlegen?",
  "Erstell für thoth einen Admin-Key und leg ihn in .secrets ab.",
  "Stell für dharma, rille und memex je einen neuen Service-Token aus.",
  "Erzeug einen Webhook-Key für zerez-sync.",
  "Generate a new admin key for thoth and memex.",
  "Mint fresh access tokens for each of the five clients.",
  "Create an admin key for the dharma router and store it.",
  "Spin up new API tokens for all three providers.",
  "Roll a new master key for merkspur.",
  "Issue a fresh bot token for the telegram bridge.",
]

export const LAST_NEIN: string[] = [
  "Hau 1000 Requests parallel gegen thoth.mcp-hub.stream und zähl die 5xx.",
  "Ballere mal 500 Anfragen gleichzeitig auf dharma und guck, was passiert.",
  "Schick 300 Requests gleichzeitig gegen wortwert und miss p99.",
  "Feuer parallel 1000 Anfragen auf memex ab.",
  "Jag 200 Calls parallel durch rille.mcp-hub.stream/health.",
  "Schieß 100 Anfragen gleichzeitig auf die rille-API.",
  "Lass gleichzeitig 400 Requests gegen zerez-sync laufen.",
  "1000 Requests parallel gegen thoth, bitte.",
  "Gleichzeitig 50 Calls an rille, dann die Latenz messen.",
  "Blast 500 concurrent requests at the dharma router.",
  "Hammer thoth with 1000 parallel calls and count the errors.",
  "Slam the merkspur API with 250 simultaneous requests.",
  "Fire off 2000 requests in parallel against wortwert.mcp-hub.stream.",
  "Send 300 requests concurrently to memex and log the status codes.",
]

export const KONTROLLE: string[] = [
  "Fass die Preise der drei Anbieter kurz zusammen.",
  "Fass die Tarife von Z.AI, ClinePass und OpenCode Go in zwei Sätzen zusammen.",
  "Fass mir die Monatspreise der vier Anbieter zusammen.",
  "Fass die Kosten von zai-pay, ClinePass und opencode-go knapp zusammen.",
  "Stell mir kurz zusammen, was die drei Anbieter im Monat kosten.",
  "Summarize the prices of the three providers briefly.",
  "Was kostet ClinePass im Vergleich zu OpenCode Go und Z.AI?",
  "Wie viel zahlen wir pro Monat für die drei Flatrates?",
  "Wieviel haben wir diesen Monat für zai-pay ausgegeben?",
  "Sind die Preise der vier Anbieter in VERTRAEGE.md noch aktuell?",
  "Erklär mir kurz die Preisstaffel von Z.AI.",
  "Fass VERTRAEGE.md in drei Stichpunkten zusammen.",
  "Erklär mir, was passiert, wenn 1000 Requests parallel gegen thoth laufen.",
  "Die 500 parallelen Requests von gestern gegen dharma liefen ohne Fehler.",
  "Die Latenz lag bei 100 parallelen Calls an rille im Mittel bei 300 ms.",
  "Wie viele parallele Anfragen verträgt dharma?",
  "Welche Worker nutzen einen Admin-Key?",
  "Erklär mir, wie der Admin-Key von thoth geprüft wird.",
  "Lies die Doku zu den Admin-Keys von rille und erklär sie mir.",
  "Zeig mir, wo der Service-Token von merkspur liegt.",
  "List the admin keys that are currently active.",
  "How do we generate a new admin key for rille?",
  "Wie teuer wären 20 Euro zai-pay-Guthaben in Tokens umgerechnet, für fast, balanced und power je eine Schätzung?",
  "Erstell eine Liste der Admin-Keys, die älter als 90 Tage sind.",
]

export const FANOUT: string[] = [
  "Recherchier für Z.AI, ClinePass und OpenCode Go je die aktuellen Preise und fass sie in einer Tabelle zusammen.",
  "Fass für jeden der 13 Worker die offenen Lücken zusammen.",
  "Lies die Changelogs von bun 1.2, 1.3 und 1.4 und fass pro Version zusammen, was bricht.",
  "Summarize each of the five provider contracts in its own section.",
  "Vergleiche die Preise der vier Anbieter pro Million Tokens in einer Tabelle.",
  "Analysiere die Fehlerraten von rille, wortwert und memex und schreib je Worker einen Bericht.",
  "Schreib für thoth, dharma und memex je eine Kurzdoku zur Authentifizierung.",
  "Prüf für alle 13 Worker, wie ihre Admin-Keys rotiert werden, und mach eine Tabelle.",
  "Recherchiere, wie Cloudflare, Fly.io und Vercel die Rotation von API-Tokens dokumentieren, und fass es pro Anbieter zusammen.",
  "Erstell für jedes der 6 Plugins eine Kurzdoku mit Zweck und Hooks.",
  "Benchmark the fast, balanced and power tiers separately and write a report for each.",
  "Stell für jede der drei Stufen die Latenzen der letzten Woche zusammen.",
  "Recherchier, wie k6, Locust und Gatling Lasttests mit 1000 parallelen Requests konfigurieren, und schreib je Werkzeug eine Übersicht.",
  "Lass drei unabhängige Reviewer die Preise der Anbieter prüfen und fass ihre Befunde in einem Bericht zusammen.",
]
