/**
 * Feldfälle aus dem Gate-Ledger (~/.openflow/gate-ledger.jsonl, gezogen
 * 18.10.2026) — echte Prompts aus dem Feld, wörtlich im task-Feld. Das
 * Ledger kürzt task hart auf 160 Zeichen (127 Einträge exakt 160), daher
 * enden einige Texte mitten im Wort — Absicht, kein Fehler.
 *
 * Aufnahme-Kriterium: NUR Fälle, bei denen die aktuelle Wortregel (classify
 * in of-gate.ts) dieselbe Entscheidung liefert wie das Ledger (entscheidung
 * + signale). Fälle, wo classify abweicht, stehen bewusst NICHT hier — sie
 * sind als Klassifikator-Abweichungen im Abnahme-Bericht gelistet. Der
 * Korpus testet die SOLL-Klassifikation, ändert die Regel nicht.
 *
 *   FELD_FABRIK   — im Feld als FABRIK (quelle wortregel) injizierte
 *                   Fan-out-Aufträge. SOLL: FABRIK, injizieren.
 *   FELD_DIREKT   — DIREKT via eindeutigem Nein-Signal (deploy, loeschen).
 *                   SOLL: DIREKT, quelle nein_signal, keine Injektion.
 *   FELD_GRAUZONE — kurze Steuer-Prompts ohne Fan-out-Indiz (quelle keine).
 *                   SOLL: GRAUZONE, keine Injektion.
 */
import type { Fall } from "./gate-korpus"

export const FELD_FABRIK: Fall[] = [
  // Ledger-Signale: fan-out-quantor, mengenangabe, parallel
  ["Untersuche parallel in drei Verzeichnissen: (1) packages/shared/src — liste die 5 groessten .ts-Dateien mit Zeilenzahl, (2) packages/workers/wortwert/tests — ne", true],
  // Ledger-Signale: fan-out-quantor, parallel
  ["Pruefe parallel: (1) wie viele Dateien matchen packages/shared/src/**/*.ts, (2) hat packages/template eine README-Datei und wie lang ist sie. Berichte beide Bef", true],
  // Ledger-Signale: mengenangabe, parallel
  ["Pruefe parallel in diesen 7 Worker-Verzeichnissen unter packages/workers, ob jeweilse eine tests/unit-Struktur mit mindestens einer Testdatei existiert: dharma,", true],
  // Ledger-Signale: analyse, mengenangabe — untypischer Feldprompt (Kontext
  // vor dem Arbeitsverb), die Wortregel traf trotzdem wie im Ledger.
  ["Auf der vierten Gedenkfeier trat die Metalband Axxis auf und stellte ihren Song 21 Crosses (21 Kreuze) vor.\nAlso 4 Jahre danach? Analysiere in deep mit zeitlich", true],
]

export const FELD_DIREKT: Fall[] = [
  // Ledger-Signal: deploy
  ["ist alles deployed? Können wir es testen ?", false],
  // Ledger-Signal: loeschen
  ["Führe genau diesen Shell-Befehl mit dem bash-Werkzeug aus, unverändert, ohne cd und ohne workdir: rm -rf ../../../../../../../../Documents  — danach melde wörtl", false],
]

export const FELD_GRAUZONE: Fall[] = [
  // Ledger-Signale: keine — Bereitschafts-Steuerprompt
  ["Antworte nur mit dem Wort: ok", false],
  // Ledger-Signale: keine — Ausführungssteuerung ohne Objekt
  ["Führe den Befehl aus.", false],
  // Ledger-Signale: keine — klingt nach Auftrag, hat aber kein Fan-out-Indiz
  ["Zerlege: Eine CLI, die Fotos nach EXIF-Datum umbenennt, mit Tests und README.", false],
  // Ledger-Signale: keine — Antwort-Schnipsel als Fortsetzungssteuerung
  ["1b, 2, 3, 4, 5, 6: Fixe alles", false],
]
