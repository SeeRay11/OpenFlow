/**
 * wecken.ts — W0 (AUTONOMIE_10_10_SPEC §3, T-06): weckt die Fertig-Meldung
 * eines Hintergrund-Auftrags die ruhende Eltern-Sitzung?
 *
 * Der Hauptfaden startet zwei Hintergrund-Aufträge (Weg `subagent` oder
 * `shell`), sagt „WARTE AUF 2" und beendet seinen Turn. Bestanden heißt: Nach
 * der ersten `synthetic`-Nachricht (der Fertig-Meldung) antwortet er von
 * selbst mit „FERTIG <code 1> <code 2>" — ohne Nutzereingabe, ohne sleep.
 *
 *   bun bench/wecken.ts --server http://127.0.0.1:PORT (--passwort-datei F | --service-json F)
 *                       --weg subagent|shell --modell provider/modell [--frist 240] [--verzeichnis DIR]
 *
 * Ausgabe: EINE JSON-Zeile. Ziel laut Plan: 3/3 je Weg.
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Nachricht, OpencodeApi, aufrufe, flags, liesPasswort, textVon } from "./lib"

export const CODE_A = "ALPHA-7341"
export const CODE_B = "BETA-5528"

export function auftrag(weg: "subagent" | "shell"): string {
  const start =
    weg === "subagent"
      ? `Starte in EINEM Schritt genau zwei Subagenten (agent "general") mit background: true. ` +
        `Auftrag 1: "Fuehre den Shell-Befehl \`sleep 20; echo ${CODE_A}\` aus und gib nur die Ausgabe zurueck." ` +
        `Auftrag 2: "Fuehre den Shell-Befehl \`sleep 25; echo ${CODE_B}\` aus und gib nur die Ausgabe zurueck." `
      : `Starte genau zwei Shell-Befehle mit background: true (nicht im Vordergrund): ` +
        `\`sleep 20; echo ${CODE_A}\` und \`sleep 25; echo ${CODE_B}\`. `
  return (
    start +
    "Warte NICHT, kein sleep, keine Abfrage. Beende deinen Turn sofort mit genau: WARTE AUF 2. " +
    "Sobald die Ergebnisse als Nachricht eintreffen, antworte mit: FERTIG <code 1> <code 2>."
  )
}

/** Befund aus den Nachrichten (zeitlich sortiert). */
export function bewerteWecken(ms: Nachricht[]) {
  const typen = ms.map((m) => m.type)
  const erst = typen.indexOf("synthetic")
  const istFertig = (m: Nachricht) => m.type === "assistant" && textVon(m).includes("FERTIG")
  const vollstaendig = (m: Nachricht) => istFertig(m) && textVon(m).includes(CODE_A) && textVon(m).includes(CODE_B)
  return {
    typen,
    synthetic: typen.filter((t) => t === "synthetic").length,
    assistant_nach_synthetic: erst < 0 ? 0 : typen.slice(erst + 1).filter((t) => t === "assistant").length,
    fertig_nach_wecken: erst >= 0 && ms.slice(erst).some(vollstaendig),
    fertig_vorweg: (erst < 0 ? ms : ms.slice(0, erst)).some(istFertig),
    warte_gesagt: ms.some((m) => m.type === "assistant" && textVon(m).includes("WARTE AUF 2")),
    werkzeuge: aufrufe(ms).map((a) => [a.tool, a.bg]),
  }
}

async function main() {
  const f = flags(process.argv.slice(2))
  const server = f.wert("--server")
  const weg = f.wert("--weg") as "subagent" | "shell"
  const modell = f.wert("--modell")
  if (!server || !modell || !["subagent", "shell"].includes(weg)) throw new Error("--server, --weg subagent|shell und --modell sind Pflicht")
  const frist = Number(f.wert("--frist", "240"))
  const verzeichnis = f.wert("--verzeichnis", join(dirname(import.meta.path), "laeufe", "wecken"))!
  mkdirSync(verzeichnis, { recursive: true })
  const api = new OpencodeApi(server, liesPasswort({ passwortDatei: f.wert("--passwort-datei"), serviceJson: f.wert("--service-json") }))

  const sid = await api.neueSitzung({ verzeichnis, agent: "build", modell })
  const t0 = Date.now()
  await api.prompt(sid, auftrag(weg))
  let befund = bewerteWecken([])
  while (Date.now() - t0 < frist * 1000) {
    await Bun.sleep(5000)
    befund = bewerteWecken(await api.nachrichten(sid))
    if (befund.fertig_nach_wecken) break
  }
  console.log(JSON.stringify({ weg, modell, session: sid, dauer_s: Math.round((Date.now() - t0) / 100) / 10, ...befund }))
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(2)
  })
}
