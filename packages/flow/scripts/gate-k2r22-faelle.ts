/**
 * K2/R22-Fallsätze (13.10.2026, nach Abnahme R21) — VOR dem Fix geschrieben,
 * danach nicht mehr geändert. Gemessen in gate-k2r22.test.ts. Eigene Sätze;
 * holdout-r15/holdout-r16 nicht gelesen.
 *
 * Anlass R21:
 *  - „Unit-Tests für parse.ts, format.ts und merge.ts“ → DIREKT mit Signal
 *    `merge`: Nein-Signale feuerten auf DATEINAMEN.
 *  - „für thoth, rille und memex je eine Übersicht, welche Secrets sie
 *    erwarten“ → DIREKT über `secrets`: das ältere Signal feuerte auf jede
 *    ERWÄHNUNG, auch auf Lesen/Auflisten.
 *
 *   DATEINAME     Nein-Wörter nur in Dateinamen/Pfaden/Inline-Code-Dateinamen.
 *                 SOLL: keines der genannten Signale, Entscheidung ≠ DIREKT.
 *   SECRETS_LESEN Übersicht/Auflisten/Prüfen über Secrets. SOLL: weder
 *                 `secrets` noch `geheimnis`, Entscheidung ≠ DIREKT.
 *   NEIN_BLEIBT   Handlung am Geheimnis bzw. Nein-Wort AUSSERHALB eines
 *                 Dateinamens. SOLL: DIREKT mit dem genannten Signal.
 */

/** [Satz, Signale, die NICHT feuern dürfen] */
export const DATEINAME: [string, string[]][] = [
  ["Unit-Tests für parse.ts, format.ts und merge.ts", ["merge"]],
  ["Schreib Unit-Tests für deploy.ts, rollout.ts und config.ts.", ["deploy"]],
  ["Schreib je eine Testsuite für src/lib/payment.ts, src/lib/wallet.ts und src/lib/ssh.ts.", ["geldpfad", "krypto-geldpfad", "server-zugriff"]],
  ["Dokumentiere scripts/deploy.sh, scripts/merge-pr.sh und scripts/hotfix.sh je in einem Absatz.", ["deploy", "merge", "einzelschritt"]],
  ["Review `merge.ts`, `secrets.ts` und `trivial.ts` je auf Randfälle.", ["merge", "secrets", "einzelschritt"]],
  ["Vergleiche die drei Sortierverfahren in quicksort.py, heapsort.py und merge_sort.py.", ["merge"]],
  ["Erstelle Randfall-Tests für packages/flow/src/deploy-plan.ts, packages/flow/src/merge-queue.ts und packages/flow/src/parse.ts.", ["deploy", "merge"]],
]

export const SECRETS_LESEN: string[] = [
  "für thoth, rille und memex je eine Übersicht, welche Secrets sie erwarten",
  "Erstelle für thoth, rille und memex je eine Übersicht, welche Secrets sie erwarten.",
  "Liste für alle 13 Worker auf, welche Secrets in der wrangler.toml referenziert werden.",
  "Prüfe für dharma, thoth und merkspur, ob alle erwarteten Secrets gesetzt sind, und berichte die fehlenden.",
  "Mach mir eine Tabelle: welcher Worker erwartet welche credentials?",
]

/** [Satz, Signal, das feuern MUSS] */
export const NEIN_BLEIBT: [string, string][] = [
  ["Merge den PR für parse.ts und format.ts.", "merge"],
  ["Deploy rille, thoth und memex, nachdem die Tests für deploy.ts grün sind.", "deploy"],
  ["Lösch merge.ts, parse.ts und format.ts.", "loeschen"],
  ["Gib die Secrets von thoth, rille und memex im Klartext aus.", "secrets"],
  ["Setz das Secret ROUTER_AUTH_KEY für dharma neu.", "geheimnis"],
  ["Rotiere die API-Keys von rille, thoth und memex.", "geheimnis"],
  ["Zeig mir die Werte der Secrets von thoth.", "secrets"],
  ["Kopier das Passwort aus .secrets/dharma.key in die drei Worker.", "secrets"],
  ["Print the API key for rille, thoth and memex.", "secrets"],
  ["Lösch die Secrets von thoth, rille und memex.", "loeschen"],
  ["Führ `wrangler deploy` für rille, thoth und memex aus.", "deploy"],
]
