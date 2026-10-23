/**
 * woche.ts — die Wochenanalyse (AUTONOMIE_10_10_SPEC §10 W5) in EINEM Befehl.
 *
 * Vier Abschnitte über ein Zeitfenster [von 00:00 UTC, bis 24:00 UTC]:
 *   1. opencode.db  Sitzungen/Tag, Assistant-Nachrichten, Modelle (Latenz
 *                   p50/p90, Fehler), Modellfehler, Tool-Fehlerquote, Anteil
 *                   dharma — einmal GESAMT (vergleichbar mit der Auswertung
 *                   vom 23.10.) und einmal FELD (ohne Benchmark-, Job-Temp-,
 *                   abnahme-live- und Testsitzungen).
 *   2. Autonomie    je Hauptfaden-Sitzung (agent build/plan/fabrik, ohne
 *                   Eltern): Fan-outs (Nachrichten mit ≥ 2 Arbeitsaufrufen),
 *                   davon ganz im Hintergrund, Warte-Abfragen (sleep/poll),
 *                   Nutzer-Nachrichten. Regeln: lib.ts.
 *   3. Fabrik       Scorecard-Runs, deren Start im Fenster liegt
 *                   (of-scorecard.ts --json), dazu Auto-Resume-Ledger ohne
 *                   `ses_test*`-Zeilen.
 *   4. dharma       Analytics Engine (dharma_metrics) und D1 (request_log)
 *                   — nur mit Cloudflare-Zugang; sonst steht dort UNGEPRÜFT,
 *                   nie „ok".
 *
 * Die opencode.db wird nur lesend geöffnet.
 *
 *   bun bench/woche.ts --von 2026-10-16 --bis 2026-10-23 [--json]
 *        [--db ~/.local/share/opencode/opencode.db] [--runs-dir DIR] [--ledger F]
 *        [--auto-resume ~/.openflow/auto-resume.jsonl] [--ohne-dharma]
 */
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  type Nachricht,
  type SitzungsKopf,
  ausschlussGrund,
  fanoutKennzahlen,
  flags,
  istTestZeile,
  prozent,
  quantil,
} from "./lib"

const TAG = 86_400_000
export const HAUPTFADEN_AGENTEN = new Set(["build", "plan", "fabrik"])

export interface Fenster {
  von: number
  bis: number
  vonTag: string
  bisTag: string
}

/** `--bis` ist der letzte Tag EINSCHLIESSLICH: 16.–23.10. heißt [16.10. 00:00, 24.10. 00:00). */
export function fensterAus(von: string, bis: string): Fenster {
  const v = Date.parse(`${von}T00:00:00Z`)
  const b = Date.parse(`${bis}T00:00:00Z`) + TAG
  if (Number.isNaN(v) || Number.isNaN(b) || b <= v) throw new Error(`ungültiges Fenster ${von} … ${bis}`)
  return { von: v, bis: b, vonTag: von, bisTag: new Date(b).toISOString().slice(0, 10) }
}

const tagVon = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/* ───────────────────────── 1. opencode.db ───────────────────────── */

interface Topf {
  sitzungen: number
  haupt: number
  sub: number
  jeTag: Record<string, { sitzungen: number; sub: number; assistant: number; fehler: number }>
  nutzer: number
  assistant: number
  modellfehler: number
  dharma: number
  tools: number
  toolFehler: number
  modelle: Map<string, { n: number; sub: number; fehler: number; lat: number[] }>
  fehlerArten: Map<string, number>
  toolFehlerJe: Map<string, number>
}

const neuerTopf = (): Topf => ({
  sitzungen: 0,
  haupt: 0,
  sub: 0,
  jeTag: {},
  nutzer: 0,
  assistant: 0,
  modellfehler: 0,
  dharma: 0,
  tools: 0,
  toolFehler: 0,
  modelle: new Map(),
  fehlerArten: new Map(),
  toolFehlerJe: new Map(),
})

const zaehle = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

function tag(t: Topf, d: string) {
  t.jeTag[d] ??= { sitzungen: 0, sub: 0, assistant: 0, fehler: 0 }
  return t.jeTag[d]
}

function topfBericht(t: Topf) {
  return {
    sitzungen: t.sitzungen,
    hauptfaden: t.haupt,
    sub: t.sub,
    nutzer_nachrichten: t.nutzer,
    assistant_nachrichten: t.assistant,
    modellfehler: t.modellfehler,
    modellfehler_pct: prozent(t.modellfehler, t.assistant, 2),
    dharma_pct: prozent(t.dharma, t.assistant),
    tool_aufrufe: t.tools,
    tool_fehler: t.toolFehler,
    tool_fehler_pct: prozent(t.toolFehler, t.tools, 2),
    je_tag: t.jeTag,
    modelle: [...t.modelle.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([modell, m]) => ({
        modell,
        n: m.n,
        sub: m.sub,
        fehler: m.fehler,
        p50_s: quantil(m.lat, 0.5),
        p90_s: quantil(m.lat, 0.9),
      })),
    fehler_arten: [...t.fehlerArten.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    tool_fehler_je_tool: [...t.toolFehlerJe.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  }
}

export function auswertungOpencode(db: Database, f: Fenster) {
  const sitzungen = db
    .query("select id, parent_id, directory, title, agent, time_created from session_v2")
    .all() as (SitzungsKopf & { agent: string | null; time_created: number })[]
  const alle = new Map(sitzungen.map((s) => [s.id, s]))
  const grund = new Map(sitzungen.map((s) => [s.id, ausschlussGrund(s, alle)]))
  const gesamt = neuerTopf()
  const feld = neuerTopf()
  const ausgeschlossen: Record<string, { sitzungen: number; assistant: number }> = {}
  const toepfe = (sid: string) => (grund.get(sid) ? [gesamt] : [gesamt, feld])

  for (const s of sitzungen) {
    if (s.time_created < f.von || s.time_created >= f.bis) continue
    const g = grund.get(s.id)
    if (g) {
      ausgeschlossen[g] ??= { sitzungen: 0, assistant: 0 }
      ausgeschlossen[g].sitzungen++
    }
    for (const t of toepfe(s.id)) {
      t.sitzungen++
      if (s.parent_id) t.sub++
      else t.haupt++
      const d = tag(t, tagVon(s.time_created))
      d.sitzungen++
      if (s.parent_id) d.sub++
    }
  }

  const nutzer = db
    .query("select session_id, count(*) n from session_message where type = 'user' and time_created >= ? and time_created < ? group by session_id")
    .all(f.von, f.bis) as { session_id: string; n: number }[]
  for (const r of nutzer) for (const t of toepfe(r.session_id)) t.nutzer += r.n

  const istSub = (sid: string) => Boolean(alle.get(sid)?.parent_id)
  for (const r of db
    .query("select session_id, time_created, data from session_message where type = 'assistant' and time_created >= ? and time_created < ?")
    .iterate(f.von, f.bis) as Iterable<{ session_id: string; time_created: number; data: string }>) {
    const j = JSON.parse(r.data)
    const k = `${j.model?.providerID}/${j.model?.id}`
    const g = grund.get(r.session_id)
    if (g) {
      ausgeschlossen[g] ??= { sitzungen: 0, assistant: 0 }
      ausgeschlossen[g].assistant++
    }
    for (const t of toepfe(r.session_id)) {
      t.assistant++
      tag(t, tagVon(r.time_created)).assistant++
      if (j.model?.providerID === "dharma") t.dharma++
      const m = t.modelle.get(k) ?? { n: 0, sub: 0, fehler: 0, lat: [] }
      t.modelle.set(k, m)
      m.n++
      if (istSub(r.session_id)) m.sub++
      if (j.time?.completed && j.time?.created) m.lat.push((j.time.completed - j.time.created) / 1000)
      if (j.error) {
        t.modellfehler++
        m.fehler++
        tag(t, tagVon(r.time_created)).fehler++
        zaehle(t.fehlerArten, `${j.error.type ?? j.error.name}: ${String(j.error.message ?? j.error.data?.message ?? "").slice(0, 80)}`)
      }
      for (const p of j.content ?? []) {
        if (p?.type !== "tool") continue
        t.tools++
        if (p.state?.status !== "error") continue
        t.toolFehler++
        zaehle(t.toolFehlerJe, p.name)
      }
    }
  }
  return { gesamt: topfBericht(gesamt), feld: topfBericht(feld), ausgeschlossen }
}

/* ───────────────────────── 2. Autonomie im Feld ───────────────────────── */

export function auswertungAutonomie(db: Database, f: Fenster) {
  const sitzungen = db
    .query("select id, parent_id, directory, title, agent, time_created from session_v2")
    .all() as (SitzungsKopf & { agent: string | null; time_created: number })[]
  const alle = new Map(sitzungen.map((s) => [s.id, s]))
  const haupt = sitzungen.filter(
    (s) => !s.parent_id && HAUPTFADEN_AGENTEN.has(s.agent ?? "") && s.time_created >= f.von && s.time_created < f.bis,
  )
  const ausgeschlossen: Record<string, number> = {}
  const nachrichten = db.query("select type, data from session_message where session_id = ? and time_created >= ? and time_created < ? order by seq")
  const zeilen = haupt.flatMap((s) => {
    const g = ausschlussGrund(s, alle)
    if (g) {
      ausgeschlossen[g] = (ausgeschlossen[g] ?? 0) + 1
      return []
    }
    const ms: Nachricht[] = (nachrichten.all(s.id, f.von, f.bis) as { type: string; data: string }[]).map((r) =>
      r.type === "assistant" ? { ...JSON.parse(r.data), type: r.type } : { type: r.type },
    )
    return [{ id: s.id, agent: s.agent, titel: (s.title ?? "").slice(0, 60), nutzer: ms.filter((m) => m.type === "user").length, ...fanoutKennzahlen(ms) }]
  })
  const summe = (k: keyof (typeof zeilen)[number]) => zeilen.reduce((a, z) => a + Number(z[k]), 0)
  const nutzer = zeilen.map((z) => z.nutzer)
  return {
    sitzungen: zeilen.length,
    ausgeschlossen,
    fanouts: summe("fanouts"),
    fanouts_bg: summe("fanouts_bg"),
    fanouts_bg_pct: prozent(summe("fanouts_bg"), summe("fanouts")),
    arbeitsaufrufe: summe("arbeitsaufrufe"),
    arbeitsaufrufe_bg_pct: prozent(summe("davon_bg"), summe("arbeitsaufrufe")),
    warte_abfragen: summe("warte_abfragen"),
    nutzer_je_sitzung_median: quantil(nutzer, 0.5),
    nutzer_je_sitzung_mittel: zeilen.length ? Number((summe("nutzer") / zeilen.length).toFixed(1)) : null,
    je_sitzung: zeilen,
  }
}

/* ───────────────────────── 3. Fabrik ───────────────────────── */

export function auswertungAutoResume(zeilen: string[], f: Fenster) {
  const ereignisse: Record<string, number> = {}
  let test = 0
  for (const z of zeilen) {
    if (!z.trim()) continue
    const e = (() => {
      try {
        return JSON.parse(z)
      } catch {
        return null
      }
    })()
    const ts = Date.parse(e?.ts ?? "")
    if (!e || Number.isNaN(ts) || ts < f.von || ts >= f.bis) continue
    if (istTestZeile(e)) {
      test++
      continue
    }
    const k = e.event === "resume_ende" ? `resume_ende:${e.ergebnis}` : String(e.event)
    ereignisse[k] = (ereignisse[k] ?? 0) + 1
  }
  return { ereignisse, test_zeilen_ausgeschlossen: test }
}

function auswertungFabrik(f: Fenster, o: { runsDir?: string; ledger?: string; autoResume: string }) {
  const skript = join(dirname(import.meta.path), "..", "scripts", "of-scorecard.ts")
  const args = [skript, "--json", "--limit", "1000000"]
  if (o.runsDir) args.push("--runs-dir", o.runsDir)
  if (o.ledger) args.push("--ledger", o.ledger)
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  const scorecard = (() => {
    if (r.status !== 0) return { status: "UNGEPRÜFT", grund: `of-scorecard.ts Exit ${r.status}: ${(r.stderr ?? "").slice(0, 200)}` }
    const runs = (JSON.parse(r.stdout).runs as any[]).filter((x) => {
      const t = Date.parse(x.started ?? "")
      return !Number.isNaN(t) && t >= f.von && t < f.bis
    })
    const verdicts: Record<string, number> = {}
    for (const x of runs) verdicts[x.verdict] = (verdicts[x.verdict] ?? 0) + 1
    const pass = (verdicts.PASS ?? 0) + (verdicts.PASS_RETRIED ?? 0)
    return { status: "gemessen", runs: runs.length, verdicts, pass_pct: prozent(pass, runs.length), abgeraeumt: runs.filter((x) => x.reaped).length }
  })()
  const autoResume = existsSync(o.autoResume)
    ? { status: "gemessen", ...auswertungAutoResume(readFileSync(o.autoResume, "utf8").split("\n"), f) }
    : { status: "UNGEPRÜFT", grund: `${o.autoResume} fehlt` }
  return { scorecard, auto_resume: autoResume }
}

/* ───────────────────────── 4. dharma ───────────────────────── */

function cfToken(): string | null {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const p = join(homedir(), ".config/.wrangler/config/default.toml")
  if (!existsSync(p)) return null
  return readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/)?.[1] ?? null
}

async function cf(token: string, pfad: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${pfad}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} ${pfad.split("?")[0]}: ${text.slice(0, 160)}`)
  return text
}

export function dharmaAusAe(zeilen: { anbieter: string; ausgang: string; n: number | string }[]) {
  const n = zeilen.reduce((a, z) => a + Number(z.n), 0)
  const fehl = zeilen.filter((z) => z.ausgang !== "ok").reduce((a, z) => a + Number(z.n), 0)
  const jeAnbieter: Record<string, Record<string, number>> = {}
  for (const z of zeilen) {
    jeAnbieter[z.anbieter] ??= {}
    jeAnbieter[z.anbieter][z.ausgang] = Number(z.n)
  }
  return { anfragen: n, fehlversuche: fehl, fehlversuche_pct: prozent(fehl, n, 2), je_anbieter: jeAnbieter }
}

type D1Zeile = { provider: string; versuch: number | null; ttfb_ms: number | null; total_ms: number | null; ttft_ms?: number | null }

/**
 * D1 request_log. TTFB ist nur dann eine eigene Messung, wenn sie sich von der
 * Gesamtdauer unterscheidet: Vor dharma 0.7.0 schrieb der Strom-Weg
 * ttfb_ms = total_ms (Abnahme 23.10.2026, Befund D) — „TTFB gemessen N" hätte
 * dann N Gesamtdauern als TTFB ausgegeben. Eine Zeile mit ttfb == total (auf
 * die Millisekunde) trägt keine eigene TTFB; die TTFB-Quantile rechnen deshalb
 * NUR über Zeilen mit ttfb != total, und `ttfb_n` sagt, über wie viele.
 * Status: `nicht_getrennt` (keine solche Zeile) · `teilweise` · `getrennt`.
 * Gemessen 16.–23.10.2026: 16 von 16 540 Zeilen getrennt — ohne diese Regel
 * stünden 16 524 Gesamtdauern als TTFB-p50 in der Tabelle.
 * `ttft_ms` (erstes Token, dharma ≥ 0.7.0) wird getrennt gezählt.
 */
export function dharmaAusD1(rows: D1Zeile[]) {
  const g = new Map<string, D1Zeile[]>()
  for (const r of rows) g.set(r.provider, [...(g.get(r.provider) ?? []), r])
  const zahlen = (a: (number | null | undefined)[]) => a.filter((x): x is number => typeof x === "number")
  const failover = rows.filter((r) => (r.versuch ?? 1) > 1).length
  const beide = rows.filter((r) => typeof r.ttfb_ms === "number" && typeof r.total_ms === "number")
  const getrennt = beide.filter((r) => r.ttfb_ms !== r.total_ms).length
  const ttfb_status: "getrennt" | "teilweise" | "nicht_getrennt" | "keine" =
    beide.length === 0 ? "keine" : getrennt === 0 ? "nicht_getrennt" : getrennt < beide.length ? "teilweise" : "getrennt"
  const eigeneTtfb = (a: D1Zeile[]) => zahlen(a.filter((r) => typeof r.ttfb_ms === "number" && r.ttfb_ms !== r.total_ms).map((r) => r.ttfb_ms))
  const ttfbQ = (a: D1Zeile[], q: number) => quantil(eigeneTtfb(a), q)
  return {
    anfragen: rows.length,
    failover,
    failover_pct: prozent(failover, rows.length, 2),
    ttfb_gemessen: zahlen(rows.map((r) => r.ttfb_ms)).length,
    ttfb_status,
    ttfb_getrennt: getrennt,
    ttft_gemessen: zahlen(rows.map((r) => r.ttft_ms)).length,
    je_anbieter: [...g.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([anbieter, a]) => ({
        anbieter,
        n: a.length,
        ttfb_n: eigeneTtfb(a).length,
        ttfb_p50: ttfbQ(a, 0.5),
        ttfb_p90: ttfbQ(a, 0.9),
        ttft_p50: quantil(zahlen(a.map((r) => r.ttft_ms)), 0.5),
        ttft_p90: quantil(zahlen(a.map((r) => r.ttft_ms)), 0.9),
        total_p50: quantil(zahlen(a.map((r) => r.total_ms)), 0.5),
        total_p90: quantil(zahlen(a.map((r) => r.total_ms)), 0.9),
        versuch_gt1: a.filter((r) => (r.versuch ?? 1) > 1).length,
      })),
  }
}

/** Die D1-Kopfzeile des Berichts — TTFB und TTFT ehrlich getrennt. */
export function d1Kopfzeile(d1: ReturnType<typeof dharmaAusD1>): string {
  const ttfb =
    d1.ttfb_status === "nicht_getrennt"
      ? `TTFB nicht getrennt erfasst (Altdaten: ttfb_ms = total_ms in allen ${d1.ttfb_gemessen} Zeilen)`
      : d1.ttfb_status === "keine"
        ? "TTFB nicht erfasst"
        : d1.ttfb_status === "teilweise"
          ? `TTFB getrennt erfasst nur in ${d1.ttfb_getrennt} von ${d1.ttfb_gemessen} Zeilen (übrige Altdaten: ttfb_ms = total_ms; TTFB-Quantile nur über die getrennten)`
          : `TTFB getrennt gemessen ${d1.ttfb_getrennt} von ${d1.ttfb_gemessen}`
  const ttft = d1.ttft_gemessen > 0 ? `TTFT (erstes Token) gemessen ${d1.ttft_gemessen}` : "TTFT nicht erfasst (Spalte ttft_ms leer oder fehlt, dharma < 0.7.0)"
  return `D1: ${d1.anfragen} Anfragen, Failover (versuch > 1) ${d1.failover} (${d1.failover_pct} %; Ziel < 5 %), ${ttfb}, ${ttft}`
}

async function auswertungDharma(f: Fenster) {
  const token = cfToken()
  if (!token) return { ae: { status: "UNGEPRÜFT", grund: "kein Cloudflare-Zugang (CLOUDFLARE_API_TOKEN / wrangler login)" }, d1: { status: "UNGEPRÜFT", grund: "kein Cloudflare-Zugang" } }
  const konto = await (async () => {
    if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
    const a = JSON.parse(await cf(token, "/accounts")).result as { id: string }[]
    if (a.length !== 1) throw new Error(`${a.length} Konten sichtbar — CLOUDFLARE_ACCOUNT_ID setzen`)
    return a[0].id
  })().catch((e) => e as Error)
  if (konto instanceof Error) return { ae: { status: "UNGEPRÜFT", grund: konto.message }, d1: { status: "UNGEPRÜFT", grund: konto.message } }

  const sqlZeit = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")
  const ae = await cf(token, `/accounts/${konto}/analytics_engine/sql`, {
    method: "POST",
    body:
      `SELECT blob3 AS anbieter, blob5 AS ausgang, sum(_sample_interval) AS n FROM dharma_metrics ` +
      `WHERE timestamp >= toDateTime('${sqlZeit(f.von)}') AND timestamp < toDateTime('${sqlZeit(f.bis)}') ` +
      `GROUP BY anbieter, ausgang FORMAT JSON`,
  })
    .then((t) => ({ status: "gemessen", ...dharmaAusAe(JSON.parse(t).data) }))
    .catch((e: Error) => ({ status: "UNGEPRÜFT", grund: e.message }))

  const d1 = await (async () => {
    const liste = JSON.parse(await cf(token, `/accounts/${konto}/d1/database?name=dharma-log`)).result as { uuid: string; name: string }[]
    const db = liste.find((d) => d.name === "dharma-log")
    if (!db) throw new Error("D1 dharma-log nicht gefunden")
    const frage = (spalten: string) =>
      cf(token, `/accounts/${konto}/d1/database/${db.uuid}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: `SELECT ${spalten} FROM request_log WHERE ts >= ? AND ts < ?`, params: [f.vonTag, f.bisTag] }),
      })
    // ttft_ms gibt es erst ab dharma 0.7.0; eine ältere Tabelle ohne die
    // Spalte darf die ganze Auswertung nicht auf UNGEPRÜFT kippen.
    const t = await frage("provider, versuch, ttfb_ms, total_ms, ttft_ms").catch((e: Error) => {
      if (/no such column/i.test(e.message)) return frage("provider, versuch, ttfb_ms, total_ms")
      throw e
    })
    return { status: "gemessen", ...dharmaAusD1(JSON.parse(t).result[0].results) }
  })().catch((e: Error) => ({ status: "UNGEPRÜFT", grund: e.message }))
  return { ae, d1 }
}

/* ───────────────────────── Ausgabe ───────────────────────── */

function zeigeTopf(name: string, t: ReturnType<typeof topfBericht>) {
  console.log(`\n### ${name}`)
  console.log(`Sitzungen ${t.sitzungen} (Hauptfaden ${t.hauptfaden}, Sub ${t.sub}) · Nutzer-Nachrichten ${t.nutzer_nachrichten} · Assistant-Nachrichten ${t.assistant_nachrichten}`)
  console.log(`Modellfehler ${t.modellfehler} (${t.modellfehler_pct} %) · dharma-Anteil ${t.dharma_pct} % · Tool-Aufrufe ${t.tool_aufrufe}, Fehler ${t.tool_fehler} (${t.tool_fehler_pct} %)`)
  console.log("| Tag | Sitzungen | davon Sub | Assistant | Modellfehler |\n|---|---|---|---|---|")
  for (const [d, v] of Object.entries(t.je_tag).sort()) console.log(`| ${d} | ${v.sitzungen} | ${v.sub} | ${v.assistant} | ${v.fehler} |`)
  console.log("| Modell | Nachr. | davon Sub | p50 s | p90 s | Fehler |\n|---|---|---|---|---|---|")
  for (const m of t.modelle.slice(0, 15)) console.log(`| ${m.modell} | ${m.n} | ${m.sub} | ${m.p50_s?.toFixed(1) ?? "-"} | ${m.p90_s?.toFixed(1) ?? "-"} | ${m.fehler} |`)
  if (t.fehler_arten.length) console.log(`Fehlerarten: ${t.fehler_arten.map(([k, n]) => `${n}× ${k}`).join(" · ")}`)
  if (t.tool_fehler_je_tool.length) console.log(`Tool-Fehler je Tool: ${t.tool_fehler_je_tool.map(([k, n]) => `${k} ${n}`).join(" · ")}`)
}

const statusZeile = (x: any) => (x.status === "gemessen" ? "" : `UNGEPRÜFT — ${x.grund}`)

async function main() {
  const fl = flags(process.argv.slice(2))
  const von = fl.wert("--von")
  const bis = fl.wert("--bis")
  if (!von || !bis) throw new Error("--von JJJJ-MM-TT und --bis JJJJ-MM-TT sind Pflicht (bis = letzter Tag einschließlich)")
  const f = fensterAus(von, bis)
  const pfad = fl.wert("--db", join(homedir(), ".local/share/opencode/opencode.db"))!
  if (!existsSync(pfad)) throw new Error(`${pfad} fehlt`)
  const db = new Database(pfad, { readonly: true })
  const opencode = auswertungOpencode(db, f)
  const autonomie = auswertungAutonomie(db, f)
  db.close()
  const fabrik = auswertungFabrik(f, {
    runsDir: fl.wert("--runs-dir"),
    ledger: fl.wert("--ledger"),
    autoResume: fl.wert("--auto-resume", process.env.OPENFLOW_AUTO_RESUME_LEDGER ?? join(homedir(), ".openflow/auto-resume.jsonl"))!,
  })
  const dharma = fl.hat("--ohne-dharma")
    ? { ae: { status: "UNGEPRÜFT", grund: "--ohne-dharma" }, d1: { status: "UNGEPRÜFT", grund: "--ohne-dharma" } }
    : await auswertungDharma(f)
  const bericht = { fenster: { von: f.vonTag, bis_ausschliesslich: f.bisTag }, opencode, autonomie, fabrik, dharma }
  if (fl.hat("--json")) {
    console.log(JSON.stringify(bericht, null, 2))
    return
  }

  console.log(`## Wochenanalyse ${f.vonTag} bis ${bis} (UTC, bis einschließlich)`)
  console.log(`\n## 1. opencode.db (${pfad}, nur lesend)`)
  zeigeTopf("GESAMT (vergleichbar mit der Auswertung vom 23.10.)", opencode.gesamt)
  zeigeTopf("FELD (ohne Benchmark/Job-Temp/abnahme-live/Test)", opencode.feld)
  console.log(`\nAusgeschlossen: ${JSON.stringify(opencode.ausgeschlossen)}`)

  const a = autonomie
  console.log(`\n## 2. Autonomie im Feld — ${a.sitzungen} Hauptfaden-Sitzungen (build/plan/fabrik)`)
  console.log(`Fan-outs ${a.fanouts}, davon ganz im Hintergrund ${a.fanouts_bg} (${a.fanouts_bg_pct ?? "-"} %; Ziel ≥ 80 %)`)
  console.log(`Arbeitsaufrufe ${a.arbeitsaufrufe}, davon background ${a.arbeitsaufrufe_bg_pct ?? "-"} % · Warte-Abfragen (sleep/poll) ${a.warte_abfragen} (Ziel 0)`)
  console.log(`Nutzer-Nachrichten je Sitzung: Median ${a.nutzer_je_sitzung_median ?? "-"}, Mittel ${a.nutzer_je_sitzung_mittel ?? "-"}`)
  console.log(`Ausgeschlossene Hauptfaden-Sitzungen: ${JSON.stringify(a.ausgeschlossen)}`)
  console.log("| Sitzung | Agent | Nutzer | Arbeit | bg | Fan-outs | davon bg | Warte | Titel |\n|---|---|---|---|---|---|---|---|---|")
  for (const z of a.je_sitzung) console.log(`| ${z.id} | ${z.agent} | ${z.nutzer} | ${z.arbeitsaufrufe} | ${z.davon_bg} | ${z.fanouts} | ${z.fanouts_bg} | ${z.warte_abfragen} | ${z.titel} |`)

  console.log("\n## 3. Fabrik")
  const sc = fabrik.scorecard as any
  console.log(sc.status === "gemessen" ? `Runs im Fenster ${sc.runs} · PASS ${sc.pass_pct ?? "-"} % · ${JSON.stringify(sc.verdicts)} · abgeräumt ${sc.abgeraeumt}` : statusZeile(sc))
  const ar = fabrik.auto_resume as any
  console.log(ar.status === "gemessen" ? `Auto-Resume: ${JSON.stringify(ar.ereignisse)} · Testzeilen ausgeschlossen ${ar.test_zeilen_ausgeschlossen}` : statusZeile(ar))

  console.log("\n## 4. dharma")
  const ae = dharma.ae as any
  console.log(ae.status === "gemessen" ? `AE: ${ae.anfragen} Anfragen, Fehlversuche ${ae.fehlversuche} (${ae.fehlversuche_pct} %; Ziel < 2 %) · ${JSON.stringify(ae.je_anbieter)}` : `AE: ${statusZeile(ae)}`)
  const d1 = dharma.d1 as any
  if (d1.status !== "gemessen") console.log(`D1: ${statusZeile(d1)}`)
  else {
    console.log(d1Kopfzeile(d1))
    console.log("| Anbieter | n | TTFB n | TTFB p50 | TTFB p90 | TTFT p50 | TTFT p90 | gesamt p50 | gesamt p90 | versuch>1 |\n|---|---|---|---|---|---|---|---|---|---|")
    for (const x of d1.je_anbieter) console.log(`| ${x.anbieter} | ${x.n} | ${x.ttfb_n} | ${x.ttfb_p50 ?? "-"} | ${x.ttfb_p90 ?? "-"} | ${x.ttft_p50 ?? "-"} | ${x.ttft_p90 ?? "-"} | ${x.total_p50 ?? "-"} | ${x.total_p90 ?? "-"} | ${x.versuch_gt1} |`)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(2)
  })
}
