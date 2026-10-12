/**
 * of-guard.ts — bricht ab, wenn ein Fabrik-Run aus einer Fabrik-Karte heraus
 * gestartet werden soll (Begründung: lib/fabrik-guard.ts). of-run.sh ruft es
 * vor jedem Run-Start auf; Monitoring (--scorecard, --nutzung, --reap, …)
 * läuft vorher ab und wird nie geprüft.
 *
 * Exit 0 = Start erlaubt · Exit 3 = verschachtelter Start, Meldung auf stderr.
 */
import { ABLEHNUNG, verschachtelterStart, vorfahrenAus } from "../lib/fabrik-guard"

const grund = verschachtelterStart(process.env, vorfahrenAus(process.pid))
if (grund) {
  console.error(
    `of-run.sh: ${ABLEHNUNG} — ${grund}. Eine Karte läuft bereits IN der Fabrik; ` +
      `erledige den Auftrag selbst oder über deine Worker-Karten, starte keinen weiteren Run.`,
  )
  process.exit(3)
}
