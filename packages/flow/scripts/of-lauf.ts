/**
 * of-lauf — Lebenszeichen eines Runs, als reine Funktionen geteilt von
 * of-reap (Zombie-Reaper) und headless-run (Resume).
 *
 * K11 (Abnahme R20, 13.10.2026): Ein Resume setzte den abgebrochenen Vorgänger
 * nie auf ein Ende. Er stand bis zum nächsten Reaper-Durchgang (Schwelle
 * 30 min) als RUNNING in der Scorecard — neben seinem eigenen Nachfolger.
 * `vorgaengerStoppen` schließt ihn beim Resume-Start, mit Verweis auf den
 * Nachfolger; ein Vorgänger, dessen headless-run-Prozess noch lebt, bleibt
 * unberührt (das ist Sache des Reapers).
 */

import { readFileSync } from "node:fs"

/** Der Prozess lebt und ist ein headless-run — eine fremde, wiederverwendete PID wird nie getroffen. */
export function lebenderLauf(pid: unknown): number | undefined {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    return cmd.includes("headless-run.ts") ? pid : undefined
  } catch {
    return undefined
  }
}

/** Letzte Aktivität eines Run-Logs: Start oder spätester Karten-Zeitstempel. */
export function letzteAktivitaet(log: any): number {
  let last = typeof log?.started === "number" ? log.started : 0
  for (const node of Array.isArray(log?.nodes) ? log.nodes : []) {
    for (const t of [node?.started, node?.finished]) if (typeof t === "number" && t > last) last = t
  }
  return last
}

/**
 * Der Vorgänger eines Resume als beendeter Lauf — oder `undefined`, wenn nichts
 * zu tun ist (nicht `running`, oder sein Prozess lebt noch). Liefert eine Kopie.
 */
export function vorgaengerStoppen(
  vorgaenger: any,
  nachfolgerId: string,
  lebt: (pid: unknown) => boolean = (pid) => lebenderLauf(pid) !== undefined,
  now = Date.now(),
): any | undefined {
  if (vorgaenger?.status !== "running") return undefined
  if (lebt(vorgaenger?.host?.pid)) return undefined
  return {
    ...vorgaenger,
    status: "stopped",
    error: `abgebrochen — fortgesetzt als ${nachfolgerId}`,
    finished: letzteAktivitaet(vorgaenger),
    resumedBy: nachfolgerId,
    stoppedByResume: { at: new Date(now).toISOString(), by: nachfolgerId },
  }
}
