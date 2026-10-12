/**
 * of-heilung — die Regel, welche gescheiterten Läufe of-loop heilen darf.
 *
 * Anlass 12.10.2026: of-loop heilte im 5-Minuten-Takt Heilungsläufe. Der erste
 * Versuch eines Resume trug kein `resumeOf` (headless-run setzte es erst in den
 * LETZTEN Log, nach allen Versuchen), sah damit wie ein Ursprungslauf aus und
 * wurde selbst geheilt — eine Kette über zwei Stunden (14:10 … 14:35 UTC), alle
 * an demselben HTTP 401, ohne Alarm.
 *
 * Die Regel steht deshalb hier EINMAL, als reine Funktion (testbar ohne
 * Prozessstart), und of-loop ruft sie nur auf:
 *
 *   - Ein Lauf gehört zu einer FAMILIE: Ursprung + alle Resumes und
 *     Auto-Retries daraus. Verbunden über die Herkunftsfelder (`origin`,
 *     `resumeOf`, `retryOf`, ab jedem Versuch gesetzt — `herkunft()`), die
 *     `scorecard.predecessors` des letzten Versuchs und,
 *     für Logs von vor dem Fix, über gemeinsame Session-IDs (ein Resume setzt
 *     die Sitzungen seines Vorgängers fort; ein frischer Lauf nie).
 *   - Geheilt wird nur der URSPRUNG einer Familie (frühester Start), nie ein
 *     Heilungslauf — und höchstens HEIL_MAX-mal je Familie.
 *   - Zeigen die letzten SERIE_GLEICH Fehlschläge der Familie denselben
 *     Fehlertext, endet die Heilung, und es gibt EINEN Alarm.
 */

/** Höchstzahl Loop-Heilungen je Ursprung. Jede Heilung fährt selbst den
 * Runner-Auto-Retry (2 Versuche), zwei Heilungen sind also bis zu vier
 * zusätzliche Versuche nach den zwei des Ursprungs. Gemessen: alle vier
 * Loop-Heilungen, die vor dem 12.10. bestanden haben, bestanden bei der
 * ERSTEN Heilung; die zweite ist Puffer für einen Zufallstreffer während der
 * Heilung. Was nach sechs Versuchen noch scheitert, ist nicht vorübergehend. */
export const HEIL_MAX = 2
/** Gleicher Fehlertext so oft in Folge = systematischer Fehler (Konfiguration,
 * Schlüssel, Anbieter tot), den kein Resume heilt. Drei, weil ein Ursprung
 * mit Auto-Retry schon zwei gleiche liefert — erst die erste Heilung, die
 * denselben Text bringt, beweist die Serie. */
export const SERIE_GLEICH = 3

export interface RunLog {
  id: string
  status?: string
  pipeline?: string
  started?: number
  finished?: number
  origin?: string
  resumeOf?: string
  retryOf?: string
  nodes?: Array<{ status?: string; error?: string; sessionID?: string }>
  scorecard?: { attempts?: number; predecessors?: string[] }
  loop?: { resumedAt?: string; by?: string; alarm?: { at: string; fehler: string; anzahl: number } }
}

/** Herkunftsfelder eines Versuchs — ab dem ERSTEN Checkpoint gesetzt. */
export function herkunft(opts: { resumeRef?: string; checkpoint?: { id?: string; origin?: string }; vorige: string[] }): Pick<RunLog, "origin" | "resumeOf" | "retryOf"> {
  const out: Pick<RunLog, "origin" | "resumeOf" | "retryOf"> = {}
  if (opts.resumeRef !== undefined) {
    out.resumeOf = opts.resumeRef
    out.origin = opts.checkpoint?.origin ?? opts.checkpoint?.id ?? opts.resumeRef
  }
  if (opts.vorige.length > 0) {
    out.retryOf = opts.vorige[opts.vorige.length - 1]
    out.origin ??= opts.vorige[0]
  }
  return out
}

// Lauf-ID aus Ref oder Checkpoint-Pfad. Seit 12.10.2026 trägt die ID ein
// Zufallssuffix (runId() in engine.ts: run-<ISO>Z-<6 base36>); ohne die
// optionale Gruppe fiele es weg und die Familie zerfiele. Alt-IDs ohne Suffix
// matchen unverändert.
const idAusRef = (ref: string) => ref.match(/(run-[0-9T:.-]+Z(?:-[a-z0-9]+)?)/i)?.[1] ?? ref

/** Fehlertext eines Laufs, normalisiert (Leerraum), für den Serienvergleich. */
export function fehlertext(log: RunLog): string {
  const node = (log.nodes ?? []).find((n) => n?.status === "error" && typeof n.error === "string")
  return (node?.error ?? `status ${log.status}`).replace(/\s+/g, " ").trim().slice(0, 200)
}

/** Familien: Zusammenhangskomponenten über Herkunftsfelder und Session-IDs. */
export function familien(logs: RunLog[]): RunLog[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let p = parent.get(x) ?? x
    if (p !== x) { p = find(p); parent.set(x, p) }
    return p
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const knoten = (log: RunLog) => `id:${log.id.toLowerCase()}`
  for (const log of logs) {
    const k = knoten(log)
    parent.set(k, find(k))
    for (const ref of [log.origin, log.resumeOf, log.retryOf, ...(log.scorecard?.predecessors ?? [])]) if (ref) union(k, `id:${idAusRef(ref).toLowerCase()}`)
    for (const n of log.nodes ?? []) if (n?.sessionID) union(k, `ses:${n.sessionID}`)
  }
  const gruppen = new Map<string, RunLog[]>()
  for (const log of logs) {
    const r = find(knoten(log))
    gruppen.set(r, [...(gruppen.get(r) ?? []), log])
  }
  const zeit = (l: RunLog) => l.started ?? 0
  return [...gruppen.values()].map((g) => g.sort((a, b) => zeit(a) - zeit(b) || a.id.localeCompare(b.id)))
}

export interface Plan {
  heilen: Array<{ ursprung: string; quelle: string; heilung: number }>
  alarme: Array<{ ursprung: string; fehler: string; anzahl: number }>
}

/**
 * Was dieser Zyklus tut. `checkpoint(id)` liefert die mtime des Checkpoints
 * oder null — Resume-Material muss existieren und darf nicht frisch sein
 * (15 min: ein laufender Prozess schreibt noch).
 */
export function planeHeilung(logs: RunLog[], opts: {
  now: number
  pipelines: string[]
  maxAgeH: number
  checkpoint: (id: string) => number | null
  heilMax?: number
  serie?: number
}): Plan {
  const heilMax = opts.heilMax ?? HEIL_MAX
  const serie = opts.serie ?? SERIE_GLEICH
  const plan: Plan = { heilen: [], alarme: [] }
  for (const fam of familien(logs)) {
    const ursprung = fam[0]
    if (ursprung.status !== "error") continue // gestoppt/fertig: nichts zu heilen
    if (!opts.pipelines.includes(ursprung.pipeline ?? "")) continue
    if (fam.some((l) => l.status === "running")) continue // Heilung läuft noch
    const letzter = fam[fam.length - 1]
    if (letzter.status !== "error") continue // done = geheilt; stopped = von Hand beendet
    const finished = typeof letzter.finished === "number" ? letzter.finished : 0
    if (!finished || (opts.now - finished) / 3_600_000 > opts.maxAgeH) continue
    // Serie gleicher Fehlschläge: Heilung endet, ein Alarm je Ursprung.
    const fehler = fam.filter((l) => l.status === "error").map(fehlertext)
    const letzte = fehler.slice(-serie)
    if (letzte.length === serie && letzte.every((f) => f === letzte[0])) {
      if (!ursprung.loop?.alarm) plan.alarme.push({ ursprung: ursprung.id, fehler: letzte[0], anzahl: fehler.filter((f) => f === letzte[0]).length })
      continue
    }
    const bisher = fam.filter((l) => l.loop?.resumedAt).length
    if (bisher >= heilMax) continue
    // Quelle: der jüngste Lauf der Familie — er hält die meisten fertigen
    // Karten. Trägt er schon loop.resumedAt, ist seine Heilung unterwegs (der
    // neue Log ist noch nicht geschrieben): nicht ein zweites Mal starten.
    if (letzter.loop?.resumedAt) continue
    const mtime = opts.checkpoint(letzter.id)
    if (mtime === null || opts.now - mtime < 15 * 60_000) continue
    const quelle = letzter
    plan.heilen.push({ ursprung: ursprung.id, quelle: quelle.id, heilung: bisher + 1 })
  }
  return plan
}
