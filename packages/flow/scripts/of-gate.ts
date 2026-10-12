/**
 * of-gate — deterministischer Fabrik-Gate für REGEL 4 (Subagenten-Fabrik).
 *
 * Bewertet einen Task-Text gegen die Ja-/Nein-Fälle der Nutzerorder vom
 * 18.09.2026 — ohne LLM, reine Signale. Liefert eine EMPFEHLUNG:
 *
 *   FABRIK    — AUFTRAG MIT ERGEBNISOBJEKT (Befehls-/Erstellverb + Bericht/
 *               Artikel/Datei/Tabelle/„für jeden …“/Mengenangabe) UND
 *               mindestens 2 Ja-Fall-Signale (Research-Fächer, Multi-Review,
 *               Artikel, Varianten, Testsuiten). Nur dann `injizieren: true`.
 *   DIREKT    — klarer Nein-Fall (Geldpfad, Deploy, Secrets, Rückfragen,
 *               Einzelschritt <1 min) oder Nutzer-Prefix "direkt:"
 *   GRAUZONE  — alles andere: Fragen, Erklärwünsche, Aufträge ohne
 *               Ergebnisobjekt oder mit weniger als 2 Signalen. Nur Messung.
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
 *   bun of-gate.ts log <entscheidung> "<task>" "<grund>" [--event task|fabrik_run]
 *                                              [--task-ref <gate_id>] [--monitoring]
 *
 * Ausgabe classify: eine JSON-Zeile
 *   {entscheidung, signale, prefix, grund, auftrag: {verb, objekt} | null, injizieren}.
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
    re: /\b(?:drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|zwanzig|[3-9]|[1-9]\d|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s+(?:\p{L}+\s+)?(?!(?:sätze|saetze|zeilen|wörter|woerter|absätze|absaetze|stichpunkte|punkte|minuten|sekunden|stunden|tage|wochen|sentences|lines|words|paragraphs|bullets|minutes|seconds|hours|days|weeks)\b)(?:\p{Lu}[\p{L}-]*|[a-z-]{3,}s)\b/u,
    name: "mengenangabe",
  },
  { re: /\bparallel(?!e leitung)/i, name: "parallel" },
  { re: /\bmehrere (unabhängige|getrennte|eigene )/i, name: "mehrere-unabhaengige" },
]

// Nein-Fall-Signale: kontextgebunden, gefährlich, dialogisch, trivial.
const DIREKT_SIGNALS: { re: RegExp; name: string }[] = [
  { re: /\bdeploy|deployment|rollout\b/i, name: "deploy" },
  { re: /\bgeld|payment|stripe|abrechnung|invoice\b/i, name: "geldpfad" },
  { re: /\bsecret|passwort|password|api[- ]key|token rotat|credentials\b/i, name: "secrets" },
  { re: /\bssh|produktionsserver|prod-server\b/i, name: "server-zugriff" },
  { re: /\bmainnet|wallet|transaktion senden\b/i, name: "krypto-geldpfad" },
  { re: /\brückfrage|frage den nutzer|den nutzer fragen|nachfragen beim nutzer\b/i, name: "rueckfrage" },
  { re: /\beinzelschritt|ein schritt|quick fix|hotfix|trivial\b/i, name: "einzelschritt" },
  { re: /\bmerge|squash-merge|pr mergen\b/i, name: "merge" },
  { re: /\bpush(en)? zu (main|master|origin)\b/i, name: "push" },
  { re: /\b(löschen|loeschen|delete|drop)\b.{0,30}\b(produktiv|prod|live|datenbank)\b/i, name: "destruktiv-prod" },
]

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
  "bericht|berichts|artikel|report|dossier|whitepaper|blogpost|tabelle|liste|übersicht|uebersicht|matrix|testsuite|test-suite|regressionssuite|tests|review|reviews|empfehlung|zusammenfassung|memo|gutachten|steckbrief|varianten|entwürfe|entwuerfe|abschnitt|kapitel|dokument|präsentation|praesentation|checkliste|faktenblatt|vergleich|auswertung|analyse|rangliste"
const ARTEFAKT_EN =
  "report|article|blog ?post|table|list|test ?suite|tests|review|reviews|summary|summaries|comparison|recommendation|memo|document|doc|spreadsheet|matrix|variants|drafts|section|chapter|checklist|brief|write-?up|analysis|ranking|overview"

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
// SCHWACH: Fan-out-Menge — zählt nur zusammen mit einem Erstellverb.
const OBJ_QUANTOR =
  /\b(?:für|for)\s+(?:jede[nrsm]?|alle|each|every)\b|\bjede[nrsm]?\s+(?:unserer|der|einzelne[nrsm]?|\p{Lu})|\b(?:je|pro|per)\s+(?!nachdem|mehr|weniger|desto|eher)\p{L}{3,}|\b(?:each|every)\s+[a-z]{3,}|\bjeweils\b/iu
const OBJ_MENGE =
  /\b(?:\d+|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|zwanzig|alle[rnm]?|sämtliche[rn]?|saemtliche[rn]?|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|all)\s+(?:[\p{L}-]+\s+){0,2}?\p{L}{3,}/iu
const OBJ_AUFZAEHLUNG =
  /[\p{L}\d.+-]+\s*,\s*[\p{L}\d.+-]+(?:\s*,\s*[\p{L}\d.+-]+)*\s*,?\s+(?:und|and|oder|or|sowie|&)\s+[\p{L}\d.+-]+|[\p{L}\d.+-]+\s*,\s*[\p{L}\d.+-]+\s*,\s*[\p{L}\d.+-]+/u

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
// Bedarfs-Rahmen: „Ich brauche einen Vergleichsartikel …“.
const BEDARF = new RegExp(
  `\\b(?:ich|wir)\\s+(?:brauche|brauchen|hätte gern|hätte gerne|haette gern|hätten gern|will|wollen|möchte|möchten|moechte)\\s+(?:bitte\\s+|gern(?:e)?\\s+|noch\\s+)?(?:ein|eine|einen)\\s+(?:${W}+\\s+){0,2}?${W}*?(?:${ARTEFAKT_DE})\\b` +
    `|\\b(?:i|we)\\s+(?:need|want|'d like|would like)\\s+(?:a|an)\\s+(?:${W}+\\s+){0,2}?${W}*?(?:${ARTEFAKT_EN})\\b`,
  "i",
)
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

export function erkenneAuftrag(textRaw: string): { verb: string; objekt: string } | null {
  const text = ohneZitate(textRaw)
  if (VETO.test(text)) return null
  const bedarf = text.match(BEDARF)
  if (bedarf) return { verb: "bedarf", objekt: bedarf[0].trim() }

  const ergebnisObjekt = (s: string) =>
    s.match(OBJ_PFAD)?.[0] ?? s.match(OBJ_PRAEP_DE)?.[0] ?? s.match(OBJ_PRAEP_EN)?.[0] ?? s.match(OBJ_UMFANG)?.[0] ?? null
  const artefaktObjekt = (s: string) => s.match(OBJ_ARTEFAKT_DE)?.[0] ?? s.match(OBJ_ARTEFAKT_EN)?.[0] ?? null
  const mengenObjekt = (s: string) =>
    s.match(OBJ_QUANTOR)?.[0] ?? s.match(OBJ_MENGE)?.[0] ?? s.match(OBJ_AUFZAEHLUNG)?.[0] ?? null

  const verben = saetze(text).flatMap(findeVerben)
  // Erstell-/Befehlsverb: Objekt irgendwo im Text („Was macht jeder unserer
  // 13 Worker? Analysiere parallel und fasse zusammen.“).
  for (const v of verben.filter((v) => v.stark)) {
    const o = ergebnisObjekt(text) ?? (v.kreation ? artefaktObjekt(text) : null) ?? mengenObjekt(text)
    if (o) return { verb: v.verb, objekt: o.trim() }
  }
  // Erklärverb: nur mit Ergebnisobjekt im eigenen Hauptsatz („Erkläre in
  // einem Bericht, wie …“ ja — „Erkläre, wie die Fabrik einen Bericht
  // schreibt“ und „explain the difference between an audit and a review“ nein).
  for (const v of verben.filter((v) => !v.stark)) {
    const o = ergebnisObjekt(hauptsatz(v.rest))
    if (o) return { verb: v.verb, objekt: o.trim() }
  }
  return null
}

export function classify(textRaw: string) {
  // Nur den NUTZERTEXT bewerten: guard.ts & Co. reichern den Prompt mit
  // Vertragsblöcken an („[Guard: TASK-VERTRAG] … RÜCKFRAGEN: …"), deren
  // Stichworte nichts über den Auftrag aussagen. Gemessen 26.09.2026 im
  // E2E-Test: der Vertrag allein kippte einen FABRIK-Fall auf DIREKT.
  const firstHook = textRaw.search(/\n\[(?:Guard|FABRIK-GATE)[:\]]/)
  const text = (firstHook > 0 ? textRaw.slice(0, firstHook) : textRaw).trim()
  const trimmed = text
  const lower = trimmed.replace(/^["„“»]/, "").toLowerCase()
  const prefix = lower.startsWith("fabrik:") ? "fabrik" : lower.startsWith("direkt:") ? "direkt" : null

  const fabrik = FABRIK_SIGNALS.filter((s) => s.re.test(trimmed)).map((s) => s.name)
  const direkt = DIREKT_SIGNALS.filter((s) => s.re.test(trimmed)).map((s) => s.name)

  // Nutzer-Prefix ist Wille, kein Rat.
  if (prefix === "fabrik")
    return { entscheidung: "FABRIK", signale: fabrik, prefix, grund: "Nutzer-Prefix fabrik:", auftrag: null, injizieren: true }
  if (prefix === "direkt")
    return { entscheidung: "DIREKT", signale: direkt, prefix, grund: "Nutzer-Prefix direkt:", auftrag: null, injizieren: false }

  // Sicherheit schlägt Effizienz.
  if (direkt.length > 0)
    return { entscheidung: "DIREKT", signale: direkt, prefix, grund: `Nein-Fall-Signal(e): ${direkt.join(", ")}`, auftrag: null, injizieren: false }

  const auftrag = erkenneAuftrag(trimmed)
  if (fabrik.length >= 2 && auftrag)
    return {
      entscheidung: "FABRIK",
      signale: fabrik,
      prefix,
      grund: `mindestens 2 Ja-Fall-Signale: ${fabrik.join(", ")} — Auftrag mit Ergebnisobjekt (${auftrag.verb} → ${auftrag.objekt.slice(0, 60)})`,
      auftrag,
      injizieren: true,
    }
  if (fabrik.length >= 2)
    return {
      entscheidung: "GRAUZONE",
      signale: fabrik,
      prefix,
      grund: `${fabrik.length} Ja-Fall-Signale (${fabrik.join(", ")}), aber kein Auftrag mit Ergebnisobjekt — nur Messung, keine Injektion`,
      auftrag: null,
      injizieren: false,
    }
  if (fabrik.length === 1)
    return { entscheidung: "GRAUZONE", signale: fabrik, prefix, grund: `nur ein Ja-Fall-Signal (${fabrik[0]}) — Eskalationsleiter entscheidet, Begründung Pflicht`, auftrag, injizieren: false }
  return { entscheidung: "GRAUZONE", signale: [], prefix, grund: "keine Signale — Eskalationsleiter entscheidet, Begründung Pflicht", auftrag, injizieren: false }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (cmd === "classify") {
    const i = argv.indexOf("--text")
    const text = i >= 0 ? argv[i + 1] : readFileSync(0, "utf8")
    console.log(JSON.stringify(classify(text)))
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
