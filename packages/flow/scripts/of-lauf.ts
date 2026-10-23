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

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { PidStatus } from "./of-lebendig"

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

/**
 * Lebt der Prozess eines Runs? „unbekannt", wenn der Run keine PID trägt (vor
 * dem 12.10.2026) oder das System kein /proc hat — dann entscheidet die
 * Stille-Schwelle, nicht eine Vermutung.
 */
export function pidStatus(pid: unknown, procDa = existsSync("/proc/self")): PidStatus {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return "unbekannt"
  if (!procDa) return "unbekannt"
  return lebenderLauf(pid) !== undefined ? "lebt" : "tot"
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

/**
 * Das Projekt, dessen `.openflow/runs` Reaper, of-loop und Scorecard lesen
 * (W2.5, 23.10.2026). headless-run lädt Pipelines NICHT selbst, sondern über
 * den Canvas (`GET /flow/api/pipelines/:name`) — also aus dem Projekt, auf das
 * der Canvas gerade zeigt (OPENFLOW_PROJECT, sonst ~/.openflow/state.json,
 * sonst das Repo). state.json zeigte am 23.10. auf mcp-workers, wo es keinen
 * auto-orchestrator gibt; der laufende Canvas trug OPENFLOW_PROJECT=flow-lab
 * und lief deshalb richtig. Ein Ordnerwechsel im Canvas hätte jeden
 * Fabrik-Run auf 404 oder — schlimmer — in ein Runs-Verzeichnis gelenkt, das
 * kein Reaper liest.
 */
export function fabrikProjekt(env: Record<string, string | undefined> = process.env): string {
  if (env.OPENFLOW_FABRIK_PROJEKT) return resolve(env.OPENFLOW_FABRIK_PROJEKT)
  if (env.OPENFLOW_RUNS_DIR) return resolve(dirname(dirname(env.OPENFLOW_RUNS_DIR)))
  return join(homedir(), "workspace/flow-lab")
}

/**
 * Prüft das aktive Canvas-Projekt gegen das Fabrik-Projekt. `fehler` heißt:
 * nicht starten (Pipeline fehlt dort); `warnung` heißt: der Lauf geht, aber
 * Reaper/Rückruf/Scorecard sehen ihn nicht.
 */
export function projektPruefung(o: {
  aktiv: string | undefined
  erwartet: string
  pipeline: string
  pipelineDa: boolean
  existiertImErwarteten?: (pfad: string) => boolean
}): { fehler?: string; warnung?: string } {
  const aktiv = o.aktiv ? resolve(o.aktiv) : undefined
  const gleich = aktiv === resolve(o.erwartet)
  const dortDa = (o.existiertImErwarteten ?? existsSync)(join(o.erwartet, ".openflow", "pipelines", `${o.pipeline}.json`))
  if (!o.pipelineDa) {
    const wo = aktiv ?? "(unbekannt)"
    const hilfe = !gleich && dortDa
      ? ` — sie liegt in ${o.erwartet}; Canvas mit OPENFLOW_PROJECT=${o.erwartet} starten (openflow-autostart.sh) oder dort im Canvas den Ordner wechseln`
      : ""
    return { fehler: `Pipeline "${o.pipeline}" fehlt im aktiven Canvas-Projekt ${wo}${hilfe}` }
  }
  if (aktiv && !gleich) {
    return {
      warnung: `Canvas-Projekt ${aktiv} ≠ Fabrik-Projekt ${o.erwartet}: dieser Lauf landet in ${aktiv}/.openflow/runs — Reaper, Rückruf und Scorecard lesen ${o.erwartet}/.openflow/runs und sehen ihn nicht`,
    }
  }
  return {}
}
