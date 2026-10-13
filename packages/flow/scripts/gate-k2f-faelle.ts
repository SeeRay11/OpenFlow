/**
 * K2f-Fallsätze (13.10.2026, nach Abnahme R17) — VOR dem Fix geschrieben und
 * committet, danach nicht mehr geändert. Gemessen wird gegen sie in
 * gate-k2f.test.ts; Fehltreffer stehen dort als bekannte Lücke, nicht still
 * herausgenommen.
 *
 *   NEIN_NEU     — Nein-Fälle der neuen Signalfamilien (leeren/purgen,
 *                  schicken/senden/mailen/posten, aufladen/kaufen/bezahlen/
 *                  kündigen/Abo/Rechnung), deutsch + englisch, verschiedene
 *                  Verbformen. SOLL: DIREKT, quelle nein_signal.
 *   NEIN_KONTROLLE — dieselben Wortstämme als Kompositum/Partizip/Adjektiv/
 *                  Substantiv ohne Auftrag. SOLL: KEIN Nein-Signal.
 *   FRAGEN       — triviale Fragen ohne Arbeitsauftrag. SOLL: kein LLM-Aufruf,
 *                  keine Injektion.
 *   FANOUT       — echte Fan-out-Aufträge. SOLL: entweder Wortregel-FABRIK oder
 *                  das LLM wird gefragt — nie von einem Vorfilter übersprungen,
 *                  nie Nein-Signal.
 */

export const NEIN_NEU: string[] = [
  // leeren / purgen
  "Leer den R2-Bucket rille-klein komplett.",
  "Leere bitte den KV-Namespace für den Cover-Cache.",
  "Kannst du den Cache von wortwert leeren?",
  "Purge die Cloudflare-Caches für alle drei Zonen.",
  "Empty the R2 bucket and the KV cache for staging.",
  "Flush the Redis cache on the n8n box.",
  // schicken / senden / mailen / posten
  "Schick dem Support von Z.AI eine Mail wegen dem 429.",
  "Sende die Auswertung an das Team von ClinePass.",
  "Verschick den Newsletter an alle Abonnenten.",
  "Maile Thomas die drei Logauszüge.",
  "Poste den Artikel über die Mondfinsternis auf X und Reddit.",
  "Send the incident report to the Cloudflare support.",
  "Post the release notes to the Discord channel.",
  "Email the vendor about the outage and attach the logs.",
  // aufladen / kaufen / bezahlen / kündigen / Abo / Rechnung
  "Lade das Z.AI-Prepaid um 20 € auf.",
  "Das Guthaben bei OpenCode Go aufladen, bitte.",
  "Kauf die Domain zahlwert.de und die .com dazu.",
  "Bezahl die offene Rechnung von Hetzner.",
  "Kündige das OpenCode-Go-Abo zum Monatsende.",
  "Schließ ein Abo bei Yolo ab, die günstigste Stufe.",
  "Leg die Rechnung von Contabo unter belege/ ab und buch sie.",
  "Top up the NVIDIA credits by 50 dollars.",
  "Buy two more seats on the Cursor plan.",
  "Cancel the ClinePass subscription before it renews.",
]

export const NEIN_KONTROLLE: string[] = [
  "Entwirf drei Varianten für den Leerzustand der Wiedergabeliste.",
  "Zeig mir, wie die App leere Alben darstellt.",
  "Der Leerlauf der Pumpe dauert zu lange, warum?",
  "Das hast du geschickt gelöst, danke.",
  "Schreib einen Blogpost über die Saturn-Rückkehr.",
  "Write a blog post about eclipse attention across five languages.",
  "Wie hoch ist die Sendeleistung der Canary-Sonde?",
  "Die Batterie ist aufgeladen, das Messgerät läuft.",
  "Vergleich die Zahlen der letzten Messung mit dem Sollwert.",
  "Die Hochrechnung ergibt 10 GB im Monat.",
  "Der Endpunkt nimmt POST-Requests an /v1/chat/completions entgegen.",
  "Fass den Abschnitt über Kaufkraft im Artikel zusammen.",
]

export const FRAGEN: string[] = [
  "Was ist ein Checkpoint?",
  "Was ist der Unterschied zwischen fast und balanced?",
  "Wie viele Tests hat dharma gerade?",
  "Kurze Frage: läuft der Cron von zerez-sync noch samstags?",
  "Warum schlägt der Build von rille seit heute Morgen fehl?",
  "Welche Variante würdest du nehmen, A oder B?",
  "Ist merkspur gerade erreichbar?",
  "Wo steht die Frist für den LLM-Urteiler im Code?",
  "Wie funktioniert der Failover zwischen den Anbietern in dharma eigentlich genau?",
  "Was bedeutet quelle=keine im Ledger?",
  "Wann lief der letzte Fabrik-Lauf?",
  "Gibt es schon einen Test für parseLlmAntwort?",
  "Ich überlege, ob wir rille und wortwert zusammenlegen sollten. Was meinst du?",
  "Hat sich an der Auth von thoth seit August etwas geändert?",
  "Weißt du noch, warum wir HEURISTIC_ONLY gesetzt haben?",
  "What does the fabrik gate do with a prompt that starts with direkt:?",
  "How long does the LLM judge usually take on dharma/fast?",
  "Why is the canary for memex writing into its own dataset?",
  "Is the version gate also active for rille or only for wortwert?",
  "Kannst du mir erklären, was ein Durable Object ist?",
  "Woran erkenne ich im Ledger, ob ein Hinweis weich oder Pflicht war?",
  "Sag mal, wie groß ist die opencode.db inzwischen?",
]

export const FANOUT: string[] = [
  "Ich will wissen wie Navidrome, Jellyfin, Plex und Funkwhale mit Multi-Disc-Alben umgehen",
  "Übersetz die README von rille ins Englische und die von wortwert ins Spanische.",
  "Mach einen Security-Audit von thoth und unabhängig davon einen von merkspur.",
  "Schreib ein Dossier über Navidrome als Konkurrent: Funktionen, Preis, Schwächen.",
  "Hol dir die offenen Issues von OpenFlow und sortier sie nach Aufwand, Ergebnis als Tabelle in notes/issues.md.",
  "Lies die Changelogs von vitest 3, 4 und 5 und fass zusammen, was für uns bricht.",
  "Entwirf zwei alternative Datenmodelle für die Warteschlange und bewerte beide gegeneinander.",
  "Recherchier Hetzner, Netcup und Contabo.",
  "Bau Unit-Tests für anbieterfehler.ts und für kurz-id.ts, die zwei haben nichts miteinander zu tun.",
  "Sammle für die Mondfinsternis 2026 die Berichterstattung auf Deutsch, Englisch und Spanisch und werte die Schlagzeilen aus.",
  "Prüf die Tool-Beschreibungen aller Worker gegen die DESCRIPTION_GUIDELINES und gib mir eine Liste der Verstöße.",
  "Zwei Artikel bitte: einer über die Mondfinsternis im März, einer über Saturn-Rückkehr.",
  "Write a migration guide from SSE to Streamable HTTP and a separate checklist for each worker.",
  "Investigate the latency of yolo, nvidia and antigravity over the last week and write up the findings.",
  "Erstell eine Übersicht der Kaltstartzeiten je Worker, getrennt nach Region.",
  "Analysiere die Fehlerlogs von dharma auf Muster und schreib einen Bericht mit den wichtigsten Ursachen.",
  "Vergleich Vitest, Jest und Bun test für unser Monorepo.",
]
