/**
 * T-04 (Plan „Autonomie 10/10", W2.4): Rückruf bei Reap und bei Stummheit.
 *
 * Ein abgeräumter Run endete bisher ohne jede Meldung — der häufigste Fall
 * (41 von 201 Runs). Die aufrufende opencode-Sitzung wartet dann für immer.
 * Jetzt postet der Reaper an genau DIE Sitzung, die im Ledger-Eintrag des
 * Starts steht (Zuordnung über denselben Eintrag, Red Team (c): nie in eine
 * fremde Sitzung), genau einmal, und fail-open.
 *
 * Der Dienst ist ein lokaler Fake (Bun.serve), der Methode, Pfad, Auth und
 * Body prüft. Ledger und service.json liegen in einem Temp-Verzeichnis —
 * nichts geht nach ~/.openflow oder an den echten Dienst.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rueckruf, zuordnung } from "./of-rueckruf"

const PROC = existsSync("/proc/self")

const PASSWORT = "geheim-test-7f3a"
type Post = { method: string; path: string; auth: string | null; body: any }
let posts: Post[] = []
let server: ReturnType<typeof Bun.serve>
let antwortStatus = 200

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      posts.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: await req.json().catch(() => null) })
      return new Response(antwortStatus === 200 ? "true" : "nein", { status: antwortStatus })
    },
  })
})
afterAll(() => server.stop(true))

let dir: string
let ledger: string
let service: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "of-rueckruf-"))
  ledger = join(dir, "ledger.jsonl")
  service = join(dir, "service.json")
  writeFileSync(service, JSON.stringify({ password: PASSWORT }))
  posts = []
  antwortStatus = 200
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = (extra: Record<string, string> = {}) => ({
  OPENFLOW_LEDGER: ledger,
  OPENFLOW_OPENCODE_SERVICE: service,
  OPENFLOW_OPENCODE_PORT: String(server.port),
  ...extra,
})
const zeile = (o: Record<string, unknown>) => appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n")
const ledgerZeilen = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

const START = Date.now() - 60 * 60_000
const run = (host: Record<string, unknown>, id = "run-T04") => ({ id, pipeline: "auto-orchestrator", status: "stopped", started: START, host })
const meldung = (r: any, art: "abgeraeumt" | "stumm" = "abgeraeumt") => ({ run: r, art, grund: "zombie — Prozess tot", checkpoint: `/tmp/openflow-checkpoint-${r.id}.json` })

describe("Zuordnung nur über denselben Ledger-Eintrag", () => {
  it("aufruf_id → Sitzung aus GENAU diesem Eintrag", () => {
    const e = [
      { event: "fabrik_run", session_id: "ses_FREMD", aufruf_id: "call_B", ts: new Date(START).toISOString() },
      { event: "fabrik_run", session_id: "ses_A", aufruf_id: "call_A", ts: new Date(START).toISOString() },
    ]
    expect(zuordnung(e, run({ pid: 4711, aufruf_id: "call_A" }))?.session_id).toBe("ses_A")
  })

  it("pid → fabrik_log mit derselben pid, nicht der jüngste fremde", () => {
    const e = [
      { event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711, ts: new Date(START).toISOString() },
      { event: "fabrik_log", session_id: "ses_FREMD", log: "/tmp/b.log", pid: 999, ts: new Date(START + 1000).toISOString() },
    ]
    expect(zuordnung(e, run({ pid: 4711 }))?.session_id).toBe("ses_A")
  })

  it("eine wiederverwendete pid aus einem anderen Zeitfenster ordnet nicht zu", () => {
    const e = [{ event: "fabrik_log", session_id: "ses_ALT", log: "/tmp/a.log", pid: 4711, ts: new Date(START - 3 * 86_400_000).toISOString() }]
    expect(zuordnung(e, run({ pid: 4711 }))).toBeNull()
  })

  it("Widerspruch zwischen Run und Eintrag → keine Zuordnung", () => {
    const e = [{ event: "fabrik_run", session_id: "ses_A", aufruf_id: "call_A", ts: new Date(START).toISOString() }]
    expect(zuordnung(e, run({ aufruf_id: "call_A", session: "ses_ANDERE" }))).toBeNull()
  })
})

describe("T-04 Rückruf an den Dienst (Fake)", () => {
  it("postet einmal an die richtige Sitzung: Methode, Pfad, Basic-Auth, Body", async () => {
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711 })
    const r = await rueckruf(meldung(run({ pid: 4711 })), { env: env() })
    expect(r.status).toBe("gesendet")
    expect(posts).toHaveLength(1)
    const p = posts[0]
    expect(p.method).toBe("POST")
    expect(p.path).toBe("/api/session/ses_A/synthetic")
    expect(p.auth).toBe(`Basic ${btoa(`opencode:${PASSWORT}`)}`)
    expect(p.body.description).toBe("openflow")
    expect(p.body.text).toContain("run-T04")
    expect(p.body.text).toContain("abgeräumt")
    expect(p.body.text).toContain("/tmp/openflow-checkpoint-run-T04.json")
    expect(ledgerZeilen().some((z) => z.event === "rueckruf" && z.run_id === "run-T04" && z.session_id === "ses_A")).toBe(true)
  })

  it("Gegenprobe: eine fremde Sitzung bekommt 0 Posts", async () => {
    zeile({ event: "fabrik_log", session_id: "ses_FREMD", log: "/tmp/b.log", pid: 999 })
    zeile({ event: "fabrik_run", session_id: "ses_FREMD", aufruf_id: "call_B" })
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711 })
    await rueckruf(meldung(run({ pid: 4711 })), { env: env() })
    await rueckruf(meldung(run({ aufruf_id: "call_X" }, "run-ohne")), { env: env() })
    expect(posts.filter((p) => p.path.includes("ses_FREMD"))).toHaveLength(0)
    expect(posts.map((p) => p.path)).toEqual(["/api/session/ses_A/synthetic"])
  })

  it("genau einmal: der zweite Aufruf derselben Meldung postet nicht", async () => {
    zeile({ event: "fabrik_run", session_id: "ses_A", aufruf_id: "call_A" })
    const m = meldung(run({ aufruf_id: "call_A" }))
    expect((await rueckruf(m, { env: env() })).status).toBe("gesendet")
    expect((await rueckruf(m, { env: env() })).status).toBe("schon_gemeldet")
    // eine ANDERE Art (stumm) desselben Runs ist eine eigene Meldung
    expect((await rueckruf({ ...m, art: "stumm" }, { env: env() })).status).toBe("gesendet")
    expect(posts).toHaveLength(2)
  })

  it("fail-open: Dienst nicht erreichbar → Ledger-Zeile mit Grund, kein Wurf, Passwort nirgends", async () => {
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711 })
    // ein Port, der sicher zu ist: kurz belegen, wieder freigeben
    const zu = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const port = zu.port
    zu.stop(true)
    const r = await rueckruf(meldung(run({ pid: 4711 })), { env: env({ OPENFLOW_OPENCODE_PORT: String(port) }) })
    expect(r.status).toBe("fehlgeschlagen")
    const f = ledgerZeilen().find((z) => z.event === "rueckruf_fehlgeschlagen")
    expect(f?.run_id).toBe("run-T04")
    expect(typeof f?.grund).toBe("string")
    expect(readFileSync(ledger, "utf8")).not.toContain(PASSWORT)
    expect(JSON.stringify(r)).not.toContain(PASSWORT)
  })

  it("HTTP-Fehler zählt als Fehlschlag, nicht als gesendet", async () => {
    antwortStatus = 401
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711 })
    const r = await rueckruf(meldung(run({ pid: 4711 })), { env: env() })
    expect(r.status).toBe("fehlgeschlagen")
    expect(r.grund).toContain("401")
  })

  it("fehlt service.json → Fehlschlag mit Grund, kein Post", async () => {
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: 4711 })
    const r = await rueckruf(meldung(run({ pid: 4711 })), { env: env({ OPENFLOW_OPENCODE_SERVICE: join(dir, "fehlt.json") }) })
    expect(r.status).toBe("fehlgeschlagen")
    expect(posts).toHaveLength(0)
  })

  it("ohne Zuordnung: kein Post, EINE Ledger-Zeile, danach still", async () => {
    const m = meldung(run({ pid: 4711 }))
    expect((await rueckruf(m, { env: env() })).status).toBe("keine_zuordnung")
    expect((await rueckruf(m, { env: env() })).status).toBe("schon_gemeldet")
    expect(posts).toHaveLength(0)
    expect(ledgerZeilen().filter((z) => z.event === "rueckruf_fehlgeschlagen")).toHaveLength(1)
  })

  it("im Testlauf ohne OPENFLOW_LEDGER: schreibt nirgendwohin (Schutz des echten Ledgers)", async () => {
    const r = await rueckruf(meldung(run({ pid: 4711 })), { env: { NODE_ENV: "test" } })
    expect(r.status).toBe("aus")
    expect(posts).toHaveLength(0)
  })
})

describe("T-04 über of-reap (Subprozess)", () => {
  const REAP = join(import.meta.dir, "of-reap.ts")
  const cps: string[] = []
  afterEach(() => {
    for (const c of cps.splice(0)) rmSync(c, { force: true })
  })
  // asynchron: spawnSync blockierte die Ereignisschleife DIESES Prozesses, in
  // dem auch der Fake-Dienst läuft — der Post hinge bis zum Timeout.
  const reap = async (runs: string) => {
    const p = Bun.spawn([process.execPath, REAP, "--runs-dir", runs], { env: { ...process.env, ...env() }, stdout: "pipe", stderr: "pipe" })
    await p.exited
    return { stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() }
  }
  const checkpoint = (id: string, alterMin: number) => {
    const p = `/tmp/openflow-checkpoint-${id}.json`
    writeFileSync(p, "{}")
    const t = new Date(Date.now() - alterMin * 60_000)
    utimesSync(p, t, t)
    cps.push(p)
  }

  // Lebendigkeit liest /proc — ohne /proc (Windows) ist jede PID „unbekannt".
  it.skipIf(!PROC)("Reap eines toten Runs → genau ein Post an die Start-Sitzung, auch beim zweiten Reap-Lauf", async () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const tot = Bun.spawn(["true"])
    await tot.exited
    const id = `rueckruf-${process.pid}-${Date.now()}`
    writeFileSync(join(runs, `${id}.json`), JSON.stringify({ id, pipeline: "auto-orchestrator", status: "running", started: Date.now() - 20 * 60_000, host: { pid: tot.pid } }))
    checkpoint(id, 15)
    zeile({ event: "fabrik_log", session_id: "ses_A", log: "/tmp/a.log", pid: tot.pid })
    zeile({ event: "fabrik_log", session_id: "ses_FREMD", log: "/tmp/b.log", pid: tot.pid + 100000 })
    await reap(runs)
    await reap(runs)
    expect(posts.map((p) => p.path)).toEqual(["/api/session/ses_A/synthetic"])
    expect(posts[0].body.text).toContain(id)
  })

  it.skipIf(!PROC)("Stumm: lebender Run > 45 min ohne Ende → eine Meldung, kein Reap", async () => {
    const runs = mkdtempSync(join(dir, "runs-"))
    const lebt = Bun.spawn(["bash", "-c", "sleep 60; true", "headless-run.ts"], { stdout: "ignore", stderr: "ignore" })
    try {
      const id = `stumm-${process.pid}-${Date.now()}`
      const file = join(runs, `${id}.json`)
      writeFileSync(file, JSON.stringify({ id, pipeline: "auto-orchestrator", status: "running", started: Date.now() - 50 * 60_000, host: { pid: lebt.pid, aufruf_id: "call_S" } }))
      checkpoint(id, 2)
      zeile({ event: "fabrik_run", session_id: "ses_S", aufruf_id: "call_S" })
      await reap(runs)
      await reap(runs)
      expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("running")
      expect(posts.map((p) => p.path)).toEqual(["/api/session/ses_S/synthetic"])
      expect(posts[0].body.text).toContain("ohne Ende")
    } finally {
      lebt.kill()
    }
  })
})
