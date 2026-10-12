/**
 * Messkorpus für den Fabrik-Gate (K2, 12.10.2026).
 *
 * Eine Zeile = [Text, soll], soll = true heißt: der PFLICHTWEG SOLL injiziert
 * werden (Auftrag mit Ergebnisobjekt + Fächer-Signale). Herkunft je Block
 * steht dabei — die Abnahme-Sonden R10–R13 sind wörtlich übernommen, damit
 * gate.test.ts sie bei jeder Änderung mitfährt; der eigene Satz kam vor dem
 * Fix dazu und ist NICHT auf die neue Regel hin geschrieben (die Fehltreffer
 * nach dem Fix stehen unten in `BEKANNTE_LUECKEN`, statt still zu verschwinden).
 */

export type Fall = [text: string, soll: boolean]

// R14 (abnahme14/k2/k2.ts), wörtlich (Klassen r und c zusammen).
export const R14: Fall[] = [
  ["Recherchiere die Preismodelle von Z.AI, ClinePass und OpenCode Go und leg mir eine Vergleichstabelle unter docs/vertraege-vergleich.md ab.", true],
  ["Ich hätte gern für jeden der 13 Worker eine kurze Sicherheitsbewertung als Markdown-Tabelle.", true],
  ["Mach mir drei Varianten für den Landingpage-Hero, jeweils mit Headline und Subline.", true],
  ["Kannst du die fünf größten Konkurrenten von rille recherchieren und mir eine Übersicht mit Preisen machen?", true],
  ["Write a comparison of Vitest, Jest and Bun test for our monorepo, with a recommendation.", true],
  ["Bitte schreib einen Artikel über die Georgia Guidestones mit Recherche zu den Inschriften.", true],
  ["Teste alle zwölf Tools von wortwert gegen die Live-Instanz und dokumentiere die Ergebnisse in einer Tabelle.", true],
  ["Durchsuche die Doku aller 13 Worker nach toten Links und erstelle pro Worker eine Liste.", true],
  ["Lass drei unabhängige Reviewer über den Auth-Umbau schauen und fass ihre Befunde in einem Bericht zusammen.", true],
  ["Erstelle für die Module A, B, C und D je eine Testsuite mit Randfällen.", true],
  ["Analysiere die Logs der letzten sieben Tage für alle Worker und schreib einen Bericht mit den Top-Fehlern.", true],
  ["Ich brauche bis morgen einen Vergleichsartikel zu den drei LLM-Routern, gut recherchiert.", true],
  ["Wie würdest du vorgehen, wenn du drei Anbieter parallel recherchieren und einen Vergleichsbericht schreiben müsstest?", false],
  ["Erklär mir in zwei Sätzen, was ein Audit von einem Review unterscheidet.", false],
  ["Erkläre mir den Unterschied zwischen Review und Audit und fasse ihn in drei Sätzen zusammen.", false],
  ["Prüf bitte kurz, ob die drei Tests in auth.spec.ts grün sind, und fass das Ergebnis zusammen.", false],
  ["Analysiere die drei Fehlermeldungen im Log oben und erkläre die Ursache.", false],
  ["Fass mir kurz zusammen, was die drei letzten Commits geändert haben.", false],
  ["Schreib mir eine kurze Zusammenfassung von diesem Review-Kommentar.", false],
  ["Erstelle eine Tabelle mit den drei Werten aus der Analyse oben.", false],
  ["Formuliere mir eine Beispielaufgabe für die Fabrik, etwa: recherchiere drei Anbieter parallel und erstelle einen Vergleichsbericht.", false],
  ["Wenn ich schreibe: recherchiere A, B und C parallel und erstelle einen Vergleichsbericht – startet dann die Fabrik?", false],
  ["Lohnt sich die Fabrik für einen Vergleich von drei Artikeln?", false],
  ["Lies den Bericht in docs/report.md und sag mir, ob die Analyse stimmt.", false],
  ["Vergleiche die beiden Fehlermeldungen oben und sag, ob es derselbe Bug ist.", false],
  ["Schau dir die Review-Kommentare zu PR #41 an und schreib eine Antwort auf den ersten.", false],
  ["Gib mir eine Liste der drei langsamsten Tests aus dem letzten Lauf, ohne Analyse.", false],
  ["Kurze Zusammenfassung bitte: was hat die Recherche zu den Anbietern ergeben?", false],
  ["Hypothetisch: recherchiere A, B und C parallel und schreib einen Vergleichsartikel – wie viele Worker bräuchte die Fabrik dafür?", false],
  ["Nicht ausführen, nur bewerten: recherchiere drei Anbieter parallel und schreib einen Vergleichsartikel.", false],
]

// R13 (abnahme13/k2/k2.ts), wörtlich.
export const R13: Fall[] = [
  ["Mich würde interessieren, wie die Fabrik parallele Recherchen zusammenführt und vergleicht.", false],
  ["Kurze Frage zur Fabrik: was passiert beim Vergleich paralleler Recherchen", false],
  ["Erklärst du mir, wie der Kritiker die parallelen Recherche-Ergebnisse vergleicht", false],
  ["Gib mir einen Überblick, wie die Fabrik Recherche und Review parallel organisiert.", false],
  ["Hilf mir zu verstehen, wie die Analyse in der Fabrik parallelisiert und verglichen wird.", false],
  ["Was ist der Unterschied zwischen paralleler Recherche und einem seriellen Vergleich in der Fabrik", false],
  ["Weißt du, wie die Fabrik eine Recherche parallel aufteilt und danach vergleicht", false],
  ["I'd like to understand how the factory parallelizes research and comparison.", false],
  ["Erzähl mal, wie so ein paralleler Recherche-Lauf mit Vergleich bei euch abläuft.", false],
  ["Wie genau läuft das Review mehrerer paralleler Artikel ab, kurz erklärt bitte.", false],
  ["ok und wie läuft dann die synthese der parallelen recherche ab", false],
  ["Nur zum Verständnis: die Fabrik recherchiert parallel und vergleicht danach, richtig", false],
  ["Recherchiere parallel Postgres, MySQL und SQLite und vergleiche sie in einem Bericht.", true],
  ["Beschreib mir die Unterschiede von Postgres, MySQL und SQLite – recherchiere parallel, Ergebnis als Tabelle in docs/vergleich.md.", true],
  ["Wie funktioniert die Auth in den 13 Workern? Mach für jeden Worker ein Review und vergleiche die Ergebnisse.", true],
  ["Erkläre für jeden der drei Router-Anbieter in einem eigenen Abschnitt die Fehlerbilder, recherchiere parallel und leg das Ergebnis unter docs/anbieter.md ab.", true],
  ["Was macht jeder unserer 13 Worker? Analysiere parallel und fasse zusammen.", true],
  ["Beschreibe in einem Bericht, wie sich die drei Anbieter unterscheiden; recherchiere parallel.", true],
  ["Vergleiche parallel die drei Varianten und schreib eine Empfehlung.", true],
  ["Kannst du parallel A, B und C recherchieren und vergleichen?", true],
  ["Erkläre, wie die Fabrik arbeitet – und dann recherchiere parallel A, B, C und vergleiche.", true],
]

// R12 (abnahme12/k2k6/k2n.ts), wörtlich.
export const R12: Fall[] = [
  ["Erkläre, wie die Fabrik parallel recherchiert und dann Artikel vergleicht.", false],
  ["Beschreib kurz, wie die Fabrik drei Recherchen parallel fährt und die Artikel vergleicht.", false],
  ["Ich frage mich, wie die Fabrik parallel recherchiert und danach Artikel vergleicht.", false],
  ["Wie würde die Fabrik vorgehen, um A, B und C parallel zu recherchieren und einen Vergleichsartikel zu schreiben? Bitte nur erklären, nicht starten.", false],
  ["warum hat die fabrik vorhin A, B und C parallel recherchiert und dann verglichen", false],
  ["Wie viele Tokens verbraucht ein paralleler Recherche-Vergleich mit Artikel ungefähr", false],
  ["Erklär den Unterschied: Fabrik-Lauf (parallel recherchieren, vergleichen, Artikel) vs. direkt.", false],
  ["Gib mir einen Überblick, wie die Fabrik Recherche, Vergleich und Artikel parallelisiert.", false],
  ["Mich interessiert: läuft bei einem Vergleichsartikel die Recherche zu A, B, C parallel?", false],
  ["Hilf mir zu verstehen, wieso die Fabrik bei Vergleichsartikeln parallel recherchiert.", false],
  ["Was würde passieren, wenn ich schreibe: recherchiere parallel A, B, C und vergleiche sie im Artikel?", false],
  ["Kannst du mir zeigen, wo im Code die Fabrik die parallele Recherche und den Artikelvergleich startet?", false],
  ["Recherchiere bitte parallel A, B und C. Vergleiche sie anschließend in einem Artikel. Geht das?", true],
  ["Recherchiere parallel A, B und C und vergleiche sie in einem Artikel – schaffst du das bis heute Abend?", true],
  ["Kannst du mir parallel A, B, C recherchieren und einen Vergleichsartikel schreiben?", true],
  ["Schreib mir einen Vergleichsartikel zu A, B und C — parallel recherchiert, bitte. Danke!", true],
  ["Bitte erkläre in einem Artikel die Unterschiede von A, B und C; recherchiere sie parallel und vergleiche.", true],
  ["Ich brauche einen Vergleichsartikel zu Hetzner, Contabo und OVH, die Recherche gern parallel.", true],
  ["Erstelle drei Varianten der Landingpage parallel und vergleiche sie, danach Bericht.", true],
  ["Explain how the factory runs research for A, B and C in parallel and compares the articles.", false],
  ["Please research A, B and C in parallel and compare them in an article?", true],
  ["Erkläre mir kurz A, B und C — recherchiere parallel, vergleiche und schreib einen Artikel.", true],
]

// R11 (abnahme11/k2k3k6/k2.ts), wörtlich. Die Präfix-Fälle prüft gate.test.ts eigens.
export const R11: Fall[] = [
  ["Wie funktioniert die Fabrik, wenn ich z. B. drei Artikel parallel recherchieren lasse?", false],
  ["Was kostet ein Fabrik-Lauf etwa, wenn er fünf Worker parallel für einen Vergleich startet?", false],
  ["Welche Worker bzw. Kritiker laufen bei einem Recherche-Vergleich parallel?", false],
  ["Kannst du mir erklären, wie die Fabrik parallel recherchiert und Artikel vergleicht?", false],
  ["Könntest du kurz sagen, ob die Fabrik Recherche und Vergleich parallel macht?", false],
  ["Wie lange dauert es, wenn ich parallel recherchieren und vergleichen lasse? Danke.", false],
  ["Frage: recherchiert die fabrik parallel und vergleicht dann artikel", false],
  ["Wieso hat der letzte Lauf A, B und C parallel recherchiert und dann verglichen, statt nacheinander?", false],
  ["Ich verstehe nicht, warum die Fabrik bei Vergleichs-Artikeln parallel recherchiert. Erklär mal.", false],
  ["How does the factory compare articles when it researches e.g. three topics in parallel?", false],
  ["What's the difference, i.e. why research in parallel and then compare the article drafts?", false],
  ["wie vergleicht di fabrik paralel recherchirte artikel?", false],
  ["Kurze Frage zur Fabrik (parallel Recherche, Vergleich, Artikel): lohnt sich das bei 2 Themen?", false],
  ["Recherchiere parallel die Tarife von Telekom, Vodafone und O2, vergleiche sie und schreib einen Artikel", true],
  ["Kannst du parallel die Preise von A, B und C recherchieren und einen Vergleichsartikel schreiben?", true],
  ["Könntest du bitte drei Varianten des Artikels parallel schreiben und vergleichen?", true],
  ["Bitte recherchiere: 1) Markt A 2) Markt B 3) Markt C — dann Vergleich als Artikel.", true],
  ["Schreib einen Artikel, der z. B. Hetzner, Contabo und OVH vergleicht; recherchiere die Preise parallel.", true],
  ["Research the pricing of AWS, GCP and Azure in parallel, compare them and write a blog article", true],
  ["Can you research A, B and C in parallel and write a comparison article?", true],
  ["recherchier parallel A B C vergleich artikel", true],
  ["Mach eine Recherche zu X, Y, Z parallel, vergleiche die Ergebnisse, Artikel am Ende.", true],
  ["Erstelle eine Testsuite parallel für die Module a, b und c und vergleiche die Abdeckung im Bericht.", true],
  ["Wie geht es dir?", false],
  ["Lies src/index.ts und sag mir, was die Funktion foo macht.", false],
  ["Fixe den Tippfehler in README.md Zeile 3.", false],
  ["Der Nutzer schrieb „Recherchiere parallel A, B und vergleiche sie im Artikel“ — war das ein Fabrik-Fall?", false],
  ["Was macht `of-run.sh auto-orchestrator \"recherchiere parallel A, B, vergleiche, Artikel\"` genau?", false],
  ["Wie funktioniert die Fabrik?\nRecherchiere parallel A, B und C und vergleiche sie im Artikel.", true],
  ["Recherchiere parallel A, B, C, vergleiche sie und schreib einen Artikel — oder ist das zu viel?", true],
  ["Kannst du die Fabrik parallel Recherche-Artikel vergleichen lassen, ohne sie zu starten?", false],
]

// R10 (abnahme10/k2k4k6/k2/k2.ts), wörtlich, ohne die Präfix-Fälle.
export const R10: Fall[] = [
  ["Recherchiere parallel die Preise von A, B und C, vergleiche sie und schreib einen Artikel.", true],
  ["Wie vergleicht die Fabrik parallel recherchierte Artikel in einem Satz?", false],
  ["Wie startet man z. B. drei Recherche-Worker parallel für einen Artikelvergleich?", false],
  ["Was unterscheidet v2.0 vs. v1.18 beim parallelen Recherche-Vergleich?", false],
  ["„Warum recherchiert die Fabrik parallel und vergleicht dann die Artikel?“", false],
  ["Why does the factory research in parallel and compare the article variants?", false],
  ["Recherchiert die Fabrik parallel? Und vergleicht sie danach die Artikel?", false],
  ["Kannst du bitte parallel recherchieren, vergleichen und einen Artikel über X, Y und Z schreiben?", true],
  ["Research in parallel the pricing of A, B, C, compare them and write an article.", true],
  ["Der Nutzer schrieb: \"Recherchiere parallel A, B und vergleiche sie im Artikel.\" Was meinte er damit?", false],
  ["Ich habe eine Frage zur Fabrik. Recherchiert sie parallel und vergleicht Artikel?", false],
  ["Wie viele Worker startet die Fabrik bei einem Recherche-Vergleich mit Artikel, und wie lange dauert es typischerweise, wenn drei Teile parallel laufen und einer davon fehlschlägt, bevor der Kritiker greift und die Synthese zurückkommt, inklusive Retry und Resume aus dem Checkpoint?", false],
]

// Eigener Satz (K2b, 12.10.2026, VOR dem Fix geschrieben): Fragen, Plaudereien,
// Erklärwünsche ohne Ergebnis — deutsch/englisch, mit und ohne „?“, die
// meisten MIT Fächer-Signalwörtern (sonst prüften sie nichts).
export const EIGENE_FRAGEN: Fall[] = [
  ["Wie entscheidet der Router, wann er auf den nächsten Anbieter failovert?", false],
  ["Mich würde interessieren, wie der Kritiker in der Fabrik parallele Recherchen bewertet", false],
  ["Gib mir mal einen Überblick über die Review- und Analyse-Phasen der Fabrik.", false],
  ["Hilf mir zu verstehen, warum ein Benchmark parallel laufen sollte", false],
  ["Kurze Frage: vergleicht die Synthese die Recherche-Ergebnisse oder fasst sie nur zusammen?", false],
  ["Was ist eigentlich der Unterschied zwischen Audit und Review bei euch", false],
  ["Erklär mir bitte die parallele Recherche in der Fabrik", false],
  ["Beschreib mal, wie ein Multi-Review abläuft und wer den Bericht liest", false],
  ["Ich frage mich gerade, ob parallele Analyse wirklich schneller ist als eine serielle Recherche", false],
  ["Nur zum Verständnis: der Orchestrator zerlegt die Recherche und die Hände arbeiten parallel?", false],
  ["Weißt du noch, warum wir den Benchmark-Vergleich damals parallel gefahren haben", false],
  ["Erzähl mal, wie die letzte Analyse mit den parallelen Reviews gelaufen ist", false],
  ["Wie lange braucht ein typischer Recherche-Lauf mit Vergleich ungefähr", false],
  ["Lohnt sich die Fabrik überhaupt für eine Recherche mit nur zwei Quellen und einem kurzen Vergleich?", false],
  ["Was meinst du: ist ein paralleles Review von drei Dateien schon ein Fall für die Fabrik", false],
  ["Ich verstehe den Zusammenhang zwischen Analyse und Synthese im Bericht noch nicht ganz.", false],
  ["Kannst du mir sagen, wie der Benchmark die Varianten vergleicht?", false],
  ["Zeig mir, wo im Code die parallele Recherche gestartet wird", false],
  ["Woran erkennt der Kritiker eine schwache Recherche beim Vergleich?", false],
  ["danke, und wie fasst die synthese die parallelen analysen dann zusammen", false],
  ["Interessant. Und was passiert mit dem Bericht, wenn ein Review parallel fehlschlägt?", false],
  ["Sag mal, warum ist die Analyse in der Fabrik parallel und das Audit seriell", false],
  ["Ist die Testsuite für den Gate eigentlich parallel oder seriell?", false],
  ["Hm, die Recherche vorhin war ziemlich gut, der Vergleich am Ende aber eher dünn.", false],
  ["Erinnerst du dich an den Artikel-Vergleich von letzter Woche? Wie lief die Recherche da?", false],
  ["Erklär den Begriff Fan-out im Zusammenhang mit paralleler Recherche", false],
  ["Wieso hat der Kritiker den Bericht nach dem parallelen Review abgelehnt", false],
  ["Beschreib in zwei Sätzen, was ein Audit von einem Review unterscheidet", false],
  ["Was würde die Fabrik tun, wenn ich ihr einen Recherche-Vergleich mit drei Varianten gebe?", false],
  ["Ich überlege, ob ich die Recherche parallel laufen lasse oder lieber einen Vergleich direkt mache.", false],
  ["How does the factory decide which research tasks run in parallel?", false],
  ["I'd like to understand how the critic compares the parallel reviews", false],
  ["Can you explain the difference between an audit and a review here?", false],
  ["Quick question: does the synthesis compare the research results or just summarize them", false],
  ["What happens to the report if one parallel analysis fails?", false],
  ["Help me understand why the benchmark runs in parallel", false],
  ["Tell me how the multi-review works", false],
  ["I wonder whether parallel research is worth it for a simple comparison.", false],
  ["Just curious, why did the last research run compare only two variants?", false],
  ["Walk me through how the factory parallelizes analysis and review", false],
  ["Explain the research and comparison phases briefly", false],
  ["Is the test suite run in parallel or sequentially?", false],
  ["ok, und warum war die parallele Recherche diesmal langsamer als der Vergleich?", false],
  ["Gib mir einen kurzen Überblick: Recherche, Review, Synthese – wie greifen die ineinander", false],
  ["Kannst du kurz zusammenfassen, wie die Fabrik Recherche und Review parallelisiert?", false],
  ["Mich würde interessieren, wie der Router failovert", false],
]

// Eigener Satz: echte Fabrik-Aufträge (REGEL 4 Ja-Fälle: Research-Fächer,
// Multi-Review, Varianten, Artikel/Analysen, Testsuiten), VOR dem Fix geschrieben.
export const EIGENE_AUFTRAEGE: Fall[] = [
  ["Recherchiere parallel die Preise von Hetzner, Netcup und Contabo und vergleiche sie in einer Tabelle.", true],
  ["Mach für jeden der 13 Worker ein Security-Review und fasse die Befunde in docs/review-2026-10.md zusammen.", true],
  ["Schreib einen Artikel über die Geschichte der Gematrie; recherchiere dafür parallel hebräische, griechische und lateinische Quellen.", true],
  ["Erstelle drei Varianten der Startseite und vergleiche sie in einem kurzen Bericht.", true],
  ["Analysiere die Logs der letzten 7 Tage für jeden Anbieter und schreib einen Bericht.", true],
  ["Baue eine Testsuite für die Module parser, router und cache, parallel je Modul.", true],
  ["Vergleiche die vier Router-Anbieter nach Latenz, Preis und Fehlerrate und erstelle eine Empfehlung als Tabelle.", true],
  ["Research AWS, GCP and Azure pricing in parallel and write a comparison report.", true],
  ["Review every file under src/oauth/ and summarize the findings in a table.", true],
  ["Write a blog post comparing Postgres, MySQL and SQLite, with research on each.", true],
  ["Recherchiere für jede der fünf Krankenkassen die Zusatzbeiträge 2027 und stell sie in einer Übersichtstabelle zusammen.", true],
  ["Führe für alle Pakete in packages/ ein Dependency-Audit durch und erstelle einen Bericht.", true],
  ["Prüfe die drei Übersetzungen des Artikels parallel gegeneinander und liste die Abweichungen in einer Tabelle auf.", true],
  ["Teste die Endpunkte /health, /mcp und /authorize aller 13 Worker parallel und schreib die Ergebnisse nach docs/sonde.md.", true],
  ["Fasse die zehn wichtigsten Paper zu Retrieval-Augmented Generation zusammen, je Paper ein Absatz, und vergleiche die Ansätze.", true],
  ["Erstelle eine Regressionssuite für of-gate.ts mit je zehn Fällen pro Klasse.", true],
  ["Schreib drei Varianten des Newsletter-Intros und bewerte sie in einer Tabelle.", true],
  ["Analysiere die 20 langsamsten Requests aus dem AE-Dataset und vergleiche sie mit letzter Woche; Ergebnis als Markdown-Tabelle.", true],
  ["Recherchiere den aktuellen Stand zu WebCodecs in Safari, Firefox und Chrome und schreib einen Bericht mit Quellen.", true],
  ["Mach ein Code-Review von PR 2571, 2570 und 2568, jeweils separat, und fasse die Risiken zusammen.", true],
  ["Please compare the three caching strategies in parallel and document the results in docs/cache.md.", true],
  ["Create a test suite for each worker's /health endpoint.", true],
  ["Write an article on eclipse attention, researching the five largest Wikipedia language editions in parallel.", true],
  ["Erstelle für jedes Kapitel des Manuskripts ein Review und eine Zusammenfassung.", true],
  ["Recherchiere parallel zu Vertragsrecht, Datenschutz und Urheberrecht je eine Übersicht und führe sie in einem Dossier zusammen.", true],
  ["Benchmarke die drei JSON-Parser und erstelle einen Vergleichsbericht.", true],
  ["Kannst du parallel die Changelogs von Bun, Node und Deno durchgehen und mir eine Vergleichstabelle der Breaking Changes erstellen?", true],
  ["Ich brauche einen Bericht, der für alle 13 Worker die Testabdeckung vergleicht.", true],
  ["Review the auth code of wortwert, rille and thoth and write up a summary for each.", true],
  ["Generiere fünf Varianten der Fehlermeldung und analysiere sie auf Verständlichkeit, Ergebnis als Liste.", true],
  ["Prüfe jeden Doku-Verweis in docs/ und erstelle eine Liste der toten Links.", true],
  ["Beschreib in docs/router.md, wie der Failover funktioniert, und recherchiere dafür die drei Anbieter-Dokus parallel.", true],
]

// Holdout: NACH dem ersten Fix-Stand geschrieben und einmal gemessen, bevor
// weiter an der Regel gedreht wurde (34/35; der eine Fehltreffer — „fass …
// in docs/pr-review.md zusammen“: der Punkt im Pfad beendete den Satzteil —
// wurde danach behoben).
export const HOLDOUT_FRAGEN: Fall[] = [
  ["Bevor du loslegst: wie würdest du drei Anbieter parallel recherchieren?", false],
  ["Schreibt die Fabrik am Ende einen Bericht oder nur eine Tabelle?", false],
  ["Ok, verstanden. Und wer reviewt dann die parallelen Artikel?", false],
  ["Ich hab gesehen, dass der Lauf drei Varianten erstellt hat – warum drei?", false],
  ["Erklär kurz, was 'Fan-out' bei 13 Workern bedeutet", false],
  ["Was spricht dagegen, jede Recherche parallel zu machen?", false],
  ["Kannst du mir in einem Satz sagen, wozu der Kritiker da ist?", false],
  ["Zeig mir mal die letzten drei Fabrik-Berichte", false],
  ["Do you think a parallel review of five files is overkill?", false],
  ["Could you tell me which of the three variants won the comparison?", false],
  ["Summarize for me how the critic works", false],
  ["Recap: the factory researched three providers in parallel and compared them, right?", false],
  ["Mal ehrlich, war der Vergleich der drei Recherche-Berichte gestern brauchbar?", false],
  ["Welche Testsuite deckt den Gate ab, und läuft die parallel?", false],
  ["Ich würde gern verstehen, warum du vorhin für jeden Worker ein eigenes Review vorgeschlagen hast.", false],
  ["Vergleichst du eigentlich parallel oder seriell?", false],
  ["Analysieren wir das später, erst mal: wie funktioniert der Kritiker?", false],
  ["Prüfst du die drei Artikel nacheinander oder parallel?", false],
  ["Explain like I'm five: why does the factory compare research in parallel?", false],
  ["Hast du eine Idee, wie man für jeden Worker einen Bericht erzeugen könnte?", false],
]
export const HOLDOUT_AUFTRAEGE: Fall[] = [
  ["Recherchiere für die fünf größten deutschen Stromanbieter die Arbeitspreise und erstelle eine Vergleichstabelle.", true],
  ["Mach mir bitte für jedes der vier Kapitel ein Lektorat-Review mit Verbesserungsvorschlägen.", true],
  ["Write three variants of the onboarding email and compare them in a short report.", true],
  ["Analysiere parallel die Fehlerraten von Z.AI, ClinePass und OpenCode Go und fasse sie in einer Tabelle zusammen.", true],
  ["Erstelle eine Testsuite mit je 20 Fällen für die Module auth, router und cache.", true],
  ["Research the top 5 vector databases in parallel and write a comparison article with benchmarks.", true],
  ["Schreib einen Artikel über Saturn-Zyklen und recherchiere dafür parallel drei Quellen.", true],
  ["Bitte reviewe die PRs 2560 bis 2571 einzeln und fass die Befunde in docs/pr-review.md zusammen.", true],
  ["Kannst du die drei Entwürfe parallel analysieren und mir eine Rangliste mit Begründung erstellen?", true],
  ["Untersuche für jeden Cron-Job die Laufzeiten der letzten Woche und erstelle einen Bericht.", true],
  ["Compare the five largest Wikipedia language editions on eclipse attention and summarize the findings as a table.", true],
  ["Dokumentiere für alle 13 Worker die Endpunkte in docs/endpunkte.md, parallel je Worker.", true],
  ["Generate 4 variants of the landing page headline and evaluate each in a table.", true],
  ["Vergleiche Bun, Node und Deno in einem Benchmark-Bericht, Recherche gerne parallel.", true],
  ["Erstell ein Dossier zu den drei Vertragsmodellen, recherchiere jedes Modell einzeln.", true],
]
// Gemessene Lücken (Aufträge, die NICHT injiziert werden). Bewusst stehen
// gelassen — Asymmetrie: ein übersehener Auftrag kostet nur den Hinweis.
//  - Nur EINE Einheit (K2c): ein Artikel über EIN Thema ist ein Deliverable,
//    aber kein Fan-out über ≥ 2 unabhängige Einheiten. R14 führt ihn als
//    Auftrag; nach der Einheiten-Regel ist er keiner für die Fabrik.
//  - Telegrammstil ohne Komma-Aufzählung: „parallel“ allein ist seit K2c
//    keine Einheitenmenge, „A B C“ ohne Kommas keine Aufzählung.
// (Seit K2c erkannt und daher gestrichen: „Prüfe jeden Doku-Verweis …“.)
export const BEKANNTE_LUECKEN: string[] = [
  "recherchier parallel A B C vergleich artikel",
  "Bitte schreib einen Artikel über die Georgia Guidestones mit Recherche zu den Inschriften.",
]

export const ALLE: { name: string; faelle: Fall[] }[] = [
  { name: "R14", faelle: R14 },
  { name: "R13", faelle: R13 },
  { name: "R12", faelle: R12 },
  { name: "R11", faelle: R11 },
  { name: "R10", faelle: R10 },
  { name: "eigene Fragen", faelle: EIGENE_FRAGEN },
  { name: "eigene Aufträge", faelle: EIGENE_AUFTRAEGE },
  { name: "Holdout Fragen", faelle: HOLDOUT_FRAGEN },
  { name: "Holdout Aufträge", faelle: HOLDOUT_AUFTRAEGE },
]
