/**
 * of-gate — deterministischer Fabrik-Gate für REGEL 4 (Subagenten-Fabrik).
 *
 * Bewertet einen Task-Text gegen die Ja-/Nein-Fälle der Nutzerorder vom
 * 18.09.2026 — ohne LLM, reine Signale. Liefert eine EMPFEHLUNG:
 *
 *   FABRIK    — AUFTRAG ÜBER ≥ 2 UNABHÄNGIGE EINHEITEN MIT ERGEBNIS (K2c):
 *               Befehls-/Erstell-/Bedarfsform + Einheitenmenge („für jeden …“,
 *               „alle 13 Worker“, „A, B und C“) + Ergebnis (Arbeitsverb oder
 *               Bericht/Artikel/Tabelle/Datei), ohne Bindung an Material der
 *               Sitzung („oben“, „dieser“, „den letzten …“). Nur dann
 *               `injizieren: true`. Signalwörter sind seit K2c nur Messung.
 *   DIREKT    — klarer Nein-Fall (Geldpfad, Deploy, Secrets, Rückfragen,
 *               Einzelschritt <1 min, Wirkung auf Produktion, Last gegen
 *               ein Ziel) oder Nutzer-Prefix "direkt:"
 *   GRAUZONE  — alles andere: Fragen, Erklärwünsche, Aufträge ohne
 *               Einheitenmenge/Ergebnis oder an Kontext gebunden. Nur Messung.
 *
 * Default umgedreht (K2, 12.10.2026, Abnahme R13 3/10): Bis dahin hieß
 * „≥ 2 Signalwörter“ FABRIK, und eine Satzanfangs-Liste („erklaerfrage“)
 * sollte Erklärfragen wieder herausnehmen. Die Liste konvergierte nicht
 * (R13: 11 von 12 NEUEN Erklärfragen bekamen den PFLICHTWEG) und schlug in
 * die Gegenrichtung (4 Aufträge mit Ergebnis, die mit „Beschreib …/Wie
 * funktioniert …“ begannen, landeten auf DIREKT). Jetzt ist der Auftrag
 * positiv zu belegen. Begründet mit der Asymmetrie: ein übersehener Auftrag
 * kostet nur den Hinweis, eine falsche Injektion zwingt eine Erklärfrage in
 * die Fabrik. `erklaerfrage` ist ENTFALLEN — sie wäre nach dem Umbau nur noch
 * ein Ledger-Etikett (DIREKT statt GRAUZONE) ohne Wirkung auf die Injektion,
 * hätte aber weiter Aufträge auf DIREKT gezogen.
 *
 * DIE Regel steht hier und nur hier: das opencode-Plugin fabrik-gate.ts
 * injiziert genau dann, wenn `injizieren === true` (fehlt das Feld → nicht).
 *
 * Präfix "fabrik:" erzwingt FABRIK (injizieren). Sicherheits-/Geldpfad-
 * Signale schlagen Fabrik-Signale (ein "deploy" im Text macht jeden
 * Artikel-Laufen-Auftrag zum Nein-Fall).
 *
 * Usage:
 *   echo "<task>" | bun of-gate.ts classify        # Text via stdin
 *   bun of-gate.ts classify --text "<task>"        # Text als Arg
 *   bun of-gate.ts classify --llm [--text "<task>"] # kombiniert: Grauzone → LLM-Urteiler (K2e)
 *   bun of-gate.ts log <entscheidung> "<task>" "<grund>" [--event task|fabrik_run]
 *                                              [--task-ref <gate_id>] [--monitoring]
 *
 * Ausgabe classify: eine JSON-Zeile
 *   {entscheidung, signale, prefix, grund, auftrag: {verb, objekt, einheiten} | null, injizieren,
 *    quelle: praefix|nein_signal|wortregel|llm|keine}; mit --llm zusätzlich llm, llm_ms, llm_fehler
 *   und — wenn ein K2f-Vorfilter den Aufruf gespart hat — llm_uebersprungen: kurz|reine_frage|kein_fanout_indiz.
 * log hängt an ${OPENFLOW_LEDGER:-~/.openflow/gate-ledger.jsonl}.
 *
 * --task-ref (Hebel 2, 10.10.2026): gate_id der Task-Bewertung, auf die sich
 *   ein fabrik_run bezieht (≤ 30 min davor, derselbe Agent/Kontext).
 * --monitoring (Hebel 14, 10.10.2026): fabrik_run war nur eine Monitoring-
 *   Sonde (--scorecard/--loop-check/--nutzung) — Historie bleibt, KPI trennt.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"

const LEDGER = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")

// Ja-Fall-Signale (REGEL 4): Fan-out-artige Arbeit mit Endprodukt. Seit K2b
// auch englisch und in Komposita („Vergleichsbericht“, „Security-Review“) —
// sicher, weil Signale allein nicht mehr injizieren, nur zusammen mit einem
// belegten Auftrag.
const FABRIK_SIGNALS: { re: RegExp; name: string }[] = [
  { re: /recherche|recherchier|\bresearch/i, name: "recherche" },
  { re: /review/i, name: "review" },
  { re: /artikel|blogpost|blog[- ]post|\barticle/i, name: "artikel" },
  { re: /analys|analysier|analyz/i, name: "analyse" },
  { re: /variante|\bvariants?\b|alternativen vergleichen/i, name: "varianten" },
  { re: /vergleich|\bcompar(e|es|ed|ing|ison)\b/i, name: "vergleich" },
  { re: /testsuite|test-suite|test suite|regressionssuite/i, name: "testsuite" },
  { re: /\bbenchmark/i, name: "benchmark" },
  { re: /\baudit/i, name: "audit" },
  { re: /bericht\b|\breport\b/i, name: "bericht" },
  // inkl. trennbarem Imperativ „fass(e) die Befunde … zusammen“ (Holdout K2b)
  { re: /zusammenfass|\bfass(e)?\b(?:[^.!?\n]|\.(?=\S)){0,80}\bzusammen\b|synthese|literaturüberblick|literaturueberblick|summar(y|ies|ize|ise)/i, name: "zusammenfassung" },
  {
    re: /\bfür (jede[nrsm]?|alle)\b|\bje (?!nachdem|mehr|weniger|desto|eher|nach\b)[a-zäöüß]{3,}|\bpro (?!sekunde|minute|stunde|tag|monat|jahr)[a-zäöüß]{3,}|\bjede[nrsm]? [a-zäöüß-]{3,}|\balle[rn]? \d+|\bfor (each|every)\b|\b(each|every) [a-z]{3,}|\bjeweils\b|je datei|per datei/i,
    name: "fan-out-quantor",
  },
  // Fan-out über eine benannte Menge („drei Varianten“, „die 13 Worker“, „five
  // providers“) — Texteinheiten („drei Sätze“) zählen nicht.
  {
    re: /\b(?:drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|zwanzig|[3-9]|[1-9]\d|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s+(?:\p{L}+\s+)?(?!(?:sätze|saetze|zeilen|wörter|woerter|absätze|absaetze|stichpunkte|punkte|minuten|sekunden|stunden|tage|wochen|sentences|lines|words|paragraphs|bullets|minutes|seconds|hours|days|weeks|euros?|dollars?|cents?|credits?|sats?|satoshis?|usd|eur|bsv|chf|gbp)\b)(?:\p{Lu}[\p{L}-]*|[a-z-]{3,}s)\b/u,
    name: "mengenangabe",
  },
  { re: /\bparallel(?!e leitung)/i, name: "parallel" },
  { re: /\bmehrere (unabhängige|getrennte|eigene )/i, name: "mehrere-unabhaengige" },
]

// Nein-Fall-Signale: kontextgebunden, gefährlich, dialogisch, trivial.
const DIREKT_SIGNALS: { re: { test(s: string): boolean }; name: string }[] = [
  { re: /\bdeploy|deployment|rollout\b/i, name: "deploy" },
  { re: /\bgeld|payment|stripe|abrechnung|invoice\b/i, name: "geldpfad" },
  // K2/R22: nur eine HANDLUNG am Geheimnis (setzen, ändern, rotieren, löschen, ausgeben,
  // im Klartext zeigen, kopieren …) — Übersicht/Auflisten/Prüfen ist offen. Details bei `secretsHandlung`.
  { re: { test: secretsHandlung }, name: "secrets" },
  { re: /\bssh|produktionsserver|prod-server\b/i, name: "server-zugriff" },
  { re: /\bmainnet|wallet|transaktion senden\b/i, name: "krypto-geldpfad" },
  { re: /\brückfrage|frage den nutzer|den nutzer fragen|nachfragen beim nutzer\b/i, name: "rueckfrage" },
  { re: /\beinzelschritt|ein schritt|quick fix|hotfix|trivial\b/i, name: "einzelschritt" },
  { re: /\bmerge|squash-merge|pr mergen\b/i, name: "merge" },
  { re: /\bpush(en)? zu (main|master|origin)\b/i, name: "push" },
  { re: /\b(löschen|loeschen|delete|drop)\b.{0,30}\b(produktiv|prod|live|datenbank)\b/i, name: "destruktiv-prod" },
  // K2e (13.10.2026, Abnahme R16): LÖSCHEN ist ein Nein-Fall, auch ohne „prod“ —
  // „Lösche die Branches k2a, k2b und k2c lokal und auf origin und erstelle eine
  // Liste …“ bekam FABRIK. Imperativ/Infinitiv als eigenes Wort („lösche“,
  // „löschen“, „delete“, „rm -rf“, „branch -D“, „push --delete“); Komposita
  // („Löschberichte“) und Partizipien („gelöschten“) zählen nicht.
  {
    re: /(?<![\p{L}-])(?:lösch|loesch)(?:e|en|t|st)?(?![\p{L}])|\b(?:delete|deleting|purge|wipe)\b|\bdrop\s+(?:table|database|index)\b|\brm\s+-[a-z]*r|\bbranch\s+-D\b|--delete\b/iu,
    name: "loeschen",
  },
  // K2f (13.10.2026, Abnahme R17): zerstörerische und nach außen wirkende
  // Aufträge sowie Geld bekamen einen weichen Fabrik-Hinweis („Leer den
  // R2-Bucket …“, „Schick dem Support eine Mail …“, „Prepaid aufladen“,
  // „Abo kündigen“). Wie bei `loeschen`: Imperativ/Infinitiv als eigenes Wort;
  // Komposita („Leerzustand“, „Sendeleistung“, „Kündigungsfrist“) und
  // Partizipien („geleert“, „geschickt“, „aufgeladen“) zählen nicht.
  // Fälle: gate-k2f-faelle.ts (NEIN_NEU / NEIN_KONTROLLE).
  {
    // „leer(e) den …“ (Imperativ mit Begleiter — „leere Alben“ ist ein
    // Adjektiv), „leeren“ ohne folgendes Substantiv („die leeren Alben“ nicht),
    // ent-/ausleeren, purgen/flushen/wipen, „empty the …“, „flush the …“.
    // Ohne i-Flag: \p{Lu} trüge sonst Groß- UND Kleinbuchstaben.
    re: /(?<![\p{L}-])(?:[Ll]eer(?:e|t|st)?\s+(?:den|die|das|dem|alle[ns]?|sämtliche|saemtliche|komplett|vollständig|vollstaendig|bitte|mal|jetzt|beide[ns]?|unsere[nm]?|meine[nm]?)(?![\p{L}])|[Ll]eeren(?![\p{L}])(?!\s+\p{Lu})|(?:[Ee]nt|[Aa]us)leer(?:e|en|t)?(?![\p{L}])|(?:[Pp]urg|[Ff]lush|[Ww]ip)(?:e|en)(?![\p{L}])|(?:[Ee]mpty|EMPTY|[Ff]lush|FLUSH)\s+(?:the|all|our|my|both)(?![\p{L}]))/u,
    name: "leeren",
  },
  {
    // schicken/senden/versenden/verschicken/mailen/posten — nicht „schick
    // mir …“/„send me …“ (das Ergebnis geht an den Nutzer, nicht nach außen),
    // nicht „Mail“/„Post“ als Substantiv, nicht „blog post“, nicht „POST /v1“.
    re: /(?<![\p{L}-])(?:ab|los|ver|zu|weiter|raus|rüber|rueber)?(?:schick|send)(?:e|en|t|st)?(?![\p{L}])(?!\s+(?:mir|uns|me|us)\b)|(?<![\p{L}-])(?:e-?)?mail(?:e|en|t|st)(?![\p{L}])(?!\s+(?:mir|uns)\b)|(?<![\p{L}-])(?<!\b(?:an?|the|this|that|your|my)\s+)(?:e-?mail|mail)\s+(?:it|this|that|them|him|her|the|our|to)\b|(?<![\p{L}-])post(?:e|en|et|est)\s+(?!(?:mir|uns)\b)(?=\p{L})|(?<!\b(?:blog|guest|an?|the|this|that|each|every|one|new|first|last)\s+)\bpost\s+(?:it|this|that|them|the|our|my|on|to)\b/iu,
    name: "senden",
  },
  // K2h (13.10.2026, Abnahme R19): Geld zuerst. Neben den Geldverben (unten,
  // GELD_VERB_EIGEN) zählt jedes Handlungsverb, das mit einem Betrag/einer
  // Währung oder einem Geldwort im selben Auftragssatz steht („Setz das
  // zai-pay-Guthaben auf 50 Dollar“, „Buche … das Pro-Paket“). Details bei
  // `geldAuftrag`.
  { re: { test: geldAuftrag }, name: "geld-auftrag" },
  // K2h: Schlüssel/Secrets/Token rotieren, setzen, erneuern, widerrufen.
  // Lesen/Prüfen/Auflisten über Schlüssel zählt nicht. Details bei `geheimnisAuftrag`.
  { re: { test: geheimnisAuftrag }, name: "geheimnis" },
  // K2g (13.10.2026, Abnahme R18): Wirkung auf die PRODUKTION und LAST gegen
  // ein Ziel bekamen einen weichen Fabrik-Hinweis („Migrier die Prod-D1 …,
  // alle drei“, „Starte den Lasttest mit 500 parallelen Anfragen gegen
  // dharma“). Satzweise geprüft, Fragesätze ohne Bitt-Rahmen zählen nicht.
  // Fälle: gate-k2g-faelle.ts (PROD_NEIN / LAST_NEIN / KONTROLLE / FANOUT).
  { re: { test: produktionsWirkung }, name: "produktion" },
  { re: { test: lastGegenZiel }, name: "last-gegen-ziel" },
]

// --- K2h: geld-auftrag -----------------------------------------------------
// Geldverben, die allein ein Geldauftrag sind (K2f): aufladen (auch trennbar
// „lade … um 20 € auf.“), kaufen, bezahlen/überweisen, kündigen, Abo,
// Rechnung; top up, buy, purchase, pay the …, cancel … subscription/plan,
// unsubscribe. Geprüft über den ganzen Text, wie seit K2f.
const GELD_VERB_EIGEN = /(?<![\p{L}-])(?:auflad(?:e|en|t|st)?|(?:ein|ver|zu)?kauf(?:e|en|t|st)?|bezahl(?:e|en|t|st)?|(?:überweis|ueberweis)(?:e|en|t)?|(?:kündig|kuendig)(?:e|en|t|st|ung)?|abo|abos|abonnements?|abonnier(?:e|en|t)?|rechnung(?:en)?)(?![\p{L}])|(?<![\p{L}-])lad(?:e)?\s+(?:[^.!?\n]|\.(?=\S)){1,80}?\sauf(?=\s*(?:[.!?,;]|$|\s+(?:und|dann|and|then)\b))|\btop[- ]?up\b|\b(?:buy|purchase|recharge)\b|(?<![\p{L}-])pay\s+(?:the|for|an?|our|my|this|that|\d)(?![\p{L}])|\bcancel\s+(?:the|my|our|this)\s+(?:[\w-]+\s+){0,2}?(?:subscription|plan|account|membership|contract)\b|\bunsubscribe\b/iu
// Währung als eigenes Wort (nach einer Zahl) — NIE eine Einheitenmenge.
export const WAEHRUNG =
  "(?:€|\\$|eur|euros?|usd|dollars?|cents?|ct|sats?|satoshis?|bsv|chf|gbp|credits?)"
const WAEHRUNG_WORT = new RegExp(`^${WAEHRUNG}$`, "iu")
// Betrag: „50 Dollar“, „40 €“, „40€“, „$50“, „0,60 USD“, „5000 sat“.
const BETRAG = new RegExp(
  `(?<![\\p{L}\\d])\\d+(?:[.,]\\d+)?\\s*${WAEHRUNG}(?![\\p{L}-])|(?<![\\p{L}\\d])[$€]\\s*\\d`,
  "iu",
)
// Geldwörter: Guthaben, Prepaid, Budget (nicht „Token-Budget“, „--budget“,
// „Budget-Warnung“), Tarif, Abo/Subscription, Vertrag, Ausgabenlimit,
// Bezahl-Stufen („Pro-Paket“, „Max plan“, „nächsthöhere Paket“).
const GELD_WORT = new RegExp(
  [
    "guthaben", "prepaid(?:-[\\p{L}]+)?", "(?<![\\p{L}-])budgets?(?![\\p{L}-])", "tarife?", "(?<![\\p{L}])abo(?:s|nnements?)?(?![\\p{L}])",
    "(?<![\\p{L}])subscriptions?", "(?<![\\p{L}])vertr(?:a|ä|ae)ge?s?(?![\\p{L}])", "(?<![\\p{L}])contracts?(?![\\p{L}])",
    "ausgabenlimit", "spend(?:ing)?\\s+limit", "(?<![\\p{L}])billing", "(?<![\\p{L}])balance(?![\\p{L}])",
    "(?<![\\p{L}])(?:pro|plus|premium|team|business|enterprise|max|ultra)[- ]?(?:paket|package|plan|tarif|abo|tier)(?![\\p{L}])",
    "(?:nächst|naechst)?(?:höher|hoeher|größer|groesser|teurer)e[nms]?\\s+(?:paket|plan|tarif|abo)(?![\\p{L}])",
    "(?<![\\p{L}])(?:next|higher|bigger)\\s+(?:package|plan|tier)(?![\\p{L}])",
  ].join("|"),
  "iu",
)
// Handlungsverben, die NUR mit Betrag/Geldwort ein Geldauftrag sind
// (Imperativ/Infinitiv, kein Partizip, keine Nominalisierung „das Setzen“).
const GELD_VERB_KONTEXT = new RegExp(
  "(?<![\\p{L}-])(?<!(?:das|des|beim|zum|vom)\\s)(?:" +
    [
      "setz", "stell", "buch", "upgrad", "downgrad", "erhöh", "erhoeh", "senk", "reduzier", "änder",
      "aender", "anpass", "verlänger", "verlaenger", "abschließ", "abschliess", "schließ", "schliess",
      "gib", "geb", "wechsel", "aktivier", "bestell", "abonnier", "verbuch", "belast", "zahl",
    ].join("|") +
    ")(?:e|en)?(?![\\p{L}])" +
    "|\\b(?:set|raise|increase|lower|reduce|change|adjust|top|add|charge|book|order|subscribe|upgrade|downgrade|renew|extend|activate|spend|pay|load|fund)\\b",
  "iu",
)

// Hauptsatz vor einem indirekten Fragesatz: „Schreib … einen Bericht, wie man
// das Budget erhöht“ — die Handlung im Nebensatz ist Thema, kein Auftrag.
const NEBENSATZ = /,\s*(?:wie|ob|wann|warum|wieso|weshalb|welche[rsmn]?|was|wofür|wofuer|how|whether|when|why|which|what)\b/iu
function ohneNebensatz(s: string): string {
  const i = s.search(NEBENSATZ)
  return i >= 0 ? s.slice(0, i) : s
}
// „setz … ein“, „stell … dar/zusammen“ sind andere Verben (einsetzen, darstellen).
const ANDERES_TRENNVERB = /(?<![\p{L}-])(?:setz|stell)(?:e)?(?![\p{L}])(?:[^.!?\n]|\.(?=\S))*?\s(?:ein|zusammen|fest|dar|bereit|vor)\s*[.!?]?\s*$/iu

function geldAuftrag(text: string): boolean {
  if (GELD_VERB_EIGEN.test(text)) return true
  return auftragsSaetze(text).some((satz) => {
    const s = ohneNebensatz(satz)
    if (!(BETRAG.test(s) || GELD_WORT.test(s))) return false
    if (!GELD_VERB_KONTEXT.test(s)) return false
    return !ANDERES_TRENNVERB.test(s)
  })
}

// --- K2/R22: secrets (Erwähnung + Handlung) --------------------------------
// Vorher feuerte jede ERWÄHNUNG („eine Übersicht, welche Secrets sie erwarten“).
// Jetzt: Erwähnung UND im selben Auftragssatz (Hauptsatz) eine Handlung am
// Geheimnis — Imperativ/Infinitiv, kein Partizip („gesetzt“), keine
// Nominalisierung — oder ein Klartext-/Wert-Bezug („im Klartext“, „die Werte“).
const SECRETS_ERWAEHNUNG = /\bsecret|passwort|password|api[- ]key|token rotat|credentials\b/i
const SECRETS_VERB = new RegExp(
  "(?<![\\p{L}-])(?<!(?:das|des|beim|zum|vom)\\s)(?:" +
    [
      "setz", "änder", "aender", "rotier", "lösch", "loesch", "entfern", "kopier", "teil", "commit", "push",
      "einfüg", "einfueg", "widerruf", "erneuer", "tausch", "hinterleg", "speicher", "druck", "exportier",
      "veröffentlich", "veroeffentlich", "ausgeb", "verschick", "schick", "send",
    ].join("|") +
    ")(?:e|en)?(?![\\p{L}])" +
    "|(?<![\\p{L}-])gib(?![\\p{L}])(?:[^.!?\\n])*?\\saus(?![\\p{L}])" +
    "|\\b(?:set|change|rotate|delete|remove|revoke|copy|share|send|paste|commit|push|upload|store|print|echo|dump|export|reveal|expose|leak|output)\\b",
  "iu",
)
const SECRETS_KLARTEXT = /klartext|plain[ -]?text|unmaskiert|unmasked|(?<![\p{L}])(?:werte?|values?|inhalt)(?![\p{L}])/iu
function secretsHandlung(text: string): boolean {
  return auftragsSaetze(text).some((satz) => {
    const s = ohneNebensatz(satz)
    if (!SECRETS_ERWAEHNUNG.test(s)) return false
    return SECRETS_VERB.test(s) || SECRETS_KLARTEXT.test(s)
  })
}

// --- K2/R22: Dateinamen, Pfade, Inline-Code-Dateinamen ausblenden ----------
// Nein-Signale feuerten auf DATEINAMEN („Unit-Tests für parse.ts, format.ts und
// merge.ts“ → `merge`). Vor der Nein-Signal-Prüfung (und NUR dort) werden
// solche Tokens durch einen neutralen Platzhalter ersetzt; die Einheiten-
// Erkennung sieht den Originaltext. Inline-Code wird nur ausgeblendet, wenn er
// selbst ein Dateiname/Pfad ist — „`wrangler deploy`“ bleibt sichtbar (ein
// Befehl im Code-Span ist eine Handlung, kein Name).
const DATEI_ENDUNG =
  "(?:[cm]?[jt]sx?|py|sh|bash|zsh|md|mdx|json|jsonc|ya?ml|toml|sql|go|rs|rb|java|kt|swift|cpp|hpp|css|scss|html?|txt|csv|svelte|vue|astro|ipynb|lock)"
const DATEI_TOKEN = new RegExp(
  `(?<![\\p{L}\\d_./~-])(?:\\.{1,2}/|~/)?(?:[\\p{L}\\d_.-]+/)*[\\p{L}\\d_-][\\p{L}\\d_.-]*\\.${DATEI_ENDUNG}(?![\\p{L}\\d_-])`,
  "gu",
)
// Pfad ohne Endung: beginnt mit ./ ../ ~/ oder hat ≥ 2 Trenner („packages/flow/src“) —
// „Deploy/Rollback“ (ein Trenner, Wortalternative) bleibt sichtbar; keine URLs.
const PFAD_TOKEN = /(?<![\p{L}\d_./~:-])(?:(?:\.{1,2}|~)\/[\p{L}\d_.-]+(?:\/[\p{L}\d_.-]+)*|[\p{L}\d_.-]+(?:\/[\p{L}\d_.-]+){2,})\/?(?![\p{L}\d_-])/gu
const PLATZHALTER = "DATEI"
export function ohneDateinamen(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, (m, inhalt: string) => {
      const t = inhalt.trim()
      if (/\s/.test(t)) return m
      const rest = t.replace(DATEI_TOKEN, "").replace(PFAD_TOKEN, "")
      return rest === "" ? PLATZHALTER : m
    })
    .replace(DATEI_TOKEN, PLATZHALTER)
    .replace(PFAD_TOKEN, PLATZHALTER)
}

// --- K2h: geheimnis --------------------------------------------------------
// K2i: Präfixe, mit denen „-key“ ein DATENschlüssel ist, kein Geheimnis.
const DATEN_SCHLUESSEL =
  "primary|foreign|sort|cache|partition|json|map|hash|object|dict|kv|r2|lookup|composite|unique|index|shortcut|hot|tasten|row|cursor|idempotency|dedup|group|join|natural|surrogate|monk|tur|whis|jock|hock|donk"
// Schlüssel als Gegenstand: deutsche Komposita („API-Schlüssel“,
// „Zugangstoken“), englisch als eigenes Wort („API keys“, „access token“),
// Umgebungs-Bezeichner (ROUTER_AUTH_KEY, ZAI_PAY_KEY), `secret put`. Nicht
// „Schlüsselwort“, „Token-Budget“, „max_tokens“.
const GEHEIMNIS_OBJ = new RegExp(
  "(?<![\\p{L}_])[\\p{L}-]*?(?:schlüssel|schluessel|token|passwort|passwörter|passwoerter|zugangsdaten|kennwort)(?:s|n|e)?(?![\\p{L}_-])" +
    // englisch „key“/„token“ nur mit Bestimmung — „JSON keys“, „max tokens“ sind keine Geheimnisse
    "|(?<![\\p{L}_])(?:api|access|auth|secret|ssh|private|signing|deploy|oauth|bearer|refresh|session|router|device|service|admin|master|root|app|client|webhook|encryption|bot|worker|mcp|personal|license|registration|publish|npm|github|account|user|project|install)[- ]?(?:keys?|tokens?)(?![\\p{L}_-])" +
    // K2i: Komposita auf -Key/-key aller Art („Admin-Key“, „Geräte-Key“, „mcp_-Key“,
    // „Masterkey“) — nicht Datenschlüssel („Primary-Key“, „Cache-Key“, „KV-Key“, „Hotkey“).
    `|(?<![\\p{L}\\d_-])(?!(?:${DATEN_SCHLUESSEL})-?keys?(?![\\p{L}]))[\\p{L}\\d_]+-?keys?(?![\\p{L}\\d_-])` +
    "|(?<![\\p{L}_])(?:[\\p{L}]+-)?(?:secrets?|credentials?|passwords?|passphrases?)(?![\\p{L}_-])" +
    "|\\bsecret\\s+put\\b",
  "iu",
)
const GEHEIMNIS_BEZEICHNER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|SECRET|TOKEN|WIF|PASSPHRASE|PASSWORD)\b/
// Wirkverben auf Schlüssel (Imperativ/Infinitiv).
const GEHEIMNIS_VERB = new RegExp(
  "(?<![\\p{L}-])(?<!(?:das|des|beim|zum|vom)\\s)(?:" +
    [
      "rotier", "erneuer", "tausch", "austausch", "setz", "widerruf", "sperr", "generier", "erzeug",
      "hinterleg", "ersetz", "wechsel", "änder", "aender", "zurücksetz", "zuruecksetz", "neu\\s+setz",
      "neu\\s+erzeug", "neu\\s+generier", "ausstell", "anleg", "entzieh", "invalidier",
    ].join("|") +
    ")(?:e|en)?(?![\\p{L}])" +
    "|\\b(?:rotate|regenerate|renew|reset|set|put|replace|revoke|invalidate|reissue|issue|create|generate|change|update|swap|roll|mint|provision)\\b",
  "iu",
)
// Trennbar: „tausch … aus“, „leg … an“, „stell … aus“, „setz … neu“.
const GEHEIMNIS_TRENNBAR: [RegExp, RegExp][] = [
  [/(?<![\p{L}-])tausch(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])aus(?![\p{L}])/iu],
  [/(?<![\p{L}-])leg(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])an(?![\p{L}])/iu],
  [/(?<![\p{L}-])stell(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])(?:aus|neu)(?![\p{L}])/iu],
  [/(?<![\p{L}-])zieh(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])zurück|zurueck(?![\p{L}])/iu],
]

// K2i (Abnahme R20): Beschaffen/Herstellen eines NEUEN Schlüssels mit
// Allerweltsverben („mach nen frischen Deploy-Token“, „hol dir je einen neuen
// Worker-Key“, „erstell einen Admin-Key“, „spin up new API tokens“). Das Verb
// allein ist zu breit („erstell eine Liste der Admin-Keys“) — es zählt nur,
// wenn der Schlüssel unbestimmt oder als NEU benannt das Objekt ist.
const GEHEIMNIS_HERSTELL_VERB =
  /(?<![\p{L}-])(?<!(?:das|des|beim|zum|vom)\s)(?:erstell|mach|bau|hol|besorg|beschaff|gib|zieh|leg)(?:e|en)?(?![\p{L}])|\b(?:make|get|give|grab|cut|spin\s+up|set\s+up|add)\b/iu
const GEHEIMNIS_UNBESTIMMT = new RegExp(
  "(?<![\\p{L}'])(?:ein|eine|einen|nen|'nen|neue[nmrs]?|frische[nmrs]?|weitere[nmrs]?|zusätzliche[nmrs]?|zusaetzliche[nmrs]?|a|an|new|fresh|another|additional)\\s+" +
    "(?:[\\p{L}\\d_-]+\\s+)?[\\p{L}\\d_-]*(?:keys?|tokens?|schlüssel|schluessel|secrets?|passw(?:o|ö|oe)rt(?:er)?|passwords?)(?![\\p{L}\\d_-])",
  "iu",
)

function geheimnisAuftrag(text: string): boolean {
  return auftragsSaetze(text).some((satz) => {
    const s = ohneNebensatz(satz)
    if (!GEHEIMNIS_OBJ.test(s) && !GEHEIMNIS_BEZEICHNER.test(s)) return false
    if (GEHEIMNIS_VERB.test(s)) return true
    if (GEHEIMNIS_HERSTELL_VERB.test(s) && GEHEIMNIS_UNBESTIMMT.test(s)) return true
    return GEHEIMNIS_TRENNBAR.some(([stamm, partikel]) => {
      const m = stamm.exec(s)
      return !!m && partikel.test(s.slice(m.index + m[0].length))
    })
  })
}

// --- K2g: produktion -------------------------------------------------------
// Es zählt die WIRKUNG auf die Produktion: eine Umgebungs-Benennung UND ein
// Wirkverb (Imperativ/Infinitiv) im selben Satz. Lesen, Prüfen, Analysieren,
// Zusammenfassen ÜBER die Produktion zählt nicht (keine Wirkverben), ebenso
// wenig Komposita, die keine Umgebung benennen („Produktionsreife“,
// „Produktionsplanung“, „Prod-Checkliste“, „production-readiness“, „Live-Log“)
// und Partizipien („migriert“, „neu gestartet“).
const UMGEBUNG = "(?:datenbank|db|d1|kv|r2|worker|umgebung|server|system|instanz|bucket|namespace|schema|tabellen?|cluster|daten|bestand)"
const PROD_ZIEL = new RegExp(
  [
    // „Prod“, „auf Prod“, „prod D1“ — eigenständig, nicht „Prod-Checkliste“
    "(?<![\\p{L}-])prod(?![\\p{L}-])",
    // „Prod-D1“, „Prod-KV“, „Produktions-D1“, „Produktionsdatenbank“, „Live-Datenbank“, „Live-Worker“
    `(?<![\\p{L}-])(?:prod-|produktions-?|live-)${UMGEBUNG}(?![\\p{L}-])`,
    // „Produktion“ als Wort (nicht „Produktionsreife“)
    "(?<![\\p{L}-])produktion(?![\\p{L}-])",
    // englisch: „production“ (nicht „production-readiness“), „live database/workers/system“
    "(?<![\\p{L}-])production(?![\\p{L}-])",
    "(?<![\\p{L}-])live\\s+(?:database|db|d1|kv|workers?|system|environment|servers?|instances?)(?![\\p{L}])",
    // Werkzeug-Schalter
    "(?<![\\w-])--remote\\b",
    "(?<![\\w-])--env[= ](?:prod|production)\\b",
  ].join("|"),
  "iu",
)
// Wirkverben, die allein wirken („migriere“, „setz“, „apply“ …).
const PROD_WIRK_EINFACH = new RegExp(
  "(?<![\\p{L}-])(?:" +
    [
      "migrier", "anwend", "einspiel", "ausführ", "ausfuehr", "änder", "aender", "setz", "aktualisier",
      "updat", "importier", "befüll", "befuell", "zurückroll", "zurueckroll", "neustart", "neu\\s+start",
      "abschalt", "ausschalt", "einschalt", "umschalt", "deaktivier", "aktivier", "überschreib",
      "ueberschreib", "ersetz", "backfill", "zurücksetz", "zuruecksetz", "wiederherstell", "hochlad",
      "eintrag", "säe", "säen", "seed", "patch", "truncat",
    ].join("|") +
    ")(?:e|en|n)?(?![\\p{L}])" +
    "|\\b(?:migrate|apply|run|execute|update|modify|change|alter|seed|restore|reset|restart|reboot|insert|import|upload|patch|enable|disable|toggle|backfill|truncate|overwrite|rollback|roll\\s+back|write\\s+to|push\\s+to)\\b",
  "iu",
)
// Trennbare Verben: Stamm (Imperativ) vorne, Partikel als eigenes Wort danach.
const PROD_WIRK_TRENNBAR: [RegExp, RegExp][] = [
  [/(?<![\p{L}-])wend(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])an(?![\p{L}])/iu],
  [/(?<![\p{L}-])spiel(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])ein(?![\p{L}])/iu],
  [/(?<![\p{L}-])(?:führ|fuehr)(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])(?:aus|durch)(?![\p{L}])/iu],
  [/(?<![\p{L}-])roll(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])(?:zurück|zurueck|aus)(?![\p{L}])/iu],
  [/(?<![\p{L}-])start(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])neu(?![\p{L}])/iu],
  [/(?<![\p{L}-])schalt(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])(?:aus|ab|ein|an|um)(?![\p{L}])/iu],
  [/(?<![\p{L}-])(?:stell|setz)(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])(?:zurück|zurueck|her|um)(?![\p{L}])/iu],
  [/(?<![\p{L}-])trag(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])ein(?![\p{L}])/iu],
  [/(?<![\p{L}-])lad(?:e)?(?![\p{L}])/iu, /(?<![\p{L}-])hoch(?![\p{L}])/iu],
]

function auftragsSaetze(text: string): string[] {
  return saetze(ohneZitate(text)).filter((s) => !FRAGE_ANFANG.test(s) || BITT_RAHMEN.test(s))
}

function produktionsWirkung(text: string): boolean {
  return auftragsSaetze(text).some((s) => {
    if (!PROD_ZIEL.test(s)) return false
    if (PROD_WIRK_EINFACH.test(s)) return true
    return PROD_WIRK_TRENNBAR.some(([stamm, partikel]) => {
      const m = stamm.exec(s)
      return !!m && partikel.test(s.slice(m.index + m[0].length))
    })
  })
}

// --- K2g: last-gegen-ziel --------------------------------------------------
// (a) Last-/Stress-/Belastungstest wird AUSGELÖST: Auslöseverb ≤ 3 Wörter vor
//     dem Test („Starte den Lasttest“, „Run a load test“) oder der Test steht
//     als Befehl am Satzanfang („Lasttest gegen dharma …“, „Stress test the
//     API …“). Nicht: „Lasttest-Ergebnisse“, „Bericht über den Lasttest“,
//     „load testing tools“, „Plan einen Lasttest …“.
// (b) ≥ 10 Anfragen/Requests/Calls + Auslöseverb im Satz („Feuer 1000
//     Anfragen gegen …“, „Hit the router with 100 concurrent requests“).
//     Nicht: „Die 500 Anfragen von gestern liefen …“ (kein Auslöseverb).
const LASTTEST = "(?:(?:last|stress|belastungs|performance-?last)-?tests?|(?:load|stress|soak|spike)[- ]?test(?:s|ing)?)(?![\\p{L}-])"
const LAST_AUSLOESER = "(?:start|fahr|mach|führ|fuehr|lass|lauf|run|execute|perform|launch|do|kick\\s+off|fire|trigger)"
const LAST_A_VERB = new RegExp(`(?<![\\p{L}-])${LAST_AUSLOESER}(?:e|en|t)?\\s+(?:[\\p{L}\\d/.:-]+\\s+){0,3}?${LASTTEST}`, "iu")
const LAST_A_ANFANG = new RegExp(`^${LASTTEST}\\s+(?:gegen|auf|against|on|the|our|all|each|every|mit|with)\\b`, "iu")
// K2h: „Lasttest: 300 Anfragen …“, „Stresstest: gegen dharma …“ — Kopfzeile mit
// Doppelpunkt, danach Zahl oder Ziel (nicht „Lasttest: Ergebnisse von gestern“).
const LAST_A_KOPF = new RegExp(`^${LASTTEST}\\s*:\\s*(?:\\d|(?:gegen|auf|an|against|on|at|to|mit|with)\\b)`, "iu")
// K2h: ≥ 10 gleichzeitige/parallele Anfragen AN/GEGEN ein Ziel — auch ohne
// Auslöseverb („200 parallele Anfragen an memex“). Nicht mit Artikel davor
// („die 300 gleichzeitigen Anfragen an rille von gestern“ verweist auf Bestand).
const LAST_C = /(?<![\d.,])(?<!(?:der|die|den|dem|des|diese[nrms]?|jene[nrms]?|the|these|those|this|that|bei|unter|under)\s+)(?:\d{2,}|\d{1,3}(?:[.,]\d{3})+)\s+(?:gleichzeitige[nr]?|parallele[nr]?|simultane[nr]?|concurrent|parallel|simultaneous)\s+(?:[\p{L}-]+\s+)?(?:anfragen|requests?|aufrufe[n]?|abrufe[n]?|calls|zugriffe[n]?|hits|verbindungen|connections)(?![\p{L}])(?:[^.!?\n]){0,40}?(?<![\p{L}-])(?:an|gegen|auf|against|to|at|on)(?![\p{L}])/iu
const LAST_MENGE = /(?<![\d.,])(?:\d{2,}|\d{1,3}(?:[.,]\d{3})+)\s+(?:[\p{L}-]+\s+){0,2}?(?:anfragen|requests?|aufrufe|abrufe|calls|zugriffe|hits|verbindungen|connections|rps)(?![\p{L}])/iu
// K2i (Abnahme R20): auch umgangssprachlich („hau“, „baller“, „knall“,
// „schmeiß“, „pump“, „slam“, „shoot“, „spam“).
const LAST_B_VERB = /(?<![\p{L}-])(?:schieß|schiess|feuer|schick|send|lass|start|fahr|feur|jag|hau|baller|ballr|knall|schmeiß|schmeiss|pump|spam|hit|fire|blast|hammer|slam|shoot|throw|run|send|issue|launch|flood|bombard|bombardier)(?:e|en|t|n)?(?![\p{L}])/iu
// K2i: ≥ 10 Anfragen + Gleichzeitigkeit in BELIEBIGER Stellung („1000
// Requests parallel gegen thoth“, „gleichzeitig 50 Calls an rille“, „in
// parallel against …“) + Ziel (gegen/an/auf/at/against/to/on/durch + Wort)
// ODER Startverb. Mit Ziel ohne Startverb nicht, wenn die Zahl als Bestand
// („die 500 parallelen Requests von gestern“) oder Bedingung („bei 100
// parallelen Calls“) eingeleitet ist. Nebensätze („…, wenn 1000 Requests
// parallel gegen thoth laufen“) zählen nicht.
const LAST_GLEICHZEITIG =
  /(?<![\p{L}])(?:parallel(?:e[nrsm]?)?|gleichzeitig(?:e[nrsm]?)?|simultan(?:e[nrsm]?)?|zeitgleich(?:e[nrsm]?)?|concurrent(?:ly)?|simultaneous(?:ly)?|auf\s+einmal|at\s+once)(?![\p{L}])/iu
const LAST_ZIEL = /(?<![\p{L}-])(?:gegen|an|auf|durch|at|against|to|on|through)\s+[\p{L}\d/]/iu
const LAST_MENGE_BESTAND = /(?<!(?:der|die|den|dem|des|diese[nrms]?|jene[nrms]?|the|these|those|this|that|bei|unter|under|von|vom|aus|of|from)\s+)(?<![\d.,])(?:\d{2,}|\d{1,3}(?:[.,]\d{3})+)\s+(?:[\p{L}-]+\s+){0,2}?(?:anfragen|requests?|aufrufe|abrufe|calls|zugriffe|hits|verbindungen|connections)(?![\p{L}])/iu
const LAST_NEBENSATZ = /,\s*(?:wenn|falls|sobald|dass|weil|als|if|when|once|because|that)\b/iu

function lastFreieStellung(satz: string): boolean {
  const i = satz.search(LAST_NEBENSATZ)
  const s = ohneNebensatz(i >= 0 ? satz.slice(0, i) : satz)
  if (!LAST_MENGE.test(s) || !LAST_GLEICHZEITIG.test(s)) return false
  if (LAST_B_VERB.test(s)) return true
  return LAST_MENGE_BESTAND.test(s) && LAST_ZIEL.test(s)
}

function lastGegenZiel(text: string): boolean {
  return auftragsSaetze(text).some(
    (s) =>
      LAST_A_VERB.test(s) ||
      LAST_A_ANFANG.test(s) ||
      LAST_A_KOPF.test(s) ||
      LAST_C.test(s) ||
      (LAST_MENGE.test(s) && LAST_B_VERB.test(s)) ||
      lastFreieStellung(s),
  )
}

// ---------------------------------------------------------------------------
// Auftrag mit Ergebnisobjekt
// ---------------------------------------------------------------------------

const W = "[\\wäöüÄÖÜß-]" // ein Wortzeichen inkl. Umlaut und Bindestrich

// Erstell-/Befehlsverben (Stamm). Imperativ = Stamm oder Stamm+e; Infinitiv
// (nur in Bitt-Rahmen „kannst du … recherchieren“) = Stamm+en/+n.
const STARK_DE = [
  "recherchier", "schreib", "erstell", "analysier", "vergleich", "prüf", "pruef", "test",
  "dokumentier", "verfass", "bewert", "evaluier", "untersuch", "samml", "sammel", "entwirf",
  "entwerf", "generier", "bau", "mach", "erarbeit", "review", "benchmark", "auditier",
  "skizzier", "entwickl", "ermittl", "fass", "stell", "leg", "list", "führ", "fuehr", "trag",
]
// Verben, die erst MIT Partikel ein Ergebnis bestellen („fasse … zusammen“).
const PARTIKEL: Record<string, RegExp> = {
  fass: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\bzusammen\b/i,
  stell: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\bzusammen\b/i,
  leg: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\bab\b/i,
  list: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\bauf\b/i,
  führ: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\b(durch|zusammen)\b/i,
  fuehr: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\b(durch|zusammen)\b/i,
  trag: /^\s*(?:[^.!?\n]|\.(?=\S)){0,80}?\bzusammen\b/i,
}
// Erstellverben im engen Sinn: bei ihnen ist schon „einen Bericht“/„a report“
// das bestellte Ergebnis. Bei den übrigen (vergleiche, prüfe, compare …) ist
// „ein Review“ eher der GEGENSTAND („compare an audit and a review“) — dort
// zählt das Artefakt nur mit Präposition („in einer Tabelle“, „as a report“).
const KREATION = new Set([
  "schreib", "erstell", "verfass", "generier", "bau", "mach", "entwirf", "entwerf", "erarbeit",
  "skizzier", "entwickl", "stell", "fass", "trag", "write", "create", "draft", "build", "generate",
  "produce", "prepare", "compile",
])
const STARK_EN = [
  "research", "write", "create", "compare", "review", "summarize", "summarise", "analyze",
  "analyse", "test", "document", "draft", "build", "generate", "evaluate", "audit", "benchmark",
  "compile", "collect", "assess", "investigate", "produce", "prepare",
]
// Erklärverben: bestellen ein Ergebnis NUR mit starkem Ergebnisobjekt im
// selben Hauptsatz („Erkläre in einem Bericht, wie …“), sonst sind sie Fragen.
const SCHWACH_DE = ["erklär", "erklaer", "beschreib", "schilder", "zeig", "nenn", "erzähl", "erzaehl"]
const SCHWACH_EN = ["explain", "describe", "outline", "show", "tell", "list"]

// Ergebnis-Artefakte (auch als Kompositum-Endung: Vergleichs|artikel).
const ARTEFAKT_DE =
  "bericht|berichts|artikel|report|dossier|whitepaper|blogpost|tabelle|liste|übersicht|uebersicht|matrix|testsuite|test-suite|regressionssuite|tests|review|reviews|empfehlung|zusammenfassung|memo|gutachten|steckbrief|varianten|entwürfe|entwuerfe|abschnitt|kapitel|dokument|präsentation|praesentation|checkliste|faktenblatt|vergleich|auswertung|analyse|rangliste|datei|dateien"
const ARTEFAKT_EN =
  "report|article|blog ?post|table|list|test ?suite|tests|review|reviews|summary|summaries|comparison|recommendation|memo|document|doc|spreadsheet|matrix|variants|drafts|section|chapter|checklist|brief|write-?up|analysis|ranking|overview|file|files"

// STARK: eindeutig bestelltes Ergebnis.
const OBJ_PFAD =
  /(?:^|[\s(`"'„:])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]*\.(?:md|mdx|json|csv|tsv|html?|txt|ya?ml|pdf|xlsx?)\b|(?:^|[\s(`"'„])[\w-]+\.(?:md|mdx|csv|tsv|pdf|xlsx?)\b|(?:^|\s)(?:in|nach|unter|into|to)\s+(?:docs|notes|reports?)\/\S*/i
const OBJ_ARTEFAKT_DE = new RegExp(
  `\\b(?:ein|eine|einen|einem|einer|als|ins|zu einem|zu einer|in einem|in einer|in eine|in einen)\\s+(?:${W}+\\s+){0,3}?${W}*?(?:${ARTEFAKT_DE})\\b`,
  "i",
)
const OBJ_ARTEFAKT_EN = new RegExp(
  `\\b(?:a|an|as|into a|into an|in a|in an|one)\\s+(?:${W}+\\s+){0,3}?${W}*?(?:${ARTEFAKT_EN})\\b`,
  "i",
)
// Präpositional: „in einer Tabelle“, „als Bericht“, „as a report“ — bestellt
// ein Ergebnis auch bei Erklär- und Prüfverben.
const OBJ_PRAEP_DE = new RegExp(
  `\\b(?:als|ins|zu einem|zu einer|in einem|in einer|in eine|in einen)\\s+(?:${W}+\\s+){0,3}?${W}*?(?:${ARTEFAKT_DE})\\b`,
  "i",
)
const OBJ_PRAEP_EN = new RegExp(
  `\\b(?:as|into|in)\\s+(?:a|an|one)?\\s*(?:${W}+\\s+){0,3}?${W}*?(?:${ARTEFAKT_EN})\\b`,
  "i",
)
const OBJ_UMFANG = /\d+[- ]?(wörter|woerter|words|seiten|pages|zeichen)\b/i
// Ausdrücklich NICHT ausführen.
const VETO =
  /\bnur (erklären|erklaeren|beschreiben|erläutern)\b|\bnicht (starten|ausführen|ausfuehren|laufen lassen)\b|\bohne (sie|es|ihn|das|die fabrik) zu (starten|ausführen)\b|\bjust explain\b|\b(don't|do not) (run|start|execute)\b/i

// Satz ist eine Frage/Überlegung → darin zählt kein Imperativ.
const FRAGE_ANFANG = new RegExp(
  "^(?:" +
    [
      "wie", "was", "warum", "wieso", "weshalb", "weswegen", "wann", "wo", "woran", "worin", "wozu",
      "woher", "wohin", "welche[rsmn]?", "wer", "wen", "wem", "ob", "inwiefern", "lohnt", "ist", "sind",
      "hat", "haben", "läuft", "laeuft", "gibt", "kann man", "muss", "soll", "what'?s?", "why", "how",
      "when", "where", "which", "who", "whom", "whether", "does", "do", "did", "is", "are", "was",
      "were", "has", "have", "should", "would", "i wonder", "ich frage mich", "ich überlege",
      "ich ueberlege", "ich verstehe", "mich würde interessieren", "mich wuerde interessieren",
      "mich interessiert", "weißt du", "weisst du", "erinnerst du", "hilf mir zu verstehen",
      "help me understand", "nur zum verständnis", "nur zum verstaendnis", "kurze frage", "frage",
      "question", "quick question", "just curious", "i'd like to understand", "i want to understand",
      "walk me through", "was meinst du", "der nutzer schrieb", "gib mir", "sag mal",
    ].join("|") +
    ")\\b",
  "i",
)
// Bitt-Rahmen: darin zählen auch Infinitive („kannst du … recherchieren“).
const BITT_RAHMEN =
  /^(?:(?:kannst|könntest|koenntest|würdest|wuerdest|magst|willst)\s+du|(?:can|could|would|will)\s+you|bitte|please)\b/i
// Verbindungswörter, nach denen ein Imperativ stehen darf.
const VERBINDER =
  /(?:^|[,;:–—(]|\b(?:und|dann|danach|anschließend|anschliessend|zuerst|zunächst|zunaechst|bitte|mal|jetzt|also|ok|okay|außerdem|ausserdem|and|then|please|first|now|so|also))$/i
const VERBINDER_WORT =
  /\s*\b(?:und|dann|danach|anschließend|anschliessend|zuerst|zunächst|zunaechst|bitte|mal|jetzt|also|ok|okay|außerdem|ausserdem|and|then|please|first|now|so)$/i

function ohneZitate(t: string): string {
  let s = t.trim()
  // Ganz in Anführungszeichen (opencode run, Abnahme R7/R10) → auspacken.
  const ganz = s.match(/^["„“»]([\s\S]*)["“”«]$/)
  if (ganz) s = ganz[1]
  return s
    .replace(/„[^“”"]*[“”"]/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/»[^«]*«/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/`[^`]*`/g, " ")
}

function saetze(t: string): string[] {
  const geschuetzt = t.replace(/\b(z|d|u|v|o|s)\.\s?([a-z])\./gi, "$1$2").replace(/\b(e\.g|i\.e|bzw|vs|ca|usw|etc|ggf|evtl|inkl|bspw|Nr)\./gi, "$1")
  return geschuetzt
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

type Treffer = { verb: string; stark: boolean; kreation: boolean; satz: string; rest: string }

function findeVerben(satz: string): Treffer[] {
  const out: Treffer[] = []
  const istFrage = FRAGE_ANFANG.test(satz)
  const rahmen = BITT_RAHMEN.test(satz)
  if (istFrage && !rahmen) return out
  const kandidaten: { stamm: string; stark: boolean; en: boolean }[] = [
    ...STARK_DE.map((s) => ({ stamm: s, stark: true, en: false })),
    ...SCHWACH_DE.map((s) => ({ stamm: s, stark: false, en: false })),
    ...STARK_EN.map((s) => ({ stamm: s, stark: true, en: true })),
    ...SCHWACH_EN.map((s) => ({ stamm: s, stark: false, en: true })),
  ]
  for (const k of kandidaten) {
    const endung = k.en ? "" : rahmen ? "(?:e|en|n)?" : "e?"
    const re = new RegExp(`(?<![\\p{L}-])${k.stamm}${endung}(?![\\p{L}])`, "giu")
    for (const m of satz.matchAll(re)) {
      const idx = m.index ?? 0
      const vor = satz.slice(0, idx).trimEnd()
      // „zu recherchieren“/„to write“: Infinitiv mit zu ist kein Auftrag.
      if (/\b(zu|to)$/i.test(vor)) continue
      // „ich vergleiche“, „wir schreiben“: erste Person ist Bericht, kein Befehl.
      if (/\b(ich|wir|i|we|er|sie|es|man|you|they)$/i.test(vor) && !rahmen) continue
      const amAnfang = vor.replace(VERBINDER_WORT, "").replace(VERBINDER_WORT, "").trim() === "" || /[:–—(]$/.test(vor)
      if (!rahmen && !amAnfang && !VERBINDER.test(vor)) continue
      // Mitten im Satz groß geschrieben = Substantiv („…, Vergleich, Artikel“).
      if (!amAnfang && !rahmen && /^\p{Lu}/u.test(m[0])) continue
      // Englisch im Rahmen: nur direkt nach „you (please)“/Verbinder, sonst
      // sind „the research results“ Substantive.
      if (k.en && rahmen && !amAnfang && !VERBINDER.test(vor) && !/\byou(\s+please)?$/i.test(vor)) continue
      const rest = satz.slice(idx + m[0].length)
      const partikel = PARTIKEL[k.stamm]
      if (partikel && !partikel.test(rest)) continue
      out.push({ verb: m[0], stark: k.stark, kreation: KREATION.has(k.stamm), satz, rest })
    }
  }
  return out
}

/** Hauptsatz-Teil hinter dem Verb: bis zur ersten Nebensatz-Einleitung. */
function hauptsatz(rest: string): string {
  const i = rest.search(/,\s*(?:wie|was|warum|wieso|weshalb|ob|wo|welche[rsmn]?|dass|wer|how|what|why|whether|which|that|who)\b|\s(?:how|what|why|whether|which|that)\b/i)
  return i >= 0 ? rest.slice(0, i) : rest
}

// ---------------------------------------------------------------------------
// EINHEITEN (K2c, 12.10.2026, Abnahme R14 4/10)
// ---------------------------------------------------------------------------
// Die Fabrik lohnt sich nur bei ≥ 2 UNABHÄNGIGEN EINHEITEN, die je ein
// eigenes Ergebnis liefern. Bis K2b reichte jede Zahl vor einem Nomen
// („die drei letzten Commits“, „drei Werte aus der Analyse oben“) als
// Fan-out-Menge UND als Ergebnisobjekt. Jetzt drei getrennte Fragen:
//   1. Einheitenmenge: Quantor (für jeden/je/pro/jeweils/einzeln/for each),
//      Menge aus Zahl/alle/mehrere + Gegenstand („über mehrere Quellen“),
//      Aufzählung von ≥ 3 Gegenständen. „parallel“ ALLEIN nennt keine
//      Gegenstände („Recherchiere parallel und erkläre die Unterschiede“ —
//      wovon?) und ist deshalb keine Einheitenmenge; gemessen kostet das
//      im ganzen Korpus nur den Telegrammsatz „recherchier parallel A B C …“. Eine Zahl vor einem UMFANG-Nomen („drei Sätze“,
//      „fünf Stichpunkte“, „vier Werte“, „sieben Tage“) ist KEINE Einheit.
//      Gesucht wird nicht in Ja/Nein-Prüffragen („prüf, ob die drei Tests …“):
//      dort steht der Gegenstand der Frage, nicht die Arbeitseinheit.
//   2. Ergebnis: Arbeitsverb (recherchiere/analysiere/vergleiche/teste/
//      reviewe/fasse zusammen …) oder ein bestelltes Artefakt.
//   3. Kontextbindung („oben“, „dieser“, „den letzten …“, „von eben“,
//      „aus der Analyse“, „this“, „above“) → nie Pflichtweg: der Auftrag
//      arbeitet auf Material dieser Sitzung, die Fabrik sähe es nicht.
// K2d (Abnahme R15 5/10): Punkt 1 verlangt jetzt ein NOMEN als Einheit —
// „alle/jede/je/pro/each <Nominalgruppe>“, „<Zahl> <Nomen>“ oder eine
// Aufzählung von ≥ 3 benannten Gegenständen (Nomen, Bezeichner, Nummern,
// Namen, koordinierte Attribute). Bloße Adverbien („jeweils“, „einzeln“,
// „separat“) und Satzfragmente („x.ts, prüfe, wo“) zählen nicht mehr; die
// Prüffrage reicht bis zum Satzende. Details bei `klasse`/`nominalAb`.
// Beispiel-/Hypothese-Rahmen („etwa: …“, „wenn ich schreibe: …“,
// „Hypothetisch: …“) gelten wie ein Zitat.

const ZAHL =
  "(?:[2-9]|[1-9]\\d{1,2}|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|zwanzig|dreißig|dreissig|fünfzig|fuenfzig|hundert|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|fifty|hundred)"
// Nomen, deren Zahl einen UMFANG angibt, keine Einheitenmenge.
const UMFANG_NOMEN =
  /^(?:sätzen?|saetzen?|satz|zeilen?|wörtern?|woertern?|worte?|absätzen?|absaetzen?|absatz|stichpunkten?|punkten?|spalten?|werten?|zahlen|beispielen?|fällen?|faellen?|minuten?|sekunden?|stunden?|tage?n?|wochen?|monate?n?|jahre?n?|seiten?|zeichen|sentences?|lines?|words?|paragraphs?|bullets?|bullet|points?|columns?|values?|numbers?|examples?|cases?|minutes?|seconds?|hours?|days?|weeks?|months?|years?|pages?|characters?|items?)$/i

// ---------------------------------------------------------------------------
// NOMEN-PRÜFUNG (K2d, 12.10.2026, Abnahme R15 5/10)
// ---------------------------------------------------------------------------
// R15: Subagent-Aufträge wie „Lies src/x.ts, prüfe, wo der Wert … gesetzt
// wird“ wurden zur Einheitenmenge „x.ts, prüfe, wo“, „alle als erledigt
// markierten“ zur Menge „alle …“. Ursache: Aufzählung und Mengenwort zählten
// JEDES Wort als Gegenstand. Jetzt zählt eine Einheit nur, wenn sie eine
// NOMINALGRUPPE ist: (Artikel)* (Zahl)? (Attribut)* NOMEN. Was ein Nomen ist,
// sagt die Wortform, keine Satzliste:
//   - Bezeichner (Pfad, Datei, Version mit Buchstaben, snake/camelCase,
//     Akronym) — sprachunabhängig;
//   - Deutsch: groß geschrieben und nicht am Satzanfang (Substantiv/Name);
//     klein geschriebene Wörter sind dort nie Nomen (Verb, Partizip, Adjektiv);
//   - Englisch: groß geschrieben (nicht am Satzanfang) oder ein klein
//     geschriebenes Inhaltswort, das kein Funktionswort und kein Befehlsverb ist.
// Die Wortlisten unten sind GESCHLOSSENE Wortklassen (Artikel, Präpositionen,
// Konjunktionen, Pronomen, Hilfsverben) bzw. die schon vorhandenen
// Befehlsverben — keine Satz-Flicken.
const FUNKTION_DE = new Set(
  ("der die das den dem des ein eine einen einem einer eines kein keine und oder sowie als wie in im ins an am auf aus bei beim mit nach " +
    "von vom vor zu zum zur über ueber unter für fuer durch gegen ohne um bis seit wo was wer wen wem ob dass welche welcher welches " +
    "welchen welchem nicht noch auch nur schon so sehr dort da es sie er ich wir du ihr man sich mir mich dir dich uns euch ihm ihn " +
    "ihre ihren ihrem ihrer seine seinen seinem seiner unsere unserer unseren unserem meine meiner meinen deine deiner jede jeder jeden " +
    "jedem jedes alle allen aller sämtliche saemtliche mehrere mehreren je pro jeweils einzeln ist sind war wird werden wurde hat haben " +
    "kann soll muss darf gibt dann danach bitte mal").split(" "),
)
const FUNKTION_EN = new Set(
  ("the a an and or nor as of in on at to for with by from into onto about over under than that which what where when who whom how " +
    "whether if is are was were be been being it its they them their our ours your yours my his her we you i me us not no all each " +
    "every some any several multiple both other others per one then also only just so please there here do does did has have had can " +
    "could should would will may might must").split(" "),
)
const VERB_EN = new Set([
  "research", "write", "create", "compare", "review", "summarize", "summarise", "analyze", "analyse", "test", "document", "draft",
  "build", "generate", "evaluate", "audit", "benchmark", "compile", "collect", "assess", "investigate", "produce", "prepare",
  "explain", "describe", "outline", "show", "tell", "list", "read", "check", "find", "report", "look", "give", "return",
  "count", "run", "fix", "see", "search", "note", "make", "put", "save", "use", "verify", "inspect", "scan", "grep", "quote",
])

type Wort = { w: string; anfang: boolean }
type Klasse = "N" | "A" | "D" | "Z" | "X" // Nomen · Attribut · Artikel/Det. · Zahl · Abbruch

function istBezeichner(w: string): boolean {
  // Pfad/Datei/Version mit Buchstabe, snake_case, camelCase, Akronym (≥ 2 Großbuchstaben).
  return /\p{L}/u.test(w) && (/[./_\\]/.test(w) || /\p{Ll}\p{Lu}/u.test(w) || /^\p{Lu}[\p{Lu}\d.-]+$/u.test(w) || /\d/.test(w))
}

function klasse(x: Wort, englisch: boolean): Klasse {
  const w = x.w.replace(/^[„“"'`(\[]+|[“”"'`)\].:]+$/g, "")
  const k = w.toLowerCase()
  if (!w) return "X"
  if (/^\d+$/.test(w) || new RegExp(`^${ZAHL}$`, "iu").test(w)) return "Z"
  if (istBezeichner(w)) return "N"
  // Klein geschrieben mit Bindestrich („go-e“, „zerez-sync“): Produkt-/Paketname, kein Wort der Satzgrammatik.
  if (/^\p{Ll}[\p{L}\d]*-[\p{L}\d-]+$/u.test(w) && !x.anfang) return "N"
  // Einzelbuchstabe als Platzhaltername („Module A, B und C“, „a, b und c“) — außer engl. „a“/„I“.
  if (/^\p{L}$/u.test(w) && !x.anfang && !(englisch && /^[ai]$/i.test(w) && w !== "A")) return "N"
  if (englisch ? FUNKTION_EN.has(k) : FUNKTION_DE.has(k)) {
    return /^(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines|unsere|unserer|unseren|unserem|the|a|an|our|of)$/i.test(k) ? "D" : "X"
  }
  // Kompositum mit großem Schlussglied („rille-Werkzeuge“, „e-Mails“) ist ein Nomen.
  if (/-\p{Lu}[\p{L}]*$/u.test(w)) return "N"
  if (/^\p{Lu}/u.test(w)) {
    if (x.anfang) return "X" // Satzanfang: Imperativ („Lies“, „Prüfe“, „Read“), kein Gegenstand
    return "N"
  }
  if (!englisch) return "A" // klein geschrieben: Verb/Partizip/Adjektiv, nie Nomen
  return VERB_EN.has(k) ? "X" : "N"
}

/**
 * Längste Nominalgruppe ab Wortindex i: (D)* (Z)? (A)* N+ → Endindex des
 * Kopfnomens oder -1. Ein klein geschriebenes Attribut (A) zählt nur hinter
 * Artikel, Zahl oder Mengenwort („die offenen Issues“, „alle offenen Issues“):
 * ohne Begleiter ist ein kleines Wort nach „und“/Komma ein Imperativ
 * („…, und melde Abweichungen“), kein Attribut.
 */
function nominalAb(ks: Klasse[], i: number, maxAttr = 3, begleiter = false): number {
  let j = i
  while (ks[j] === "D") { j++; begleiter = true }
  if (ks[j] === "Z") { j++; begleiter = true }
  let kopf = -1
  let attr = 0
  while (j < ks.length && (ks[j] === "A" || ks[j] === "N")) {
    if (ks[j] === "N") kopf = j
    else if (kopf >= 0 || !begleiter) break // Attribut nach dem Kopf / ohne Begleiter beendet die Gruppe
    else if (++attr > maxAttr) break
    j++
  }
  return kopf
}

/** Ist ks[von..bis) GANZ eine Nominalgruppe? */
function ganzNominal(ks: Klasse[]): boolean {
  return ks.length > 0 && ks.length <= 6 && nominalAb(ks, 0) === ks.length - 1
}

/** Nominalgruppe am ENDE von ks (Kopf = letztes Wort)? */
function nominalAmEnde(ks: Klasse[]): boolean {
  if (ks[ks.length - 1] !== "N") return false
  for (let s = ks.length - 1; s >= Math.max(0, ks.length - 6); s--) if (nominalAb(ks, s) === ks.length - 1) return true
  return false
}

function englischerText(t: string): boolean {
  const de = (t.match(/\b(?:der|die|das|und|ist|nicht|mit|für|fuer|ein|eine|einen|ob|wo|wird|auf|den|dem|zu|im|von)\b/gi) ?? []).length
  const en = (t.match(/\b(?:the|and|is|not|with|for|an|whether|where|to|of|on|each|every|from|which)\b/gi) ?? []).length
  return en > de
}

function woerter(satz: string): Wort[] {
  return [...satz.matchAll(/[^\s,;:!?()]+/g)].map((m, i) => ({ w: m[0], anfang: i === 0 }))
}

const MENGEN_WORT =
  /^(?:jede[nrsm]?|je|pro|per|each|every|alle[rnms]?|sämtliche[rn]?|saemtliche[rn]?|mehrere[rn]?|all|several|multiple)$/i
const AUSNAHME_JE = /^(?:nachdem|mehr|weniger|desto|eher|nach)$/i

/** „alle/jede/je/pro/each/mehrere <Nominalgruppe>“ oder „<Zahl> <Nomen>“. */
function mengeImSatz(satz: string, englisch: boolean): string | null {
  const ws = woerter(satz)
  const ks = ws.map((w) => klasse(w, englisch))
  for (let i = 0; i < ws.length; i++) {
    // Bereich benannter Gegenstände: „die PRs 2560 bis 2571“ (nicht „Zeilen 300 bis 360“).
    if (ks[i] === "N" && ks[i + 1] === "Z" && /^(?:bis|to|-)$/i.test(ws[i + 2]?.w ?? "") && ks[i + 3] === "Z" && !UMFANG_NOMEN.test(ws[i].w))
      return ws.slice(i, i + 4).map((w) => w.w).join(" ").replace(/[.:]+$/, "")
    const roh = ws[i].w.replace(/[.:]+$/, "")
    const mengenwort = MENGEN_WORT.test(roh)
    const zahl = ks[i] === "Z" && !/[.,]\d/.test(ws[i].w) && !/^(?:1[89]|20)\d\d$/.test(roh)
    if (!mengenwort && !zahl) continue
    if (mengenwort && AUSNAHME_JE.test(ws[i + 1]?.w ?? "")) continue
    // Auswahl EINES Elements: „welche der drei Ursachen“, „which of the three“.
    if (zahl && /^(?:der|of|the)$/i.test(ws[i - 1]?.w ?? "") && /^(?:welche[rsmn]?|which|of)$/i.test(ws[i - 2]?.w ?? "")) continue
    // „jedes der sieben Pakete“, „each of the four PRs“
    let s = i + 1
    if (/^(?:der|des|unserer|of)$/i.test(ws[s]?.w ?? "")) s++
    const kopf = nominalAb(ks, s, 2, true) // Mengenwort/Zahl ist selbst Begleiter
    if (kopf < 0) continue
    const gruppe = ws.slice(s, kopf + 1).map((w) => w.w.replace(/[.:]+$/, ""))
    if (gruppe.some((w) => UMFANG_NOMEN.test(w))) continue
    // K2h: Geldbeträge („50 Dollar“, „40 €“, „5000 sat“) sind nie Einheiten.
    if (gruppe.some((w) => WAEHRUNG_WORT.test(w.split("/")[0]))) continue // „sat/kB“
    return ws.slice(i, kopf + 1).map((w) => w.w).join(" ").replace(/[.:]+$/, "")
  }
  return null
}

// Verbstämme aus den Befehlslisten oben: ein kleines Wort mit diesem Stamm ist
// ein Imperativ („prüfe“, „teste“), kein Attribut und kein Name.
function istVerbform(w: string): boolean {
  const k = w.toLowerCase().replace(/[.:]+$/, "")
  return [...STARK_DE, ...SCHWACH_DE].some((s) => k === s || k === s + "e" || k === s + "en")
}
const ADJ_ENDUNG = /(?:e|en|er|es|em)$/i

/**
 * Aufzählung von ≥ 3 Gliedern, die als Gegenstände benannt sind:
 *   nom   „Hetzner, Netcup und Contabo“, „den Georgia Guidestones, dem Bohemian Grove und …“
 *   zahl  „PR 2571, 2570 und 2568“ (Nomen + Nummern; nicht bei Umfang-Nomen)
 *   name  „die Module auth, router und cache“ (klein geschriebene Namen hinter einem Nomen)
 *   attr  „hebräische, griechische und lateinische Quellen“ (koordinierte Attribute, EIN Kopfnomen)
 * Zwei Glieder („Review und Audit“) zählen NICHT: gemessen kippte „Erkläre den
 * Unterschied zwischen Review und Audit …“ damit auf FABRIK — zwei Begriffe
 * sind meist das Paar EINER Frage, keine Menge. „A oder B“ ist eine Alternative.
 */
function aufzaehlungImSatz(satz: string, englisch: boolean): string | null {
  // Glieder an Komma bzw. Konjunktion trennen; Trenner merken.
  const teile = satz.split(/\s*,\s*(?:(?:und|oder|sowie|and|or)\s+)?|\s+(?:und|oder|sowie|and|or|&)\s+/i)
  const trenner = [...satz.matchAll(/\s*,\s*(?:(?:und|oder|sowie|and|or)\s+)?|\s+(?:und|oder|sowie|and|or|&)\s+/gi)].map((m) =>
    /\b(?:oder|or)\b/i.test(m[0]) ? "o" : "k",
  )
  let wortIndex = 0
  const glieder = teile.map((teil) => {
    const ws = woerter(teil).map((w, j) => ({ w: w.w, anfang: wortIndex === 0 && j === 0 }))
    wortIndex += ws.length
    return { ws: ws.map((w) => w.w.replace(/[.:]+$/, "")), ks: ws.map((w) => klasse(w, englisch)) }
  })
  type Art = "nom" | "zahl" | "name" | "attr"
  const anfangsArt = (g: { ws: string[]; ks: Klasse[] }): Art | null => {
    const n = g.ks.length
    if (nominalAmEnde(g.ks)) return "nom"
    if (n >= 2 && g.ks[n - 1] === "Z" && g.ks[n - 2] === "N" && !UMFANG_NOMEN.test(g.ws[n - 2])) return "zahl"
    if (!englisch && n >= 2 && g.ks[n - 1] === "A" && g.ks[n - 2] === "N" && !istVerbform(g.ws[n - 1])) return "name"
    if (!englisch && n >= 1 && g.ks[n - 1] === "A" && ADJ_ENDUNG.test(g.ws[n - 1]) && !istVerbform(g.ws[n - 1])) return "attr"
    return null
  }
  const endung = (w: string) => w.match(ADJ_ENDUNG)?.[0].toLowerCase() ?? ""
  for (let i = 0; i < glieder.length - 1; i++) {
    const art = anfangsArt(glieder[i])
    if (!art) continue
    const ref = glieder[i].ws[glieder[i].ws.length - 1]
    let n = 1
    let alternative = false
    let j = i + 1
    for (; j < glieder.length; j++) {
      if (trenner[j - 1] === "o") alternative = true
      const { ws, ks } = glieder[j]
      const einzelA = ks.length === 1 && ks[0] === "A" && !istVerbform(ws[0])
      const mitte =
        art === "nom" ? ganzNominal(ks)
        : art === "zahl" ? ks.length === 1 && ks[0] === "Z"
        : art === "name" ? einzelA || ganzNominal(ks)
        : einzelA && endung(ws[0]) === endung(ref)
      if (mitte) { n++; continue }
      const ende =
        art === "nom" ? nominalAb(ks, 0) >= 0
        : art === "zahl" ? ks[0] === "Z"
        : art === "name" ? ks[0] === "A" && !istVerbform(ws[0])
        : ks[0] === "A" && endung(ws[0]) === endung(ref) && !istVerbform(ws[0]) && nominalAb(ks, 0, 3, true) >= 0
      if (ende) n++
      break
    }
    if (n >= 3 && !alternative) return teile.slice(i, Math.min(j + 1, teile.length)).join(", ")
    i = j - 1
  }
  return null
}
// Aufzählung von Kriterien/Spalten ist keine Einheitenmenge.
const KRITERIEN_LISTE =
  /\b(?:nach|hinsichtlich|bezüglich|bezueglich|bzgl|by|regarding|in terms of|spalten(?:\s+für|\s+fuer)?|columns(?:\s+for)?|felder(?:n)?(?:\s+für)?|fields(?:\s+for)?)\s*:?\s*[\p{L}\d.+-]+\s*,\s*[\p{L}\d.+-]+(?:\s*,\s*[\p{L}\d.+-]+)*\s*,?\s*(?:(?:und|and|oder|or|sowie|&)\s+[\p{L}\d.+-]+)?/giu
// Ja/Nein-Prüffrage („prüf, ob die drei Tests grün sind“, „tell me if the
// three branches are correct“): ihr Gegenstand ist keine Arbeitseinheit.
// W-Nebensätze bleiben — „Erkläre in einem Bericht, wie die 5 Anbieter …“
// nennt die Einheiten gerade im Nebensatz.
// K2d: die Klausel reicht bis zum SATZENDE — ein Punkt zählt nur, wenn danach
// Leerraum/Ende folgt („auth.spec.ts“, „0.6.24“ bleiben drin), ein Komma nur,
// wenn danach ein neuer Hauptsatz mit und/dann/and/then beginnt („…, ob X grün
// ist, und schreib je Anbieter …“). Bis K2c brach sie an JEDEM „.“ und „,“ ab:
// „ob die Tests in auth.spec.ts, oauth.spec.ts und token.spec.ts grün sind“
// ließ „.spec.ts, oauth.spec.ts und token.spec.ts“ als Einheitenmenge stehen.
const INDIREKTE_FRAGE =
  /(?:,\s*|\s)(?:ob|whether|if)\s(?:[^.!?;\n,]|[.!?](?=[^\s])|,(?!\s*(?:und|dann|danach|and|then)\s))*/giu
const KONTEXT = new RegExp(
  [
    "\\b(?:oben|obige[nmrs]?|vorhin|soeben|hier|hierzu|darüber|dazu)\\b",
    "\\bvon (?:eben|gerade|gestern|vorhin)\\b",
    "\\b(?:du|wir|ich) (?:gerade|eben)\\b",
    "\\b(?:diese[rsnm]?|jene[rsnm]?)\\s+\\p{L}",
    "\\b(?:deiner|deinem|deinen|meiner|meinem|unserer) (?:letzten|vorigen|vorherigen)\\b",
    `\\b(?:der|die|den|dem|des)\\s+(?:${ZAHL}\\s+)?(?:letzte[nmrs]?|vorige[nmrs]?|vorherige[nmrs]?)\\b(?!\\s+(?:${ZAHL}\\s+)?(?:tage?n?|wochen?|monate?n?|jahre?n?|stunden?|minuten?|nächte?n?|naechte?n?|sprints?|quartale?n?)\\b)`,
    "\\baus der (?:analyse|recherche|tabelle|liste|antwort|ausgabe)\\b",
    "\\b(?:above|this|these|that one|the previous|earlier)\\b",
    `\\b(?:the|my|your)\\s+last\\b(?!\\s+(?:${ZAHL}\\s+)?(?:days?|weeks?|months?|years?|hours?|sprints?|quarters?)\\b)`,
  ].join("|"),
  "iu",
)
const BEISPIEL_RAHMEN =
  /(?:\b(?:etwa|beispielsweise|zum beispiel|hypothetisch|angenommen|e\.g\.|for example|for instance|hypothetically|suppose)|\bz\.\s?b\.|\b(?:wenn|falls) ich (?:schreibe|sage|tippe|frage|eingebe)|\bif i (?:write|say|type))\s*:[\s\S]*$/imu

// Arbeitsverben: ihr Ergebnis je Einheit IST das Ergebnis (Recherche-,
// Prüf-, Vergleichsbefund). Die übrigen Erstellverben brauchen ein Artefakt.
const ARBEIT = new Set([
  "recherchier", "analysier", "vergleich", "prüf", "pruef", "test", "bewert", "evaluier", "untersuch",
  "review", "benchmark", "auditier", "dokumentier", "fass", "trag", "stell", "ermittl", "führ", "fuehr",
  "research", "compare", "summarize", "summarise", "analyze", "analyse", "document", "evaluate", "audit",
  "assess", "investigate",
])
// K2i (Abnahme R20): „Fass die Preise der drei Anbieter kurz zusammen.“ bekam
// die PFLICHT — Einheiten „drei Anbieter“ + Arbeitsverb „fass … zusammen“, und
// bei Arbeitsverben galt das Verb selbst als Ergebnis. Zusammenfassen/
// Zusammenstellen ist aber n→1: aus mehreren Gegenständen wird EIN Ergebnis,
// es zerfällt nicht in unabhängige Teile. Als eigenes Ergebnis zählt ein
// Aggregationsverb deshalb nur, wenn der Auftrag VERTEILT ist („für jeden …“,
// „je Anbieter“, „pro Version“, „each of …“, „einzeln/getrennt“). Ein bestelltes
// Artefakt („in einer Tabelle“, „in docs/x.md“) und andere Arbeitsverben im
// selben Auftrag („Recherchier … und fass zusammen“) tragen weiter.
const AGGREGAT_STAMM = new Set(["fass", "trag", "stell", "führ", "fuehr", "summarize", "summarise"])
const VERTEILT_ADVERB =
  /(?<![\p{L}])(?:jeweils|einzeln|separat|getrennt|unabhängig|unabhaengig|respectively|separately|individually|independently)(?![\p{L}])/iu
const VERTEILT_QUANTOR =
  /(?<![\p{L}])(?:je|pro|per|für\s+jede[nrsm]?|fuer\s+jede[nrsm]?|for\s+(?:each|every)|each|every|jede[nrsm]?)\s+(?:(?:der|des|von|of|of\s+the|the)\s+)?([\p{L}\d][\p{L}\d.-]*)/giu
function verteilt(text: string): boolean {
  if (VERTEILT_ADVERB.test(text)) return true
  for (const m of text.matchAll(VERTEILT_QUANTOR)) {
    const w = m[1].replace(/[.]+$/, "")
    if (!UMFANG_NOMEN.test(w) && !AUSNAHME_JE.test(w)) return true
  }
  return false
}
function istAggregat(v: Treffer): boolean {
  const stamm = v.verb.toLowerCase().replace(/(?:en|e|n)$/, "")
  if (!AGGREGAT_STAMM.has(stamm)) return false
  // „führ … durch“ ist Ausführen, nicht Zusammenführen.
  return /^summari[sz]/.test(stamm) || /\bzusammen\b/i.test(v.rest)
}

const BEDARF_RAHMEN =
  /\b(?:(?:ich|wir)\s+(?:brauche|brauchen|hätte gerne?|haette gerne?|hätten gerne?|will|wollen|möchte|möchten|moechte|moechten)|(?:i|we)\s+(?:need|want|'d like|would like))\b/i

/** Einheitenmenge (≥ 2 unabhängige, als NOMEN benannte Gegenstände) oder null. */
export function erkenneEinheiten(text: string): string | null {
  let t = text.replace(INDIREKTE_FRAGE, " ")
  t = t.replace(KRITERIEN_LISTE, " ")
  const englisch = englischerText(t)
  const s = saetze(t).flatMap((x) => x.split(/\s*[;:–—]\s+/))
  for (const satz of s) {
    const m = mengeImSatz(satz, englisch)
    if (m) return m
  }
  for (const satz of s) {
    const a = aufzaehlungImSatz(satz, englisch)
    if (a) return a
  }
  const nummern = t.match(/\b1\)\s[\s\S]*\b2\)\s/u)
  if (nummern) return nummern[0]
  return null
}

export function erkenneAuftrag(textRaw: string): { verb: string; objekt: string; einheiten: string } | null {
  const text = ohneZitate(textRaw).replace(BEISPIEL_RAHMEN, " ")
  if (VETO.test(text)) return null
  if (KONTEXT.test(text)) return null
  const einheiten = erkenneEinheiten(text)
  if (!einheiten) return null

  const ergebnisObjekt = (s: string) =>
    s.match(OBJ_PFAD)?.[0] ?? s.match(OBJ_PRAEP_DE)?.[0] ?? s.match(OBJ_PRAEP_EN)?.[0] ?? s.match(OBJ_UMFANG)?.[0] ?? null
  const artefaktObjekt = (s: string) => s.match(OBJ_ARTEFAKT_DE)?.[0] ?? s.match(OBJ_ARTEFAKT_EN)?.[0] ?? null
  // „drei Varianten“, „five drafts“: die Einheiten sind selbst die Artefakte.
  // Ausgenommen Datei/file: „die drei geänderten Dateien“ sind EINGABE —
  // als Ergebnis zählt eine Datei nur mit Artikel/Präposition („als Datei“).
  const mengenArtefakt = (s: string) => {
    const m = s.match(new RegExp(`\\b${ZAHL}\\s+(?:${W}+\\s+){0,2}?${W}*?(?:${ARTEFAKT_DE}|entwürfe|entwuerfe|${ARTEFAKT_EN}|reports|articles|tables|lists)\\b`, "iu"))?.[0]
    return m && !/(?:datei|dateien|file|files)$/i.test(m) ? m : null
  }

  // Bedarfs-Rahmen: „Ich hätte gern für jeden … eine Tabelle“, „Ich brauche
  // bis morgen einen Vergleichsartikel …“ — Artefakt im selben Hauptsatz.
  for (const satz of saetze(text)) {
    if (FRAGE_ANFANG.test(satz)) continue
    const b = satz.match(BEDARF_RAHMEN)
    if (!b) continue
    const rest = hauptsatz(satz.slice((b.index ?? 0) + b[0].length))
    const o = ergebnisObjekt(rest) ?? artefaktObjekt(rest)
    if (o) return { verb: "bedarf", objekt: o.trim(), einheiten }
  }

  const verben = saetze(text).flatMap(findeVerben)
  for (const v of verben.filter((v) => v.stark)) {
    const stamm = v.verb.toLowerCase().replace(/(?:en|e|n)$/, "")
    const arbeit = ARBEIT.has(v.verb.toLowerCase()) || ARBEIT.has(stamm)
    const verbAlsErgebnis = arbeit && !(istAggregat(v) && !verteilt(text))
    const o =
      ergebnisObjekt(text) ?? (v.kreation ? artefaktObjekt(text) : null) ?? mengenArtefakt(text) ?? (verbAlsErgebnis ? v.verb : null)
    if (o) return { verb: v.verb, objekt: o.trim(), einheiten }
  }
  // Erklärverb: nur mit Ergebnisobjekt im eigenen Hauptsatz („Erkläre in
  // einem Bericht, wie …“ ja — „Erkläre, wie die Fabrik einen Bericht
  // schreibt“ und „explain the difference between an audit and a review“ nein).
  for (const v of verben.filter((v) => !v.stark)) {
    const o = ergebnisObjekt(hauptsatz(v.rest))
    if (o) return { verb: v.verb, objekt: o.trim(), einheiten }
  }
  return null
}

/**
 * Nur den NUTZERTEXT bewerten: guard.ts & Co. reichern den Prompt mit
 * Vertragsblöcken an („[Guard: TASK-VERTRAG] … RÜCKFRAGEN: …"), deren
 * Stichworte nichts über den Auftrag aussagen. Gemessen 26.09.2026 im
 * E2E-Test: der Vertrag allein kippte einen FABRIK-Fall auf DIREKT.
 */
export function nutzerText(textRaw: string): string {
  const firstHook = textRaw.search(/\n\[(?:Guard|FABRIK-GATE)[:\]]/)
  return (firstHook > 0 ? textRaw.slice(0, firstHook) : textRaw).trim()
}

/**
 * Woher die Entscheidung stammt (K2e-Nachtrag, 13.10.2026) — das Plugin stuft
 * danach den Hinweis ab: `praefix`/`wortregel` → Pflichtweg, `llm` → weicher
 * Hinweis ohne Pflicht. `nein_signal` und `keine` injizieren nie.
 *   praefix     — Nutzer-Prefix fabrik:/direkt:
 *   nein_signal — Nein-Fall-Signal (Deploy, Geld, Secrets, Löschen …)
 *   wortregel   — erkenneAuftrag: Auftrag mit Ergebnis über ≥ 2 Einheiten
 *   llm         — Grauzone, der LLM-Urteiler hat JA oder NEIN gesagt
 *   keine       — Grauzone ohne Urteil (classify ohne --llm, LLM-Ausfall)
 */
export type Quelle = "praefix" | "nein_signal" | "wortregel" | "llm" | "keine"

export function classify(textRaw: string) {
  const trimmed = nutzerText(textRaw)
  const lower = trimmed.replace(/^["„“»]/, "").toLowerCase()
  const prefix = lower.startsWith("fabrik:") ? "fabrik" : lower.startsWith("direkt:") ? "direkt" : null

  const fabrik = FABRIK_SIGNALS.filter((s) => s.re.test(trimmed)).map((s) => s.name)
  // K2/R22: Nein-Signale sehen den Text ohne Dateinamen/Pfade (EINE Stelle).
  const ohneNamen = ohneDateinamen(trimmed)
  const direkt = DIREKT_SIGNALS.filter((s) => s.re.test(ohneNamen)).map((s) => s.name)

  // Nutzer-Prefix ist Wille, kein Rat.
  if (prefix === "fabrik")
    return { entscheidung: "FABRIK", signale: fabrik, prefix, grund: "Nutzer-Prefix fabrik:", auftrag: null, injizieren: true, quelle: "praefix" as Quelle }
  if (prefix === "direkt")
    return { entscheidung: "DIREKT", signale: direkt, prefix, grund: "Nutzer-Prefix direkt:", auftrag: null, injizieren: false, quelle: "praefix" as Quelle }

  // Sicherheit schlägt Effizienz.
  if (direkt.length > 0)
    return { entscheidung: "DIREKT", signale: direkt, prefix, grund: `Nein-Fall-Signal(e): ${direkt.join(", ")}`, auftrag: null, injizieren: false, quelle: "nein_signal" as Quelle }

  // DIE Regel (K2c): Auftrag mit Ergebnis über ≥ 2 unabhängige Einheiten,
  // ohne Bindung an Material dieser Sitzung. Signalwörter sind nur Messung.
  const auftrag = erkenneAuftrag(trimmed)
  if (auftrag)
    return {
      entscheidung: "FABRIK",
      signale: fabrik,
      prefix,
      grund: `Auftrag über mehrere Einheiten (${auftrag.einheiten.slice(0, 40)}) mit Ergebnis (${auftrag.verb} → ${auftrag.objekt.slice(0, 60)})`,
      auftrag,
      injizieren: true,
      quelle: "wortregel" as Quelle,
    }
  if (fabrik.length >= 2)
    return {
      entscheidung: "GRAUZONE",
      signale: fabrik,
      prefix,
      grund: `${fabrik.length} Ja-Fall-Signale (${fabrik.join(", ")}), aber kein Auftrag mit Ergebnis über ≥ 2 Einheiten (oder an Sitzungskontext gebunden) — nur Messung, keine Injektion`,
      auftrag: null,
      injizieren: false,
      quelle: "keine" as Quelle,
    }
  if (fabrik.length === 1)
    return { entscheidung: "GRAUZONE", signale: fabrik, prefix, grund: `nur ein Ja-Fall-Signal (${fabrik[0]}) — Eskalationsleiter entscheidet, Begründung Pflicht`, auftrag, injizieren: false, quelle: "keine" as Quelle }
  return { entscheidung: "GRAUZONE", signale: [], prefix, grund: "keine Signale — Eskalationsleiter entscheidet, Begründung Pflicht", auftrag, injizieren: false, quelle: "keine" as Quelle }
}

// ---------------------------------------------------------------------------
// LLM-URTEILER IN DER GRAUZONE (K2e, 13.10.2026, Abnahme R16 6/10)
// ---------------------------------------------------------------------------
// Die Wortregel erkennt ~38 % der Fan-out-Aufträge. R16 maß einen NEUTRALEN
// LLM-Urteiler über dharma/fast: 46/62 erkannt bei 3 falschen JA; „Wortregel
// ODER LLM nur in der Grauzone“ 55/77 bei 7 falschen JA. Der Prompt unten ist
// WÖRTLICH der der Abnahme (abnahme16/k2label/llm_neutral.py) — nicht auf
// Prüfmengen nachgeschärft. Ein früherer Versuch scheiterte an „Im Zweifel
// NEIN“ und an max_tokens 16 (leere/abgeschnittene Antworten).
//
// Fail-open: Fehler, Zeitüberschreitung, leere oder unklare Antwort → null
// (= kein Hinweis). Ein Urteiler, der ausfällt, darf nie selbst injizieren.

export const LLM_PROMPT = `Entscheide, ob der folgende Auftrag in die "Subagenten-Fabrik" gehört (parallele Bearbeitung durch mehrere Agenten).
Definition des Betreibers: Aufgaben, die in ≥2 unabhängige Teile zerfallen ODER ein abgeschlossenes Deliverable haben, laufen über die Fabrik. Ja-Fälle: Research-Fächer, Multi-Review, Varianten, Artikel/Analysen, Testsuiten — alles mit klarem Endprodukt. Nein-Fälle: kontextgebundene Aufgaben (bezieht sich auf Material dieser Sitzung), Rückfragen an den Nutzer nötig, Einzelschritte unter 1 Minute, Geldpfad/Deploys, reine Fragen/Erklärungen.
Antworte mit genau einem Wort: JA oder NEIN.

Auftrag: `

export const LLM_URL = "https://dharma.mcp-hub.stream/v1/chat/completions"
export const LLM_MODELL = "fast"
export const LLM_MAX_TOKENS = 64
// K2i (Abnahme R20): 4 s ließen 3 von 8 Ja-Fällen in die Frist laufen; 6 s
// (Plugin-Aufruf 6,5 s). Triviale Prompts kostet das nichts — die K2f-
// Vorfilter fragen das LLM dort gar nicht.
export const LLM_TIMEOUT_MS = 6000
const LLM_KEYFILE = join(homedir(), ".config/opencode/.secrets/dharma.key")
const USER_AGENT = "openflow-of-gate/K2e (+fabrik-gate)"

export type LlmOpts = {
  /** Für Tests: gemocktes fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Pfad der Schlüsseldatei — der Schlüssel selbst ist nie Argument. */
  keyFile?: string
}
export type LlmDetail = { urteil: boolean | null; ms: number; fehler: string | null }

/**
 * Antworttext → JA/NEIN/null. dharma hängt eine Fußzeile `⎯⎯ modell · stufe ·
 * anbieter ⎯⎯` an; sie wird abgeschnitten, ebenso ein `<think>`-Block. Gewertet
 * wird die erste nicht-leere Zeile, führende Satzzeichen/Markdown ignoriert.
 */
export function parseLlmAntwort(roh: unknown): boolean | null {
  if (typeof roh !== "string") return null
  let t = roh.replace(/<think>[\s\S]*?<\/think>/gi, "")
  const fuss = t.indexOf("⎯⎯")
  if (fuss >= 0) t = t.slice(0, fuss)
  const zeile = t.split("\n").map((z) => z.trim()).find(Boolean)
  if (!zeile) return null
  const w = zeile.replace(/^[^\p{L}]+/u, "").toUpperCase()
  if (/^JA(?![\p{L}])/u.test(w)) return true
  if (/^NEIN(?![\p{L}])/u.test(w)) return false
  return null
}

/** Wie urteileMitLlm, aber mit Dauer und Fehlergrund (für Ledger/Messung). */
export async function urteileMitLlmDetail(text: string, opts: LlmOpts = {}): Promise<LlmDetail> {
  const t0 = performance.now()
  const fertig = (urteil: boolean | null, fehler: string | null): LlmDetail => ({ urteil, ms: Math.round(performance.now() - t0), fehler })
  let key: string
  try {
    key = readFileSync(opts.keyFile ?? LLM_KEYFILE, "utf8").trim()
  } catch {
    return fertig(null, "schluessel_fehlt")
  }
  if (!key) return fertig(null, "schluessel_fehlt")
  const f = opts.fetch ?? fetch
  try {
    const res = await f(LLM_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        model: LLM_MODELL,
        temperature: 0,
        max_tokens: LLM_MAX_TOKENS,
        // Kein Denken für ein Ein-Wort-Urteil: gemessen 13.10.2026 routete
        // dharma/fast auf qwen3.8-27b (yolo) — ohne Feld 101–196 Reasoning-
        // Tokens und 4,7–9,1 s, mit "none" 0 Tokens und ~3,5 s. Parameter, kein
        // Prompt-Zusatz; ein Upstream, der es ablehnt, ergibt null (fail-open).
        reasoning_effort: "none",
        messages: [{ role: "user", content: LLM_PROMPT + text }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS),
    })
    if (!res.ok) return fertig(null, `http_${res.status}`)
    const j: any = await res.json()
    const inhalt = j?.choices?.[0]?.message?.content
    if (typeof inhalt !== "string" || !inhalt.trim()) return fertig(null, "leer")
    const u = parseLlmAntwort(inhalt)
    return fertig(u, u === null ? "unklar" : null)
  } catch (e: any) {
    const name = String(e?.name ?? "")
    return fertig(null, name === "TimeoutError" || name === "AbortError" ? "timeout" : "netz")
  }
}

/** Neutraler LLM-Urteiler: true = JA (Fabrik), false = NEIN, null = kein Hinweis. */
export async function urteileMitLlm(text: string, opts: LlmOpts = {}): Promise<boolean | null> {
  return (await urteileMitLlmDetail(text, opts)).urteil
}

// ---------------------------------------------------------------------------
// K2f (13.10.2026, Abnahme R17): ganzer Text + LLM-Vorfilter
// ---------------------------------------------------------------------------
// R17: (1) Das Plugin schnitt den Prompt auf 2000 Zeichen, BEVOR das Gate ihn
// sah — „<lange Logs> … deployen und Prepaid aufladen“ verlor sein Nein-Signal
// am Ende. Jetzt bekommt das Gate den ganzen Text; gekürzt wird nur die
// LLM-Eingabe, und zwar auf Anfang UND Ende (dort stehen Auftrag und Schluss-
// anweisung, dazwischen meist eingefügtes Material).
// (3) Fast jeder Prompt kostete ~3 s LLM-Wartezeit, auch „Was ist ein
// Checkpoint?“. Drei Vorfilter sparen den Aufruf, wo das LLM nichts zu
// entscheiden hat. Sie wirken NUR in der Grauzone und NUR auf den Aufruf:
// das Verdikt bleibt `injizieren: false`, wie bei einem LLM-Ausfall.
export const LLM_KOPF_ZEICHEN = 1500
export const LLM_KURZ_ZEICHEN = 60
export const LLM_KURZ_WOERTER = 8

/** LLM-Eingabe: bis 2×1500 Zeichen unverändert, sonst Anfang + Ende mit Auslassungsmarke. */
export function llmText(t: string): string {
  if (t.length <= 2 * LLM_KOPF_ZEICHEN) return t
  const weg = t.length - 2 * LLM_KOPF_ZEICHEN
  return `${t.slice(0, LLM_KOPF_ZEICHEN)}\n[… ${weg} Zeichen ausgelassen …]\n${t.slice(-LLM_KOPF_ZEICHEN)}`
}

// Spur einer Mehrzahl/Aufzählung/Menge oder eines Ergebnisses — bewusst WEIT:
// ein falsches „Indiz da“ kostet nur einen LLM-Aufruf, ein falsches „kein
// Indiz“ einen übersehenen Auftrag. Schon „und“/„and“ zählt.
const MENGEN_SPUR = new RegExp(
  `(?<![\\p{L}])(?:und|oder|sowie|plus|and|or|nor|beide[nrs]?|both|alle[nrs]?|all|jede[nrsm]?|each|every|je|pro|per|jeweils|respectively|mehrere[nr]?|several|multiple|various|verschiedene[nrs]?|einzeln|getrennt|separat|separate(?:ly)?|unabhängig|unabhaengig|independent(?:ly)?|${ZAHL})(?![\\p{L}])|&|\\b\\d+\\s+\\p{L}`,
  "iu",
)
const ARTEFAKT_SPUR = new RegExp(`(?:${ARTEFAKT_DE}|${ARTEFAKT_EN})(?![\\p{L}])`, "iu")

function fanoutIndiz(text: string): boolean {
  if (MENGEN_SPUR.test(text) || ARTEFAKT_SPUR.test(text)) return true
  if (FABRIK_SIGNALS.some((s) => s.re.test(text))) return true
  if (saetze(text).some((s) => (s.match(/,/g) ?? []).length >= 2)) return true
  return erkenneEinheiten(text) !== null
}

/**
 * Grund, das LLM NICHT zu fragen, oder null:
 *   kurz             — < 60 Zeichen oder < 8 Wörter, ohne Einheitenmenge/Aufzählung
 *   reine_frage      — jeder Satz ist eine Frage (Fragewort am Anfang oder „?“),
 *                      ohne Erstell-/Arbeitsverb und ohne Bedarfs-Rahmen; ein
 *                      Bitt-Rahmen („Kannst du …?“) zählt nur mit Erklärverb
 *                      als Frage, ohne erkanntes Verb ist er ein Auftrag
 *   kein_fanout_indiz — weder Mehrzahl-/Aufzählungs-/Mengenspur noch Artefakt
 *                      noch Ja-Fall-Signal
 */
export function llmVorfilter(textRaw: string): string | null {
  const text = ohneZitate(nutzerText(textRaw))
  const woerter = text.split(/\s+/).filter(Boolean).length
  // Telegramm-Aufzählung „A, B und C“ hält auch einen kurzen Prompt im LLM-Weg —
  // erkenneEinheiten verlangt Nomen, klein geschriebene Namen („rille,
  // wortwert und memex“) erkennt es nicht.
  const aufzaehlung = /[^\s,]+\s*,\s*[^\s,]+(?:\s*,\s*[^\s,]+)*\s+(?:und|and|sowie|&)\s+\S/i.test(text)
  if ((text.length < LLM_KURZ_ZEICHEN || woerter < LLM_KURZ_WOERTER) && !aufzaehlung && erkenneEinheiten(text) === null) return "kurz"
  const ss = saetze(text)
  const frage = (s: string) => {
    if (!/\?\s*$/.test(s) && !FRAGE_ANFANG.test(s)) return false
    const vs = findeVerben(s)
    if (vs.some((v) => v.stark)) return false
    if (BITT_RAHMEN.test(s) && vs.length === 0) return false
    return true
  }
  if (ss.length > 0 && ss.every(frage) && !BEDARF_RAHMEN.test(text)) return "reine_frage"
  if (!fanoutIndiz(text)) return "kein_fanout_indiz"
  return null
}

/**
 * DIE kombinierte Entscheidung (K2e) — EINE Stelle, das Plugin entscheidet nichts:
 *   1. Nein-Signale (Deploy, Geld, Secrets, Löschen …) und Prefix — wie classify,
 *      DIREKT ruft nie das LLM.
 *   2. Wortregel-Auftrag (FABRIK) → injizieren, ohne LLM-Aufruf.
 *   3. GRAUZONE → LLM-Urteiler; JA → injizieren, NEIN/null → nicht.
 * Rückgabe = classify-Verdikt + `llm` (true/false/null), `llm_ms` (null, wenn
 * nicht aufgerufen), `llm_fehler`; `quelle` = `llm`, sobald das LLM JA/NEIN
 * gesagt hat (bei Ausfall bleibt `keine`).
 */
export async function entscheide(textRaw: string, opts: LlmOpts = {}) {
  // Nein-Signale, Prefix und Wortregel sehen IMMER den ganzen Text (K2f) —
  // gekürzt wird nur, was ans LLM geht (llmText).
  const v = classify(textRaw)
  if (v.entscheidung !== "GRAUZONE") return { ...v, llm: null, llm_ms: null, llm_fehler: null }
  // K2f-Vorfilter: spart NUR den LLM-Aufruf — das Verdikt bleibt das der
  // Grauzone (injizieren: false). Ein Vorfilter kann nie injizieren.
  const sprung = llmVorfilter(textRaw)
  if (sprung) return { ...v, llm: null, llm_ms: null, llm_fehler: null, llm_uebersprungen: sprung }
  const d = await urteileMitLlmDetail(llmText(nutzerText(textRaw)), opts)
  if (d.urteil === true)
    return {
      ...v,
      entscheidung: "FABRIK",
      grund: `Grauzone, LLM-Urteiler (dharma/${LLM_MODELL}): JA — Wortregel ohne belegten Auftrag${v.signale.length ? ` (Signale: ${v.signale.join(", ")})` : ""}`,
      injizieren: true,
      quelle: "llm" as Quelle,
      llm: true,
      llm_ms: d.ms,
      llm_fehler: null,
    }
  return { ...v, quelle: (d.urteil === null ? "keine" : "llm") as Quelle, llm: d.urteil, llm_ms: d.ms, llm_fehler: d.fehler }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (cmd === "classify") {
    const i = argv.indexOf("--text")
    const text = i >= 0 ? argv[i + 1] : readFileSync(0, "utf8")
    // --llm: kombinierte Entscheidung (Grauzone → LLM-Urteiler), K2e.
    console.log(JSON.stringify(argv.includes("--llm") ? await entscheide(text) : classify(text)))
    process.exit(0)
  }

  if (cmd === "log") {
    // of-gate.ts log <entscheidung> "<task>" "<grund>" [--event task|fabrik_run]
    //                  [--task-ref <gate_id>] [--monitoring]
    const [entscheidung, task = "", grund = ""] = argv.slice(1)
    const ev = argv.includes("--event") ? argv[argv.indexOf("--event") + 1] : "task"
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      event: ev,
      entscheidung,
      task: task.slice(0, 160),
      grund: grund.slice(0, 240),
    }
    if (argv.includes("--task-ref")) entry.task_ref = argv[argv.indexOf("--task-ref") + 1] ?? null
    if (ev === "fabrik_run" && !("task_ref" in entry)) entry.task_ref = null
    if (argv.includes("--monitoring")) entry.monitoring = true
    mkdirSync(dirname(LEDGER), { recursive: true })
    appendFileSync(LEDGER, JSON.stringify(entry) + "\n")
    console.log(JSON.stringify(entry))
    process.exit(0)
  }

  console.error(
    "usage: bun of-gate.ts classify [--text <task>] | log <entscheidung> <task> <grund> [--event task|fabrik_run] [--task-ref <gate_id>] [--monitoring]",
  )
  process.exit(2)
}
