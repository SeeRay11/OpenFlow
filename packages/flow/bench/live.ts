/**
 * live.ts — Abnahme eines echten Auftrags gegen den laufenden Dienst.
 *
 * Anders als bench.ts läuft das gegen den Live-Dienst (Standard :49374,
 * Passwort aus ~/.config/opencode/service.json): Es prüft das Verhalten im
 * Betrieb, mit den echten Anweisungen. Der Sitzungstitel beginnt IMMER mit
 * „abnahme-live" — woche.ts schließt solche Sitzungen aus der Messwoche aus
 * und zählt sie getrennt.
 *
 *   bun bench/live.ts --auftrag "…" | --auftrag-datei F
 *                     [--kontrollwert WERT]…  (jeder muss im Schlussbericht stehen)
 *                     [--server http://127.0.0.1:49374] [--service-json F | --passwort-datei F]
 *                     [--verzeichnis DIR] [--titel "abnahme-live …"] [--agent build] [--frist 900]
 *
 * Ausgabe: Verlauf (Zeit, Typ, Text/Werkzeug) und als LETZTE Zeile eine
 * JSON-Zeile mit Kennzahlen und Kontrollwert-Treffern. Exit 1, wenn ein
 * Kontrollwert fehlt.
 */
import { readFileSync } from "node:fs"
import { type Nachricht, OpencodeApi, aufrufe, fanoutKennzahlen, flags, liesPasswort, textVon } from "./lib"

export function abnahmeTitel(titel: string | undefined, jetzt = new Date()): string {
  const t = titel?.trim() || `abnahme-live ${jetzt.toISOString().slice(0, 10)}`
  return /^abnahme-live\b/i.test(t) ? t : `abnahme-live ${t}`
}

/** Welche Kontrollwerte stehen im Schlussbericht (letzte Assistant-Nachricht)? */
export function kontrollwerteImSchluss(ms: Nachricht[], werte: string[]): Record<string, boolean> {
  const assistant = ms.filter((m) => m.type === "assistant")
  const schluss = textVon(assistant[assistant.length - 1])
  return Object.fromEntries(werte.map((w) => [w, schluss.includes(w)]))
}

function verlauf(ms: Nachricht[]): string[] {
  const t0 = ms[0]?.time?.created ?? 0
  return ms.flatMap((m) => {
    const ts = Math.round(((m.time?.created ?? t0) - t0) / 1000)
    const teile = (m.content ?? []).flatMap((c: any) => {
      if (c?.type === "text") return [`${ts} ${m.type} TEXT ${String(c.text ?? "").slice(0, 700).replaceAll("\n", " ¶ ")}`]
      if (c?.type !== "tool") return []
      const i = c.state?.input ?? {}
      return [`${ts} ${m.type} TOOL ${c.name} bg=${Boolean(i.background)} ${String(i.command ?? i.description ?? "").slice(0, 90)}`]
    })
    return teile.length ? teile : m.type === "synthetic" ? [`${ts} synthetic ${String(m.text ?? "").slice(0, 90)}`] : []
  })
}

async function main() {
  const f = flags(process.argv.slice(2))
  const datei = f.wert("--auftrag-datei")
  const auftrag = datei ? readFileSync(datei, "utf8") : f.wert("--auftrag")
  if (!auftrag) throw new Error("--auftrag oder --auftrag-datei ist Pflicht")
  const werte = f.alle("--kontrollwert")
  const api = new OpencodeApi(
    f.wert("--server", "http://127.0.0.1:49374")!,
    liesPasswort({ passwortDatei: f.wert("--passwort-datei"), serviceJson: f.wert("--service-json") }),
  )
  const sid = await api.neueSitzung({
    verzeichnis: f.wert("--verzeichnis", process.cwd()),
    titel: abnahmeTitel(f.wert("--titel")),
    agent: f.wert("--agent", "build"),
  })
  const sitzung = (await api.rufe(`/${sid}`)).data
  console.log(`session ${sid} modell ${JSON.stringify(sitzung?.model ?? null)}`)
  const t0 = Date.now()
  await api.prompt(sid, auftrag)
  const dauer = await api.warteAufRuhe(sid, t0, Number(f.wert("--frist", "900")))
  const ms = await api.nachrichten(sid)
  for (const z of verlauf(ms)) console.log(z)
  const treffer = kontrollwerteImSchluss(ms, werte)
  const k = fanoutKennzahlen(ms)
  console.log(
    JSON.stringify({
      session: sid,
      dauer_s: dauer,
      kinder: (await api.kinder(sid)).length,
      nutzer_nachrichten: ms.filter((m) => m.type === "user").length,
      synthetic: ms.filter((m) => m.type === "synthetic").length,
      ...k,
      werkzeuge: aufrufe(ms).length,
      kontrollwerte: treffer,
      alle_korrekt: Object.values(treffer).every(Boolean),
    }),
  )
  if (!Object.values(treffer).every(Boolean)) process.exit(1)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(2)
  })
}
