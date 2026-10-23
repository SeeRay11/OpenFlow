/**
 * of-lebendig — WANN ein laufender Run abgeräumt werden darf. Eine Regel und
 * EINE Schwellen-Quelle für of-reap, of-loop (cron) und of-run.sh (Start).
 *
 * Anlass (Plan „Autonomie 10/10", W2.1, 23.10.2026): of-loop reapte nach
 * 10 min stummem Checkpoint, of-run.sh nach 15 min — zwei Zahlen, beide unter
 * dem Karten-Timeout der Engine (30 min, engine.ts DEFAULT_NODE_TIMEOUT).
 * Seit dem Hänger-Fix (12.10.2026) beendet der Reaper einen LEBENDEN
 * headless-run per SIGTERM; eine Karte mit einem 25-min-Werkzeugaufruf wurde
 * damit mitten im Lauf erschossen.
 *
 * Warum Stille allein nichts beweist: Die Engine schreibt den Checkpoint nur
 * bei einer Änderung (Patch), nicht im Takt. Eine Karte, die an EINEM langen
 * Zug arbeitet, ist still — und lebt. Was die Engine dagegen zusichert: Jeder
 * Zug beginnt mit einem Patch (→ Checkpoint) und endet spätestens nach dem
 * Karten-Timeout mit einem weiteren. Ein lebender Prozess, der länger als
 * Timeout + Puffer still ist, hat seine eigene Zusage gebrochen — DAS ist ein
 * Hänger. Ein toter Prozess dagegen schreibt nie wieder; ihn abzuräumen ist
 * nach kurzer Grace ehrlich.
 *
 * Gemessen vor dem Fix (flow-lab/.openflow/runs, 201 Runs, 41 gereapt):
 * 25 der 41 hatten zum Reap eine laufende Karte innerhalb ihrer 30 min —
 * aber bei keinem davon ist ein Lebenszeichen nach der Stille belegt
 * (Details: packages/flow/docs/AUTONOMIE_10_10_SPEC.md, §W2-Messung).
 */

/** Karten-Timeout der Engine in Minuten — lebendig.test.ts hält es gegen engine.ts. */
export const KARTEN_TIMEOUT_MIN = 30
/** Spielraum über dem Karten-Timeout: Rate-Limit-Backoff, Checkpoint-Takt, Uhren. */
export const PUFFER_MIN = 5
/** Stille, ab der ein LEBENDER (oder unbekannter) Prozess als Hänger gilt. */
export const REAP_SCHWELLE_MIN = KARTEN_TIMEOUT_MIN + PUFFER_MIN
/** Grace für einen Run, dessen Prozess nachweislich tot ist (bzw. ohne Checkpoint). */
export const TOT_SCHWELLE_MIN = 5
/** Ein Run ohne Ende nach so vielen Minuten wird der aufrufenden Sitzung gemeldet. */
export const STUMM_MELDUNG_MIN = 45

export type PidStatus = "lebt" | "tot" | "unbekannt"

export interface ReapLage {
  jetzt: number
  started: number
  /** Späteste Aktivität: Checkpoint-mtime oder Karten-Zeitstempel. */
  letzteAktivitaet: number
  hatCheckpoint: boolean
  pid: PidStatus
  /** Stille-Schwelle für Prozesse unbekannten Zustands (Vorgabe REAP_SCHWELLE_MIN). */
  minAgeMin?: number
  /** Grace für tote Prozesse und fehlenden Checkpoint (Vorgabe TOT_SCHWELLE_MIN). */
  graceMin?: number
}

export interface ReapUrteil {
  reapen: boolean
  grund: string
  /** zombie = Prozess tot/unbekannt; haenger = Prozess lebt, aber über Timeout + Puffer still. */
  art: "zombie" | "haenger" | "lebt"
}

/**
 * Das Urteil. Ein lebender Prozess wird NIE innerhalb von Karten-Timeout +
 * Puffer abgeräumt — auch nicht mit einer kleineren --min-age-min.
 */
export function reapUrteil(l: ReapLage): ReapUrteil {
  const minAge = Number.isFinite(l.minAgeMin) ? (l.minAgeMin as number) : REAP_SCHWELLE_MIN
  const grace = Number.isFinite(l.graceMin) ? (l.graceMin as number) : TOT_SCHWELLE_MIN
  const stillMin = (l.jetzt - l.letzteAktivitaet) / 60_000
  const r = (n: number) => Math.round(n)

  if (l.pid === "lebt") {
    const schwelle = Math.max(minAge, REAP_SCHWELLE_MIN)
    if (stillMin > schwelle) {
      return { reapen: true, art: "haenger", grund: `haenger — Prozess lebt, aber seit ${r(stillMin)} min still (Karten-Timeout ${KARTEN_TIMEOUT_MIN} + Puffer ${PUFFER_MIN} min)` }
    }
    return { reapen: false, art: "lebt", grund: `lebt — Prozess lebt, ${r(stillMin)} min still (Schwelle ${schwelle} min)` }
  }

  if (!l.hatCheckpoint) {
    const seitStart = (l.jetzt - l.started) / 60_000
    if (seitStart > grace) {
      return { reapen: true, art: "zombie", grund: `zombie — kein Checkpoint, Run startete vor ${r(seitStart)} min (Grace ${grace} min)` }
    }
    return { reapen: false, art: "lebt", grund: `frisch — kein Checkpoint, Start vor ${r(seitStart)} min` }
  }

  if (l.pid === "tot") {
    if (stillMin > grace) {
      return { reapen: true, art: "zombie", grund: `zombie — Prozess tot, checkpoint seit ${r(stillMin)} min stumm (Grace ${grace} min)` }
    }
    return { reapen: false, art: "lebt", grund: `Prozess tot, erst ${r(stillMin)} min still (Grace ${grace} min)` }
  }

  if (stillMin > minAge) {
    return { reapen: true, art: "zombie", grund: `zombie — checkpoint seit ${r(stillMin)} min stumm (Schwelle ${minAge} min, Prozess unbekannt)` }
  }
  return { reapen: false, art: "lebt", grund: `still seit ${r(stillMin)} min (Schwelle ${minAge} min)` }
}
