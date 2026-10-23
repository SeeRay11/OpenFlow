/**
 * bench.ts — W4-Autonomie-Benchmark (AUTONOMIE_10_10_SPEC §6 W4, T-07).
 *
 * Misst, ob der Hauptfaden von SELBST im Hintergrund auffächert. Die Aufträge
 * nennen weder `background` noch Subagenten — das ist der Punkt. Jeder Lauf
 * bekommt eine frische Fixture-Kopie (fixture.sh, Kontrollwerte im Kopf der
 * Datei) und schreibt EINE JSON-Zeile nach stdout.
 *
 *   bun bench/bench.ts --server http://127.0.0.1:PORT (--passwort-datei F | --service-json F)
 *                      --aufgabe B1|B2|B4 --modell provider/modell --lauf N
 *                      [--frist 900] [--laeufe-dir DIR]
 *
 * Nachrechnen ohne Modelllauf (gleiche Regeln, Nachrichten aus einer opencode.db):
 *   bun bench/bench.ts --auswerten --db PFAD --session ses_… --aufgabe B1 [--modell …] [--lauf N]
 *
 * NIE gegen den Live-Dienst fahren — siehe README.md („Grenzen").
 */
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import {
  type Nachricht,
  type Soll,
  OpencodeApi,
  aufrufe,
  fanoutKennzahlen,
  flags,
  liesPasswort,
  pruefeKontrollwerte,
  textVon,
} from "./lib"

export const AUFGABEN: Record<string, { auftrag: string; soll: Soll }> = {
  B1: {
    auftrag:
      "Prüfe die Pakete alpha, beta und gamma in diesem Repo: Führe in jedem Paket ./pruefe.sh aus " +
      "(im jeweiligen Paketordner) und zähle die TODO-Zeilen in dessen src/. Berichte am Ende eine Tabelle " +
      "Paket | ERGEBNIS-Code | TODO-Anzahl.",
    soll: { alpha: ["A-4417", 3], beta: ["B-9062", 5], gamma: ["G-1385", 2] },
  },
  B2: {
    auftrag:
      "Im Paket delta schlägt ./pruefe.sh fehl. Finde und behebe den Fehler in delta/src und bestätige " +
      "den Fix mit ./pruefe.sh. Führe außerdem ./pruefe.sh in alpha, beta und gamma aus. " +
      "Berichte am Ende alle vier ERGEBNIS-Codes.",
    soll: { delta: ["D-7720", null], alpha: ["A-4417", null], beta: ["B-9062", null], gamma: ["G-1385", null] },
  },
  B4: {
    auftrag:
      "Führe ./pruefe.sh in den Paketen epsilon und gamma aus (jeweils im Paketordner) und berichte " +
      "beide ERGEBNIS-Codes.",
    soll: { epsilon: ["E-3051", null], gamma: ["G-1385", null] },
  },
}

/** Die Bewertung eines Laufs aus seinen Nachrichten — eine Regel für Live und Nachrechnen. */
export function bewerteLauf(aufgabe: string, ms: Nachricht[], fixOk: boolean | null) {
  const a = AUFGABEN[aufgabe]
  if (!a) throw new Error(`unbekannte Aufgabe ${aufgabe}`)
  const assistant = ms.filter((m) => m.type === "assistant")
  const treffer = pruefeKontrollwerte(textVon(assistant[assistant.length - 1]), a.soll)
  const k = fanoutKennzahlen(ms, "pruefe.sh")
  const alle = aufrufe(ms)
  return {
    nutzer_nachrichten: ms.filter((m) => m.type === "user").length,
    synthetic: ms.filter((m) => m.type === "synthetic").length,
    arbeitsaufrufe: k.arbeitsaufrufe,
    davon_bg: k.davon_bg,
    fanouts: k.fanouts,
    fanouts_bg: k.fanouts_bg,
    max_parallel_in_einer_nachricht: k.max_parallel_in_einer_nachricht,
    sleep_poll: k.warte_abfragen,
    kontrollwerte: treffer,
    alle_korrekt: Object.values(treffer).every(Boolean) && fixOk !== false,
    fix_ok: fixOk,
    werkzeuge: alle.slice(0, 40).map((x) => [x.tool, x.bg]),
  }
}

function fixPruefen(aufgabe: string, ziel: string): boolean | null {
  if (aufgabe !== "B2") return null
  const r = spawnSync("node", ["-e", "console.log(require('./src/rechne.js').add(2,3))"], {
    cwd: join(ziel, "delta"),
    encoding: "utf8",
  })
  return r.stdout.trim() === "5"
}

function nachrichtenAusDb(db: string, sid: string): Nachricht[] {
  const d = new Database(db, { readonly: true })
  const rows = d.query("select type, data from session_message where session_id = ? order by seq").all(sid) as any[]
  d.close()
  return rows.map((r) => ({ ...JSON.parse(r.data), type: r.type }))
}

async function main() {
  const f = flags(process.argv.slice(2))
  const aufgabe = f.wert("--aufgabe") ?? ""
  const modell = f.wert("--modell", "")!
  const nr = f.wert("--lauf", "1")!
  if (!AUFGABEN[aufgabe]) throw new Error(`--aufgabe ${Object.keys(AUFGABEN).join("|")} fehlt`)

  if (f.hat("--auswerten")) {
    const db = f.wert("--db")
    const sid = f.wert("--session")
    if (!db || !sid) throw new Error("--auswerten braucht --db und --session")
    const ziel = f.wert("--verzeichnis")
    const ms = nachrichtenAusDb(db, sid)
    console.log(JSON.stringify({ aufgabe, modell, nr, session: sid, nachgerechnet: true, ...bewerteLauf(aufgabe, ms, ziel ? fixPruefen(aufgabe, ziel) : null) }))
    return
  }

  const server = f.wert("--server")
  if (!server || !modell) throw new Error("--server und --modell sind Pflicht")
  const frist = Number(f.wert("--frist", "900"))
  const api = new OpencodeApi(server, liesPasswort({ passwortDatei: f.wert("--passwort-datei"), serviceJson: f.wert("--service-json") }))
  const hier = dirname(import.meta.path)
  const ziel = join(f.wert("--laeufe-dir", join(hier, "laeufe"))!, `${aufgabe}-${modell.replaceAll("/", "_")}-${nr}`)
  const fx = spawnSync("bash", [join(hier, "fixture.sh"), ziel], { encoding: "utf8" })
  if (fx.status !== 0) throw new Error(`fixture.sh: ${fx.stderr}`)

  const sid = await api.neueSitzung({ verzeichnis: ziel, agent: "build", modell })
  const t0 = Date.now()
  await api.prompt(sid, AUFGABEN[aufgabe].auftrag)
  const dauer = await api.warteAufRuhe(sid, t0, frist)
  const ms = await api.nachrichten(sid)
  console.log(JSON.stringify({ aufgabe, modell, nr, session: sid, dauer_s: dauer, ...bewerteLauf(aufgabe, ms, fixPruefen(aufgabe, ziel)) }))
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(2)
  })
}
