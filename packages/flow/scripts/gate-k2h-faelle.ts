/**
 * K2h-Fallsätze (13.10.2026, nach Abnahme R19, K2 7/10) — VOR dem Fix
 * geschrieben und committet, danach nicht mehr geändert. Gemessen wird gegen
 * sie in gate-k2h.test.ts.
 *
 * Anlass R19: „Setz das zai-pay-Guthaben auf 50 Dollar und teste dann alle
 * Stufen parallel“ wurde deterministisch FABRIK (Pflicht-Hinweis), weil
 * „50 Dollar“ als Einheitenmenge zählte und `geld-auftrag` „setzen“ nicht
 * kannte. Ohne Nein-Signal auch „Rotier die Schlüssel …“ und
 * „Lasttest: 300 gleichzeitige Anfragen an …“.
 *
 * Abgrenzung: Geld zählt als Auftrag, wenn ein Handlungsverb (setzen,
 * aufladen, buchen, upgraden, erhöhen …) im selben Satz mit einem Betrag/einer
 * Währung oder einem Geldwort (Guthaben, Prepaid, Budget, Tarif, Pro-Paket …)
 * steht — nicht das Fragen, Lesen, Erklären über Preise und Beträge. Schlüssel
 * zählen, wenn sie rotiert/gesetzt/erneuert/widerrufen werden — nicht das
 * Prüfen oder Auflisten. Last zählt mit „Lasttest:“ + Ziel/Zahl und mit
 * ≥ 10 gleichzeitigen/parallelen Anfragen an/gegen ein Ziel — nicht die
 * Anfragen von gestern.
 *
 *   GELD_NEIN       SOLL: DIREKT, nein_signal, Signal „geld-auftrag“.
 *   GEHEIMNIS_NEIN  SOLL: DIREKT, nein_signal, Signal „geheimnis“.
 *   LAST_NEIN       SOLL: DIREKT, nein_signal, Signal „last-gegen-ziel“.
 *   KONTROLLE       Fragen/Lesen/Aussagen mit Zahlen und Beträgen.
 *                   SOLL: kein Nein-Signal, kein Betrag als Einheit.
 *   FANOUT          echte Fan-out-Aufträge mit Zahlen.
 *                   SOLL: kein Nein-Signal, Wortregel-FABRIK oder LLM gefragt.
 */

export const GELD_NEIN: string[] = [
  "Setz das zai-pay-Guthaben auf 50 Dollar und teste dann alle Stufen parallel.",
  "Buche für alle drei Anbieter das Pro-Paket.",
  "Erhöh das Budget für OpenCode Go auf 40 € im Monat.",
  "Stell das Prepaid-Limit bei Z.AI auf 100 USD.",
  "Upgrade ClinePass und OpenCode Go auf den Pro-Plan.",
  "Schließ für dharma einen Vertrag über 20 Euro im Monat bei Z.AI ab.",
  "Setz das Budget auf 200 Dollar.",
  "Gib 25 Dollar für NVIDIA-Credits aus.",
  "Verlänger das Guthaben bei Z.AI um drei Monate.",
  "Bitte das Budget für dharma auf 75 € setzen.",
  "Kannst du das Prepaid-Guthaben von ClinePass auf 10 Dollar erhöhen?",
  "Set the Z.AI budget to $50 and then run all tiers in parallel.",
  "Upgrade the OpenCode Go subscription to the Pro plan for each of the three accounts.",
  "Book the Pro package for all three providers.",
  "Charge 20 EUR to the card for the dharma prepaid account.",
  "Raise the spend limit on the Cloudflare account to 100 dollars.",
]

export const GEHEIMNIS_NEIN: string[] = [
  "Rotier die Schlüssel für dharma, thoth und memex parallel.",
  "Erneuer die Tokens von rille, wortwert und memex.",
  "Setz ROUTER_AUTH_KEY für dharma neu.",
  "Tausch den API-Schlüssel von OpenCode Go aus.",
  "Leg für alle drei Worker einen neuen Geräte-Schlüssel an.",
  "Widerruf die Zugangsdaten für thoth.",
  "Generier für jeden der vier Worker ein neues Zugangstoken.",
  "Rotate the API keys for dharma, rille and thoth in parallel.",
  "Regenerate the access token for each of the five workers.",
  "Revoke the OAuth tokens of all three test clients.",
  "Run wrangler secret put ZAI_PAY_KEY for dharma.",
]

export const LAST_NEIN: string[] = [
  "Lasttest: 300 gleichzeitige Anfragen an rille.mcp-hub.stream und wortwert.mcp-hub.stream, je eine Messreihe.",
  "Lasttest: 1000 Requests gegen dharma, je Stufe einzeln.",
  "200 parallele Anfragen an memex, je Suchmodus eine Messung.",
  "Mit 50 gleichzeitigen Requests gegen thoth die Latenz je Server messen.",
  "500 concurrent requests against the router, one series per tier.",
  "Stresstest: 100 Anfragen pro Sekunde auf /mcp für alle drei Worker.",
  "Bitte 40 simultane Abrufe an zerez-sync, je Endpunkt.",
]

export const KONTROLLE: string[] = [
  "Was kostet 1 GB bei R2?",
  "Wie viel Guthaben hat zai-pay noch, sind es mehr als 50 Dollar?",
  "Das Guthaben bei Z.AI liegt bei 50 Dollar.",
  "Lies VERTRAEGE.md und sag mir, wie viel das Pro-Paket bei ClinePass im Monat kostet.",
  "Prüf, ob das Prepaid-Guthaben über 20 € liegt.",
  "Wie hoch war das Budget im September, 40 oder 50 Euro?",
  "Die 3 BSV-Transaktionen kosteten zusammen 0,60 Dollar.",
  "Was bedeutet 100 sat/kB bei TAAL?",
  "Erklär mir, warum Gateway-cost bei Custom Providern immer 0 Dollar zeigt.",
  "Prüf für alle 13 Worker, ob ROUTER_AUTH_KEY gesetzt ist.",
  "Liste die Schlüssel auf, die älter als 90 Tage sind.",
  "Wie viele Tokens verbraucht ein Aufruf mit 64 max_tokens?",
  "Erklär, wie die Token-Rotation in thoth funktioniert.",
  "Der Schlüssel für thoth wurde am 03.08. rotiert, 2 Tage vor dem Release.",
  "Die 300 gleichzeitigen Anfragen an rille von gestern liegen in lauf1.json.",
  "Wie viele gleichzeitige Anfragen an dharma verträgt der Router, 100 oder 300?",
  "Lasttest: Ergebnisse von gestern liegen in lauf2.json.",
  "Lies die Messreihe mit 500 parallelen Requests von gestern und sag mir den Median.",
  "How much does 1 million tokens cost at $0.15?",
  "Is the zai-pay balance still above 50 dollars?",
  "Show me the budget: is it 40 or 50 euros per month?",
  "Die Tabelle zeigt 12 Dollar für 30 Tage.",
  "Bei 50 Dollar Guthaben reicht das wie lange?",
  "Ich frage mich, ob 20 € im Monat für ClinePass zu viel sind.",
]

export const FANOUT: string[] = [
  "Vergleich die Preise von Z.AI, ClinePass und OpenCode Go pro 1 Mio Tokens in einer Tabelle.",
  "Recherchier für alle 4 Anbieter, was 1 GB Speicher im Monat kostet, und schreib einen Vergleichsbericht.",
  "Schreib für die 3 Abnahmerunden 17, 18 und 19 je eine Zusammenfassung von maximal 5 Zeilen.",
  "Analysiere die Latenz der 5 Anbieter in den letzten 7 Tagen und erstell je Anbieter eine Auswertung.",
  "Upgrade die Abhängigkeiten in allen 5 Paketen und schreib je Paket einen Changelog.",
  "Erstell für jeden der 13 Worker eine Tabelle, welche Schlüssel er erwartet.",
  "Write a cost comparison of 4 LLM providers at 1 million tokens each, one section per provider.",
  "Miss für die 3 Stufen fast, balanced und power je 20 Antwortzeiten und schreib einen Bericht.",
  "Recherchier, wie Paddle, Lemon Squeezy und Chargebee Preise ab 10 Dollar abrechnen, und fass es in einer Tabelle zusammen.",
  "Schreib zwei Varianten der Budget-Warnung: eine ab 40 €, eine ab 50 €.",
  "Erstelle für die 3 Sprachen Deutsch, Englisch und Spanisch je eine Übersetzung der Preisseite mit den Beträgen 9 €, 19 € und 49 €.",
  "Prüf für alle 13 Worker, ob ROUTER_AUTH_KEY gesetzt ist, und mach daraus eine Tabelle.",
]
