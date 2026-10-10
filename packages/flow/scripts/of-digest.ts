/**
 * of-digest — Hebel 3: täglicher Kandidaten-Digest für den Loop.
 *
 * Der Loop (of-loop.ts) heilt Runs und prüft Invarianten, meldet aber nicht,
 * wenn das fabrik-gate-Plugin über Tage FABRIK-Empfehlungen in das Ledger
 * schreibt, ohne dass je eine Fabrik läuft (gemessen: 11 Kandidaten in
 * 6 Tagen, 0 Runs). Die Scorecard-Regeltreue sieht das erst auf manuellen
 * Abruf — der Dauerbetrieb braucht eine einmal-tägliche Erinnerung.
 *
 * Ein Zyklus pro Tag (gesteuert über <digest-dir>/digest-last.date):
 *   - Ledger der letzten 7 Tage scannen
 *   - FABRIK-Entscheidungen (und GRAUZONE mitzählen), zu denen KEIN
 *     chronologisch passender fabrik_run-Eintrag existiert
 *   - Digest schreiben: <digest-dir>/digest-YYYY-MM-DD.md
 *   - eine Konsolen-Zeile zurückgeben, die of-loop in seinen Output legt
 *     (damit loop-check das Versäumnis sieht).
 *
 * „Passend" ist ein fabrik_run, dessen ts NACH der Empfehlung liegt — jeder
 * Run verbraucht sich für genau einen Kandidaten (1:1, greedy aufsteigend),
 * damit ein einzelner Run nicht eine Woche alter Empfehlungen deckt.
 *
 * Reine Berechnung (buildFabrikDigest) und FS-Wrapper (runDailyDigest) sind
 * getrennt — Tests fahren die Berechnung mit Inline-Ledger-Zeilen und den
 * Wrapper gegen Temp-Verzeichnisse, nie gegen ~/.openflow.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FENSTER_TAGE = 7
const DAY_MS = 24 * 3_600_000

export interface DigestEintrag {
  zeilen: string[]
  fabrikOhneRun: number
  grauzoneOhneRun: number
  summe: number
  fensterVon: string
  fensterBis: string
}

export interface DigestResult {
  tag: string
  datei: string
  zeile: string
  eintrag: DigestEintrag
}

const parseTs = (v: unknown): number | null => {
  if (typeof v !== "string") return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** Reine Berechnung: welche FABRIK/GRAUZONE-Empfehlungen im 7-Tage-Fenster blieben ohne Fabrik-Run? */
export function buildFabrikDigest(entries: unknown[], now: Date): DigestEintrag {
  const nowMs = now.getTime()
  const von = nowMs - FENSTER_TAGE * DAY_MS
  const imFenster = (entries.filter((e) => !!e) as any[])
    .map((e) => ({ e, ts: parseTs(e?.ts) }))
    .filter((x) => x.ts !== null && x.ts >= von && x.ts <= nowMs)
  const kandidaten = imFenster
    .filter((x) => x.e?.event === "task" && (x.e?.entscheidung === "FABRIK" || x.e?.entscheidung === "GRAUZONE"))
    .sort((a, b) => (a.ts as number) - (b.ts as number))
  const runs = imFenster
    .filter((x) => x.e?.event === "fabrik_run")
    .map((x) => x.ts as number)
    .sort((a, b) => a - b)

  const zeilen: string[] = []
  let fabrikOhneRun = 0
  let grauzoneOhneRun = 0
  for (const k of kandidaten) {
    const idx = runs.findIndex((r) => r >= (k.ts as number))
    if (idx >= 0) {
      runs.splice(idx, 1) // Run verbraucht sich — 1:1, nicht ein Run deckt alle
      continue
    }
    const datum = new Date(k.ts as number).toISOString().slice(0, 10)
    const signale = Array.isArray(k.e?.signale) && k.e.signale.length ? k.e.signale.join(", ") : "k.A."
    if (k.e?.entscheidung === "FABRIK") {
      fabrikOhneRun++
      zeilen.push(`FABRIK-Empfehlung ohne Run: ${datum} ${signale}`)
    } else {
      grauzoneOhneRun++
      zeilen.push(`GRAUZONE-Empfehlung ohne Run: ${datum} ${signale}`)
    }
  }
  return {
    zeilen,
    fabrikOhneRun,
    grauzoneOhneRun,
    summe: fabrikOhneRun + grauzoneOhneRun,
    fensterVon: new Date(von).toISOString().slice(0, 10),
    fensterBis: new Date(nowMs).toISOString().slice(0, 10),
  }
}

/**
 * Einmal pro Tag: Digest-Datei + State schreiben, Konsolen-Zeile liefern.
 * Rückgabe null, wenn der heutige Digest schon geschrieben wurde
 * (keine Wiederholung am selben Tag). Fehlendes Ledger → Digest mit Summe 0.
 */
export function runDailyDigest(dir: string, ledgerPath: string, now: Date): DigestResult | null {
  const tag = now.toISOString().slice(0, 10)
  const stateFile = join(dir, "digest-last.date")
  if (existsSync(stateFile)) {
    try {
      if (readFileSync(stateFile, "utf8").trim() === tag) return null
    } catch { /* unlesbarer State → neu schreiben */ }
  }
  let entries: unknown[] = []
  if (existsSync(ledgerPath)) {
    entries = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    })
  }
  const eintrag = buildFabrikDigest(entries, now)
  mkdirSync(dir, { recursive: true })
  const datei = join(dir, `digest-${tag}.md`)
  const inhalt = [
    `# OpenFlow Kandidaten-Digest — ${tag}`,
    "",
    `Fenster: ${eintrag.fensterVon} … ${eintrag.fensterBis} (${FENSTER_TAGE} Tage), Ledger: ${ledgerPath}`,
    "",
    ...(eintrag.zeilen.length ? eintrag.zeilen : ["Keine FABRIK/GRAUZONE-Empfehlung ohne Fabrik-Run im Fenster."]),
    "",
    `Summe: ${eintrag.summe} ohne Run (FABRIK: ${eintrag.fabrikOhneRun}, GRAUZONE: ${eintrag.grauzoneOhneRun})`,
    "",
  ].join("\n")
  const tmp = `${datei}.tmp`
  writeFileSync(tmp, inhalt)
  writeFileSync(stateFile, tag)
  renameSync(tmp, datei)
  const zeile =
    `of-loop DIGEST ${tag}: ${eintrag.fabrikOhneRun} FABRIK- und ${eintrag.grauzoneOhneRun} GRAUZONE-Empfehlung(en) ohne Fabrik-Run` +
    ` (${FENSTER_TAGE}-Tage-Fenster, Summe ${eintrag.summe}) — ${datei}`
  return { tag, datei, zeile, eintrag }
}
