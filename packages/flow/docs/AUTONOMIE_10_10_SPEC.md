# Autonomie 10/10 in opencode + OpenFlow + dharma — Plan v1.0

**Datum:** 23.10.2026 · **Status:** W0 bestanden (18/18) · W1, W2, W3 umgesetzt · W4 gemessen · W5 (Messwoche 24.–30.10.) offen · **unabhängige Abnahme 23.10.2026: 2/10, Runde 2: 2/10** (Feld-Nachweis UNGEPRÜFT; ohne ihn wäre dharma mit 5 das schwächste Glied) — Einzelheiten im Abschnitt „Stand nach der Abnahme“ am Ende

Quelle: freigegebener Plan v1.0 vom 23.10.2026, unverändert übernommen; ergänzt sind die Messwerte aus W2.1 (Abschnitt „W2 — Messung und Umsetzung" am Ende) und Korrekturen, wo die Messung eine Annahme verschoben hat.

## 1. Kontext

Ziel: Der opencode-Hauptfaden soll so lange allein durchlaufen wie Claude Code. Dazu gehört Folgendes:
- unabhängige Teile parallel im Hintergrund starten und weiterarbeiten;
- die Ergebnisse kommen von selbst zurück, ohne Abfragen;
- der Hauptfaden urteilt und prüft stichprobenartig gegen;
- eine unabhängige Abnahme vergibt die Note.

Die Wochenanalyse vom 16. bis 23.10. ergab 6/10. Die Ursachen liegen nicht im fehlenden Können, sondern in Konfiguration, Anweisungen und zwei Defekten.

Entscheidungen des Betreibers vom 23.10.:
- Der Hauptfaden läuft über dharma.
- Claude über antigravity wird nicht getestet.
- Ich darf den Dienst und die Engine neu starten, nach Ankündigung im Text.

Läuft parallel und ist **nicht** Teil dieses Plans: der dharma-Fix-Strang (tote Modellnamen, Canary, authgrund, TTFT). Er ist Vorbedingung für die Messphase W5.

## 2. Annahmen (Phase 1/2, verifiziert durch 3 Explore-Läufe)

| # | Annahme | Status | Beleg |
|---|---|---|---|
| A1 | opencode hat Hintergrund-Subagenten | **VERIFIED**: v2.1.4, `subagent{background:true}` → sofort `running`, Ende als `session.synthetic` an die Eltern | Binary-Schema, Funktion `s2` |
| A2 | Diese Fertig-Meldung weckt eine ruhende Eltern-Sitzung (neuer Turn) | **Code: ja** (`wake` ohne `resume:false`), **live UNGEPRÜFT** | Binary `Session.synthetic … wake` |
| A3 | Ein Shell-Befehl im Hintergrund meldet sein Ende ebenfalls | VERIFIED im Code (`ShellTool.notifyWhenDone`, kein Timeout bei background), live UNGEPRÜFT | Binary `hA=120000` |
| A4 | Ein externer Prozess kann in eine Sitzung posten | VERIFIED: `POST :49374/api/session/:id/synthetic`, Basic Auth aus `service.json`; das Shell-Werkzeug setzt `OPENCODE_SESSION_ID` | Binary-Routen |
| A5 | Ein Fabrik-Run kennt seine Aufrufer-Sitzung | VERIFIED: `OPENFLOW_SESSION` wird von fabrik-gate exportiert; die Ledger-Zeile `fabrik_log` ordnet Log→Session zu | fabrik-gate.ts:382, :368 |
| A6 | Fabrik-Runs scheitern vor allem am Modell | **WIDERLEGT**: 41/201 Runs wurden vom Reaper abgeräumt. Er griff nach 10 Minuten ohne Checkpoint (`of-loop.ts:61`), das Karten-Timeout liegt bei 30 Minuten (`engine.ts:231`). **Nachmessung W2.1:** Die Reaps trafen belegt 36 von 41 tote Läufe, 5 unbestimmt, 0 nachweislich lebende — „Hauptursache Reaper" ist damit nicht belegt; die Schwelle war trotzdem falsch (siehe §W2) | Auswertung `flow-lab/.openflow/runs` |
| A7 | Hauptsitzungen laufen per Konfiguration auf zai | **WIDERLEGT**: Ursache ist die gespeicherte TUI-Modellwahl in `~/.local/state/opencode/model.json`; der Guard prüft `zai` nicht | guard.ts:309-326 |
| A8 | Die Anweisungen verlangen Hintergrund-Arbeit | **WIDERLEGT**: build.md/AGENTS.md verlangen synchrones Auffächern; `background` steht nur in command/frage.md; `direktiven/` wird nie geladen | AGENTS.md:25-41, opencode.jsonc:19-25 |
| A9 | `of-run.sh --wait` liefert den Exit-Code des Runs | **WIDERLEGT**: wegen `\|\| true` immer 0 — **behoben in W2.3** | of-run.sh:129 |
| A10 | Ein Run-Ende läuft immer durch einen Abschlusspunkt | **WIDERLEGT**: headless-run hat keinen SIGTERM-Handler, ein Reap bzw. Kill hinterlässt kein Ergebnis; auch das reguläre Ende schrieb keine `ergebnis.md` (nur den Bericht nach stdout) — **behoben in W2.2** | headless-run.ts:65 |
| A11 | Es gibt Messdaten zur Langlauf-Qualität der Modelle | **WIDERLEGT**: nur externe Benchmarks (glm-5.2 MCP-Atlas 77); kein eigener Agentik-Test | modelle-bewerten.mjs:5-10 |
| A12 | Der opencode-Dienst läuft | UNGEPRÜFT/eher nein: Port 49374 frei, `service.json` zeigt v2.0.32 bei installiertem Binary 2.1.4 | Explore 1 |
| A13 | Die Plugin-Typen (2.0.26) passen zum Binary 2.1.4 | UNGEPRÜFT → wird im Spike mitgemessen | package.json |

## 3. Spike (riskantester Punkt): **W0**

**RISKANTESTER PUNKT:** A2/A3, also ob eine ruhende Hauptsitzung nach der Fertig-Meldung von selbst einen neuen Turn startet und das Ergebnis verwertet. Erst dann besteht die gesamte Architektur aus vorhandenen Bausteinen.

**SPIKE-TYP:** Code-Spike als erster Umsetzungsschritt. Der Planmodus verbietet den Lauf jetzt.
- `opencode run --standalone` in einem Wegwerf-Ordner (nicht über den Dienst, sonst bläht er auf).
- Agent build auf dharma/balanced.
- Auftrag: „starte 2 Hintergrund-Subagenten (je ein `sleep 20; echo X`), beende deinen Turn, fasse danach beide Ergebnisse zusammen".
- Gemessen wird in der DB, ob nach dem Turn-Ende eine `synthetic`-Nachricht folgt, ein neuer Assistant-Turn startet und die Antwort X enthält.
- Dasselbe mit Shell `background:true` und `of-run.sh … --wait`.
- n=3 je Weg und Modell (dharma/balanced, dharma/power, glm-5.3).

**KILL-KRITERIUM:** Weniger als 3/3 Wecken bei einem Weg → das Plugin übernimmt den Rückruf. Der Weg ist dann ein V2-Plugin nach dem auto-resume-Muster, das `fabrik_log` beobachtet und `ctx.session.synthetic` an die Eltern schickt. Statt W1/W2 nur zu konfigurieren, wird W2b gebaut.

## 4. Zustandsautomat: ein Hintergrund-Auftrag aus Sicht des Hauptfadens

```mermaid
stateDiagram-v2
  [*] --> Zerlegt: Auftrag mit >=2 unabhängigen Teilen
  Zerlegt --> Gestartet: subagent{background} / shell{background} of-run --wait
  Gestartet --> Läuft: status running, Hauptfaden arbeitet weiter
  Läuft --> Fertig: synthetic state=completed
  Läuft --> Fehler: synthetic state=error / Exit!=0
  Läuft --> Abgeräumt: Reaper SIGTERM
  Läuft --> Verwaist: Dienst-Neustart (job.background in KV)
  Läuft --> Stumm: kein synthetic binnen Frist
  Abgeräumt --> Gemeldet: Reaper postet synthetic an OPENFLOW_SESSION
  Verwaist --> Läuft: Job aus KV wieder aufgenommen
  Verwaist --> Stumm: nicht wieder aufgenommen
  Stumm --> Gemeldet: of-loop-Wächter postet "kein Ende seit N min"
  Fertig --> Geprüft: Hauptfaden-Stichprobe gegen Lieferung
  Fehler --> Neu: genau 1 Wiederholung (AGENTS REGEL 1)
  Gemeldet --> Neu
  Neu --> Gestartet
  Neu --> Aufgegeben: 2. Fehlschlag → OFFEN in Bilanz
  Geprüft --> [*]
  Aufgegeben --> [*]
```

Den Automaten zu zeichnen hat zwei vergessene Zustände aufgedeckt:
- **Abgeräumt:** heute ohne jede Meldung, und das ist der häufigste Fall.
- **Stumm/Verwaist:** ein Dienst-Neustart mitten im Lauf.

Beide brauchen eine Meldung von außen, sonst bleibt der Hauptfaden still.

## 5. Komponenten

```mermaid
flowchart LR
  TUI[TUI / Nutzer] --> HF[Hauptfaden build @ dharma/power]
  HF -- subagent background --> SA[Subagenten explore/general @ dharma/balanced]
  HF -- shell background: of-run.sh --wait --> OR[of-run.sh → headless-run → Engine :4096]
  SA -- synthetic completed --> HF
  OR -- Exit-Code + ergebnis.md, notifyWhenDone --> HF
  REAP[of-reap / of-loop Wächter] -- POST /api/session/:id/synthetic --> HF
  GUARD[guard.ts / fabrik-gate.ts] -. prüft Modell + Gate .-> HF
  HF & SA & OR --> DH[dharma Router] --> PROV[zai · yolo · antigravity · clinepass · nvidia]
  LEDGER[(~/.openflow/gate-ledger.jsonl)] --- GUARD
  BENCH[Autonomie-Benchmark] --> HF
```

Grenzen: Secrets bleiben in der Konfiguration und in `service.json` mit Rechten 600. Der Reaper liest das Passwort nur lokal und gibt es nie aus.

## 6. Arbeitspakete (nach Abhängigkeit)

| Welle | Paket | Inhalt | Repo / Datei | hängt ab von |
|---|---|---|---|---|
| 0 | **W0 Spike** | siehe §3, dazu Dienst-Neustart auf 2.1.4 (A12) und Abgleich der Plugin-Typen (A13) | Wegwerf-Ordner | — |
| 1 (parallel) | **W1 Anweisungen** | build.md und AGENTS.md REGEL 1 neu (siehe unten) | `~/.config/opencode/` (lokales git) | W0 |
| | **W2 Fabrik robust** | Reaper-Schwelle, ergebnis.md, Exit-Code, Rückruf bei Reap | OpenFlow `packages/flow` (PR → dev) | W0 |
| | **W3 Hauptfaden über dharma** | `build` fest auf dharma/power; `steps` je Agent setzen; Guard meldet jede TUI-Modellwahl außerhalb von dharma; `model.json` auf dharma/power | `opencode.jsonc`, `plugins/guard.ts` | — |
| 2 | **W4 Autonomie-Benchmark** | fester Aufgabensatz plus Messskript | OpenFlow `packages/flow/bench/` | W1–W3 |
| 3 | **W5 Messwoche + Abnahme** | 7 Tage Betrieb, dann dieselbe Wochenanalyse und unabhängige `abnahme` | — | W4, dharma-Strang live |

### W1 Anweisungen (Inhalt)
- **Hintergrund als Standard:** Unabhängige Teile laufen als `subagent{background:true}`, alle in **einem** Block. Danach arbeitet der Hauptfaden weiter oder beendet seinen Turn mit „warte auf N Hintergrund-Ergebnisse". **Kein** sleep und kein Abfragen.
- Synchrones `subagent` nur, wenn das Ergebnis im selben Schritt gebraucht wird.
- Fabrik: `shell{background:true}` mit `of-run.sh <pipeline> "<task>" --wait`. Die Shell meldet das Ende, das Ergebnis steht in `ergebnis.md`, der Pfad steht in der Ausgabe.
- Der Hauptfaden urteilt: Jede Lieferung bekommt eine eigene Stichprobe (Kontrollwert). Der Widerspruch zu guard.ts:515 („nicht selbst nacharbeiten") wird aufgelöst. Stichprobe heißt nachprüfen, nicht die Arbeit selbst nachholen.
- Widersprüche 3g/3h werden aufgelöst. Es bleibt **eine** Stelle für die Stufen „Subagent oder Fabrik" (AGENTS REGEL 4); mode/fabrik.md verweist nur noch darauf.
- `direktiven/` wird entweder in `instructions` aufgenommen oder in AGENTS.md überführt und gelöscht. Kein toter Ordner.

### W2 Fabrik robust (Inhalt, je mit Test und Gegenprobe)
1. **Reaper gegen Karten-Timeout:** Der Reaper darf erst handeln, wenn das Karten-Timeout plus Puffer abgelaufen ist, oder er nutzt einen Lebenszeichen-Takt der Engine. Ein bloß stiller Checkpoint reicht nicht. Die Ursachenkette ist belegt (A6). Bevor gefixt wird, rechnet der Test die 41 Fälle nach: Wie viele Karten waren beim Abräumen noch innerhalb ihrer 30 Minuten?
2. **headless-run:** Handler für SIGTERM/SIGINT schreibt das Verdict `stopped` und eine `ergebnis.md` (Scorecard plus Karten-Outputs, ≤ 25 KB) neben den Checkpoint. Die Datei wird bei **jedem** Ende geschrieben.
3. **`--wait`** gibt den Exit-Code des Runs zurück (A9).
4. **Rückruf bei Reap:** Der Reaper schlägt in `fabrik_log` die Session nach und postet `synthetic` „Run X abgeräumt, Grund, Checkpoint" über die API (A4). Der Wächter in of-loop meldet „kein Ende seit 45 min" für Läufe im Zustand Stumm.
5. Nebenbefund: `state.json` zeigt auf ein Projekt ohne auto-orchestrator. Prüfen, ob der Canvas das aktive Projekt nutzt (UNGEPRÜFT). Falls ja: die Pipeline wird über einen absoluten Pfad aufgelöst.

### W3 Hauptfaden über dharma (Inhalt)
- `agents.build.model = dharma/power`, bleibt so.
- `steps`: build 200, general/worker 60, explore 40. Begründung: unbegrenzt plus Schleife wäre der teuerste Fehlerfall. Die Zahlen werden nach W4 angepasst.
  - **Umgesetzt mit begründeter Abweichung** (Commit `1b6f657` in `~/.config/opencode`): siehe „Stand nach der Abnahme“, W3 — build ohne Schrittgrenze, die übrigen Werte aus der gemessenen Verteilung statt der Schätzung oben.
- Guard: Liegt die TUI-Wahl außerhalb von `dharma/*`, kommt ein sichtbarer Hinweis, keine Blockade.
- Die Arbeit läuft bei der Flatrate, Geldpfad unverändert: zai-pay steht weiter zuletzt.

### W4 Autonomie-Benchmark
Aufgabensatz B1 bis B5 in einem Wegwerf-Repo mit festem Sollergebnis:
- **B1:** 3 unabhängige Analysen, jede mit einer bekannten Zahl als Kontrollwert.
- **B2:** Fan-out plus abhängiger Fix (Teil B braucht A).
- **B3:** ein Fabrik-Run mit Rückruf.
- **B4:** ein absichtlich scheiternder Subagent (Wiederholungsregel).
- **B5:** ein Lauf, der vom Reaper abgeräumt wird (Rückruf bei Reap).

Messung aus `opencode.db`, Skript `bench/messen.ts`:

| Kennzahl | Ziel 10/10 |
|---|---|
| Unabhängige Teile in einem Block gestartet | ≥ 90 % |
| davon mit `background` | ≥ 80 % |
| sleep/Abfrage-Aufrufe während des Wartens | 0 |
| Ergebnisse eingesammelt und mit Kontrollwert bestätigt | 100 % |
| Turns ohne Nutzereingriff bis Abschluss | 100 % |
| Fehlschläge korrekt wiederholt bzw. als OFFEN gemeldet | 100 % |

Kandidaten: dharma/power, dharma/brain, glm-5.3, glm-5.2, jeweils n=3. Claude über antigravity wird gemäß Entscheidung **nicht** getestet. Referenz ist dieselbe Suite, gefahren mit Claude Code. Dessen Werte sind die Messlatte, keine Behauptung. Das beste Modell, das nichts extra kostet, wird für `build` festgeschrieben.

## 7. Grenzwerte (nur verifizierte)

| Ressource | Wert | Wirkung | Quelle |
|---|---|---|---|
| Shell-Timeout im Vordergrund | 120.000 ms | Fabrik nie im Vordergrund starten | Binary `hA` |
| Shell im Hintergrund | kein Timeout, notifyWhenDone | trägt `--wait` | Binary |
| Verschachtelte Subagenten | Tiefe 1 (`experimental.subagent_depth`) | Ein Subagent darf keine Fabrik mit Subagenten starten. Der Pflichtweg an Subagenten aus PR #2 muss das beachten | Binary |
| Karten-Timeout der Engine | 30 min | Reaper muss länger warten | engine.ts:231 |
| Reaper-Schwelle | vor W2: 10 min (of-loop) bzw. 15 min (of-run); **seit W2 eine Quelle** `of-lebendig.ts`: Prozess lebt → 35 min (Timeout 30 + Puffer 5), Prozess tot → 5 min Grace, Prozess unbekannt → 35 min | lebende Karten werden nie innerhalb ihres Timeouts abgeräumt | of-lebendig.ts |
| Stumm-Meldung | 45 min ohne Ende | Rückruf an die Start-Sitzung, genau einmal | of-lebendig.ts `STUMM_MELDUNG_MIN` |
| Steps ohne Konfiguration | unbegrenzt | W3 setzt Grenzen | Binary |
| zai glm-5.3-Kontingent | 220 Anfragen je 5 h (glm-5.2: 880) | Hauptfaden auf power/glm-5.2 statt 5.3 | modell-bewertung.json:529 |

## 8. Angriff

**Pre-Mortem**, nach Wahrscheinlichkeit sortiert:
1. Die Modelle ignorieren die neue Regel trotzdem. Heute ist die Fabrik-Quote 1/18. Mitigation: W4 misst das, der Guard weist bei synchronem Fan-out ≥ 3 auf `background` hin. **Kill:** erreicht kein Kandidat ≥ 60 % background-Quote, wird die Regel per Plugin erzwungen (Subagent-Aufrufe mit ≥ 2 Geschwistern im selben Block automatisch auf background setzen).
2. Das Wecken klappt im Dienst anders als `--standalone`. Mitigation: W0 einmal zusätzlich im Dienst messen.
3. Ein Dienst-Neustart verliert Hintergrund-Jobs. Mitigation: Zustand Verwaist, Meldung durch den Wächter.
4. Die Hintergrund-API von opencode ist „experimental" und ändert sich mit dem nächsten Update. Mitigation: W4 ist der Regressionstest nach jedem opencode-Update. **Kill:** bricht ein Update die API, wird das Update zurückgerollt und gepinnt.
5. dharma bleibt wackelig (25 % Fehlversuche). Mitigation: Der dharma-Strang ist Vorbedingung für W5.

**Inversion:** opencode entfernt `background`, oder der Flatrate-Anbieter des power-Tiers fällt weg. Gegenmaßnahme: Plugin-Rückruf (W2b) als zweiter Weg bleibt dokumentiert, die Tier-Kette in dharma mit mindestens 2 Anbietern.

**Red Team:**
- **(a)** Wenn der Hauptfaden seinen Turn beendet und auf die Rückmeldung wartet, hängt alles an der Fertig-Meldung. Fällt sie aus, steht er still. → Der Wächter (Stumm) ist Pflicht, nicht optional.
- **(b)** `steps`-Grenzen können lange Läufe abwürgen. → Die Werte kommen aus der W4-Verteilung (p99 × 2), nicht geraten.
- **(c)** Ein Reaper, der in Sitzungen postet, könnte in die falsche Sitzung schreiben. → Die Zuordnung läuft nur über `aufruf_id` plus `session_id` aus demselben Ledger-Eintrag; der Test prüft eine fremde Session als Gegenprobe.

**Kill-Kriterien zusammengefasst:** W0 < 3/3 → Plugin-Weg. W4 background-Quote < 60 % → Erzwingung per Plugin. W5 Fabrik-PASS < 80 % nach dem Reaper-Fix → Ursachenanalyse vor weiteren Features. opencode-Update bricht B1–B5 → zurückrollen und pinnen.

## 9. Teststrategie

| ID | Typ | Was | Erwartung | Prio |
|---|---|---|---|---|
| T-01 | Unit (bun) | Reaper-Schwelle gegen Karten-Timeout | Karte mit 25 min Stille wird nicht abgeräumt (vorher rot) | MUSS |
| T-02 | Unit | SIGTERM-Handler in headless-run | Verdict `stopped`, `ergebnis.md` vorhanden | MUSS |
| T-03 | Unit | `of-run --wait` Exit-Code | FAIL → ≠ 0 (vorher 0) | MUSS |
| T-04 | Unit | Reap-Rückruf postet an die richtige Sitzung | fremde Session bekommt 0 Posts | MUSS |
| T-05 | Integration | Reaper-Post gegen die echte API :49374 im Testdienst | synthetic in der Ziel-Sitzung, Turn startet | MUSS |
| T-06 | Integration | W0-Spike als wiederholbares Skript `bench/wecken.ts` | 3/3 je Weg | MUSS |
| T-07 | Smoke | B1–B5 mit dharma/power | Ziele aus §6 W4 | MUSS |
| T-08 | Regression | bestehende Suite packages/flow (1670) und Gate-Korpus 322/325 | unverändert grün | MUSS |
| T-09 | Unit | Guard-Hinweis bei TUI-Modell außerhalb von dharma | Hinweis ja, Blockade nein | SOLL |

Befehle: `cd packages/flow && bun test` · `bun bench/messen.ts --modell dharma/power --n 3` · `of-run.sh --scorecard`.

Getestet heißt: T-01 bis T-08 grün, jede Gegenprobe ohne Fix nachweislich rot.

## 10. Messwoche und Abnahme (W5)

- Nach Deploy aller Pakete plus dharma-Strang: 7 Tage Normalbetrieb.
- Danach dieselben drei Auswertungen wie am 23.10. (opencode.db, Ledger/Scorecard, dharma AE/D1). Die Skripte werden dafür ins OpenFlow-Repo übernommen (`bench/woche.ts`), damit sie nicht im Job-Temp verschwinden.
- Die Note vergibt ein `abnahme`-Subagent mit eigenen Messungen gegen diese Kriterien:

| Dimension | 10/10 heißt |
|---|---|
| Arbeit erledigt | Modellfehler ≤ 0,5 %, Session-Erfolg ≥ 98 % |
| dharma | Fehlversuche < 2 %, Failover < 5 %, 0 tote Modellnamen |
| Überwachung | kein Rot ohne Meldung > 1 h, TTFT gemessen |
| Fabrik | PASS ≥ 90 %, 0 stille Enden, 100 % Rückrufe |
| Regeltreue | ≥ 90 % befolgt oder begründet |
| Autonomie | W4-Ziele im Feld: background ≥ 80 %, 0 Abfragen |
| Kosten | $0 Verbrauch außerhalb der Flatrates; opencode-go repariert oder gekündigt (Betreiber) |

## 11. Offene Betreiberpunkte
- opencode-go: Schlüssel neu ausstellen oder Vertrag kündigen. Ohne Entscheidung bleibt Kosten bei 9.
- `CANARY_WEBHOOK_URL`: das Ziel, falls der dharma-Strang meldet, dass es fehlt.

## 12. Self-Score (tplan-Schema)
Root Cause belegt (Reaper `of-loop.ts:61` gegen `engine.ts:231`; `--wait` `of-run.sh:129`) +2 · Annahmen verifiziert (A2/A3/A12/A13 als Spike-Gate, nicht geraten) +2 · Zustandsautomat deckt Abgeräumt/Stumm/Verwaist auf +1 · Edge Cases (Fehler, Reap, Verwaist, Stumm, Wiederholung, fremde Session) > Happy Path +1 · Kill-Kriterien 4 +1 · Spike definiert (Lauf im Planmodus verboten, deshalb W0 als Gate) +1 · Grenzwerte mit Quelle +1 · Security (Passwort aus `service.json`, Zuordnung fremder Sessions, Geldpfad) +1 · Teststrategie +1 · Wellen mit Abhängigkeiten +1 = **10/10 als Plan**. Das ist eine Selbstbewertung des Plans, keine Systemnote; die Systemnote kommt aus W5 von der Abnahme.

## Verifikation (Ende-zu-Ende)
1. W0: `bun bench/wecken.ts` → 3/3 je Weg.
2. Nach W1–W3: Dienst-Neustart (angekündigt), dann B1–B5 mit dharma/power → Kennzahlen aus §6.
3. Fabrik: ein echter `auto-orchestrator`-Lauf, gestartet aus einer opencode-Sitzung per Hintergrund-Shell. Die Sitzung meldet sich von selbst mit dem Ergebnis. Dazu ein künstlich abgeräumter Lauf mit Meldung in der richtigen Sitzung.
4. W5: Wochenanalyse plus unabhängige `abnahme`.

## W2 — Messung und Umsetzung (23.10.2026)

### W2.1 Messung vor dem Fix: Wen hat der Reaper getroffen?

Datenbasis: `~/workspace/flow-lab/.openflow/runs` (201 Run-Logs), `/tmp/of-run-*.log` (119 Logs), `/tmp/of-loop-state.jsonl`. Zeitpunkt jeweils `reaped.at`.

| Befund | Anzahl |
|---|---|
| gereapt (Run-Log trägt `reaped`) | **41** — 33 mit Schwelle 10 min (of-loop; deckt sich mit Σ `gereapt` = 33 in of-loop-state.jsonl), 7 mit Schwelle 30 min (Hand/`--reap`), 1 ohne Checkpoint |
| ohne laufende Karte beim Reap | 11 |
| laufende Karte älter als 30 min | 5 (4 davon > 11 000 min, Altlasten vom September) |
| laufende Karte **innerhalb** ihrer 30 min (Kartenalter 10–21 min) | **25** |
| — davon Original unterbrochen (Resume desselben Runs VOR dem Reap gestartet) | 4 |
| — davon ohne jedes Lebenszeichen nach der Stille (Log-mtime = letzte Aktivität ± 1 min, Store nie wieder geschrieben) | 16 |
| — davon unbestimmt (kein eigenes Log zuzuordnen) | 5 |

Warum „kein Lebenszeichen" hier „tot" heißt: Ein lebender headless-run schreibt spätestens beim Karten-Timeout (30 min) einen Patch — ins Log (`[karte] error`) und per PUT in den Store, der den `reaped`-Block dabei ersetzt. Alle 33 of-loop-Reaps tragen ihren `reaped`-Block bis heute; vor dem 12.10. (kein `host.pid`) konnte der Reaper auch niemanden töten. Diese Läufe waren also schon tot.

**Ergebnis:** echte Zombies belegt **36 von 41** (11 + 5 + 4 + 16), unbestimmt 5, nachweislich lebend erschossen **0**. Die Plan-Annahme A6 („Hauptursache ist der Reaper") ist damit **nicht belegt**. Die 16 toten Läufe enden in ihren Logs 0–1 min nach dem Kartenstart, mehrere im Pulk (8 Starts binnen 60 s) — das Muster passt zu Starts aus einer Vordergrund-Shell, deren Timeout die Prozessgruppe beendet (Interpretation, ungeprüft).

Der Fix bleibt nötig: Seit dem Hänger-Fix (12.10.2026) beendet der Reaper einen LEBENDEN headless-run per SIGTERM. Ein Lauf mit einem stillen Zug von 10–30 min (langer Werkzeugaufruf, Rate-Limit-Backoff) wäre erschossen worden — die Schwelle lag unter dem Timeout der Engine.

Skripte der Messung: `reap-analyse.ts`, `resume-zeit.ts`, `log-mtime.ts` (im Job-Verzeichnis der Sitzung; die Methode steht oben vollständig).

### W2 umgesetzt

| Paket | Umsetzung | Test |
|---|---|---|
| W2.1 Reaper | `of-lebendig.ts` `reapUrteil`: Prozess lebt → erst nach Karten-Timeout + Puffer (35 min) Stille, auch gegen eine kleinere `--min-age-min`; Prozess tot → 5 min Grace; unbekannt (kein `host.pid`, kein `/proc`) → 35 min. of-reap, of-loop (inkl. Invariante I1), die Sonde of-loopcheck (vorher eine dritte Zahl, 15 min) und of-run.sh nutzen dieselbe Regel; of-loop und of-run.sh reichen keine eigene Zahl mehr durch. of-loop fährt den Reaper aus seinem eigenen Checkout (vorher fest `~/workspace/OpenFlow`). | `lebendig.test.ts` (T-01) |
| W2.2 Abschluss | `of-ergebnis.ts` `abschliessen` + `installiereSignalAbschluss`: jedes Ende (regulär, SIGTERM/SIGINT/SIGHUP) schreibt Checkpoint und `/tmp/openflow-checkpoint-<id>.ergebnis.md` (Scorecard + Karten-Outputs, ≤ 25 KB, gekürzt mit Hinweis); letzte stdout-Zeile `ergebnis: <pfad>`; Exit 143/130/129. Der Reaper wartet den Selbstabschluss (≤ 6 s) ab und legt den `reaped`-Block darauf. | `abbruch.test.ts` (T-02) |
| W2.3 `--wait` | Exit = Exit des Runs; `LOG=` vor dem Start; danach Zusammenfassung auf stdout (Verdict, `exit:`, Anfang der ergebnis.md bis 3000 Byte mit Kürzungshinweis, `checkpoint:`, `ergebnis:` als letzte Zeile) — die Fertig-Meldung einer Hintergrund-Shell trägt damit das Ergebnis (W0: 18/18 Wecken). | `of-run.test.ts` (T-03) |
| W2.4 Rückruf | `of-rueckruf.ts`: bei Reap und bei Runs ohne Ende nach 45 min `POST 127.0.0.1:<port>/api/session/<id>/synthetic` (Basic `opencode`, Passwort aus `service.json`, nie geloggt). Zuordnung nur über EINEN Ledger-Eintrag (`host.aufruf_id` → fabrik_log/fabrik_run; sonst `host.pid` → fabrik_log im Zeitfenster); Widerspruch → kein Post. Marker `event:"rueckruf"`; Fehlschlag → `rueckruf_fehlgeschlagen` mit Grund, höchstens 3 Versuche; Testlauf ohne `OPENFLOW_LEDGER` → aus. headless-run trägt `host.aufruf_id`/`host.session` aus der Umgebung (ein Resume erbt sie). | `rueckruf.test.ts` (T-04, Fake-Dienst) |
| W2.5 Projekt | headless-run lädt Pipelines über den Canvas, also aus dessen aktivem Projekt (`OPENFLOW_PROJECT` > `state.json` > Repo). Gemessen 23.10.: state.json → mcp-workers, laufender Canvas mit `OPENFLOW_PROJECT=flow-lab` (aus openflow-autostart.sh) → `/flow/api/context` = flow-lab, Pipeline 200. Jetzt: fehlt die Pipeline im aktiven Projekt → Exit 2 mit Projekt und Ausweg; fremdes Projekt → Warnung (Runs dort sieht kein Reaper). | `lebendig.test.ts` (W2.5) |

Offen aus W2 (Stand der Umsetzung; **überholt** — T-05 und B5 sind live gelaufen, siehe „Stand nach der Abnahme“): T-05 (Post gegen den echten Dienst :49374) — Dienst lief zur Umsetzung nicht, ungeprüft. `fabrik_log` trägt noch keine `aufruf_id` (Plugin `fabrik-gate.ts` im Konfig-Repo); die Zuordnung läuft bis dahin über `host.aufruf_id`↔`fabrik_run` bzw. `pid`↔`fabrik_log`.

## Stand nach der Abnahme (23.10.2026)

**Unabhängige Abnahme 23.10.2026: 2/10.** Grund: Der Feld-Nachweis ist UNGEPRÜFT — alle Pakete sind gebaut und einzeln gemessen, aber noch keine Woche Normalbetrieb lief über den neuen Stand. Die Note ändert erst W5. Die Befunde der Abnahme sind unten je Paket nachgezogen (Befund 7: T-05-Gegenprobe; Befund 10: diese Doku).

| Paket | Stand | Beleg |
|---|---|---|
| W0 Spike | **bestanden 18/18** (Wecken je Weg und Modell, n=3) | `bench/wecken.ts` |
| W1 Anweisungen | **umgesetzt** | `~/.config/opencode` Commits `1ce5caa` (Hintergrund als Standard, Fabrik als Hintergrund-Shell mit `--wait`), `1ca15b2` (Live-Befund, s. u.) |
| W2 Fabrik robust | **umgesetzt** | Abschnitt „W2 umgesetzt“ oben |
| W3 Hauptfaden über dharma | **umgesetzt mit begründeter Abweichung** | `~/.config/opencode` Commit `1b6f657` |
| W4 Benchmark | **gemessen** | unten |
| W5 Messwoche | **offen**: 24.–30.10.2026 | `bun bench/woche.ts --von 2026-10-24 --bis 2026-10-30` |

### W1 — Live-Befund

Ein Kind-Subagent meldet sein **erstes** Turn-Ende als fertig. Startet er selbst etwas im Hintergrund und beendet seinen Turn mit „warte auf …“, kommt bei der Eltern-Sitzung eine halbe Lieferung als „completed“ an. Deshalb gilt: Hintergrund **nur im Hauptfaden**, Subagenten arbeiten synchron. Der Guard setzt das durch (Commit `1ca15b2`).

### W3 — Schrittgrenzen: Abweichung vom Plan, mit Begründung

Der Plan schätzte build 200, general/worker 60, explore 40 und verlangte zugleich (Red Team (b)) Werte aus der gemessenen Verteilung, p99 × 2. Gemessen wurde über die Woche 09.–23.10. (opencode.db, Schritte je Sitzung):

| Agent | Grenze | Herleitung |
|---|---|---|
| build | **keine** | p99 = 933 Schritte je Sitzung, verteilt über mehrere Turns. Eine Grenze würde genau die langen autonomen Läufe abwürgen, um die es in diesem Plan geht. |
| explore | 80 | p99 × 2 |
| general | 60 | p99 × 2 |
| reviewer | 60 | p99 × 2 |
| abnahme | 110 | p99 × 2 (p99 52) |
| worker-dev | 20 (Projektwert, unverändert) | **offener Befund:** 20 liegt auf dem Median, die Grenze greift also bei etwa jeder zweiten Sitzung |

Der Hinweis bei einer TUI-Modellwahl außerhalb von `dharma/*` ist umgesetzt (sichtbar, keine Blockade).

### W4 — Ergebnisse (Benchmark B1–B5, 23.10.2026)

| Kandidat | Ergebnis |
|---|---|
| dharma/power | **8/9 korrekt**, 0 sleep/Abfrage-Aufrufe, 0 Nutzereingriffe, Hintergrund-Anteil am Fan-out ≈ 73 % (nach `bench.ts` nachgerechnet) |
| zai/glm-5.3 | 3/3, **n = 1** je Aufgabe — trägt keinen Vergleich |
| dharma/brain | 0/3 — ein Planer, kein Ausführer; für `build` ungeeignet |

Ziel aus §6 W4 war ≥ 80 % Hintergrund-Anteil. Mit ≈ 73 % liegt dharma/power über der Kill-Schwelle von 60 % (§8), aber unter dem Ziel.

### Live-Abnahmen

| Prüfung | Ergebnis |
|---|---|
| W1 live | 9 von 9 Werten |
| B3 (Fabrik-Run mit Rückruf) | PASS, Rückkehr in die Sitzung nach 1388 s |
| T-05 (Reaper-Post gegen den echten Dienst :49374) | gesendet, Wiederholung → `schon_gemeldet`, fremde Sitzung 0 Posts. **Einschränkung (Abnahme, Befund 7):** Die fremde Sitzung hatte im Live-Test gar keinen Ledger-Eintrag, „0“ bewies damit nichts. Nachgezogen in `rueckruf.test.ts` (T-05): Die fremde Sitzung hat eigene Einträge im selben Zeitfenster. Die Lagen werden gegen zwei absichtlich falsche Zuordnungen gefahren („nur über pid“, „jüngster Eintrag“), und beide scheitern daran. |
| B5 (echter Reap mit Rückruf) | siehe unten |

**B5 live (23.10.2026, 21:21–21:30 UTC).** Sitzung `ses_e955d28bfffew6Us0FRnnyRzCv` („abnahme-live B5“, flow-lab, Agent build) wurde per API angelegt. Gestartet wurde `of-run.sh smoke-orch` detached, mit `OPENFLOW_SESSION` und `OPENFLOW_AUFRUF_ID=b5-20261023T212117Z`. Der passende `fabrik_run`-Eintrag ist von Hand geschrieben, so wie fabrik-gate ihn schreibt, weil der Start ohne das Plugin lief. Die Zuordnung braucht `aufruf_id`↔`fabrik_run`, und das `fabrik_log` des Plugins trägt keine `aufruf_id`. Run `run-2026-10-23T21-21-17-391Z-ecc827`, headless-run PID 10145, wurde unmittelbar nach dem Start mit SIGKILL beendet. Danach:
- Der of-loop-Cron um 21:30:01 räumte ihn ab: `zombie — Prozess tot, checkpoint seit 9 min stumm (Grace 5 min)`, `gereapt: 1`. Der Cron um 21:25 griff noch nicht, weil die Grace von 5 min noch nicht abgelaufen war.
- Ledger: genau **eine** `rueckruf`-Zeile für diesen Run (`zuordnung: aufruf_id`, `http: 200`). In der Sitzung steht die synthetic-Nachricht „[OpenFlow] Fabrik-Run … (smoke-orch) wurde abgeräumt …“. 24 ms danach startete ein Assistant-Turn. Keine andere Sitzung bekam eine `[OpenFlow]`-Nachricht (opencode.db, ab 21:20 UTC).
- **Befund:** Der geweckte Turn lief auf `opencode-go/kimi-k3.1-pro` statt auf `build = dharma/power` und endete mit 401 `api_key_expired`. **Ursache belegt (Nachmessung 23.10., 21:49–21:51 UTC):** Die Hypothese „Modell hängt an der letzten Nutzer-Nachricht" ist widerlegt. Um 21:29:49 löste ein Merge nach `~/.config/opencode` im laufenden Dienst einen Hot-Reload aus, der mit `failed to reload plugins (TypeError: o is not a function)` scheiterte (run `7189a39a`). Danach kannte der Dienst dharma nicht mehr (`Model unavailable: dharma/power`) und fiel still auf opencode-go zurück. Messung je drei Weck-Turns ohne Nutzer-Nachricht (flow-lab, mcp-workers, flow-lab mit gesetztem dharma/power): vor dem Neustart 2× opencode-go 401 und 1× `provider.no-route`, nach dem Neustart 3/3 dharma/power `succeeded`. Abhilfe: Watchdog-Prüfung c) RELOAD in `~/.config/opencode/scripts/opencode-watchdog.sh` (Commits `2519bfb`, `8ca50a3`). Ein Reload-Fehler mit der run-Kennung des laufenden Dienstes führt zum Neustart (eigene Sperre 5 min). DRAIN zählt seit `8ca50a3` ebenfalls nur Fehler des laufenden Prozesses; vorher löste er um 22:20 einen zweiten, unnötigen Neustart aus (Abnahme R2, Befund 1). Live gegriffen hat der RELOAD-Neustart noch nicht, belegt ist er nur im Test (7 Fälle, Gegenprobe gegen `2519bfb` 3 rot). Nebenbei belegt: Der opencode-go-Schlüssel ist abgelaufen (§11).

### Feld-Ausgangswerte 16.–23.10.2026 (vor W1–W3)

| Kennzahl | Wert |
|---|---|
| Hauptfäden | 11 |
| Fan-outs | 54, davon 2 im Hintergrund = **3,7 %** |
| Warte-Abfragen (sleep/poll) | 56 |
| Modellfehler | 0,21 % |
| Tool-Fehler | 1,74 % |
| dharma-Anteil | 59,2 % |
| Fabrik-PASS | 80 % |

Das sind die Vergleichswerte für W5. Die Messwoche läuft vom 24. bis 30.10.2026, danach `bun bench/woche.ts --von 2026-10-24 --bis 2026-10-30` und eine unabhängige `abnahme` (§10). `woche.ts` weist TTFB seit dem 23.10. als „nicht getrennt erfasst (Altdaten)“ aus, wenn `ttfb_ms = total_ms` in allen Zeilen steht (vor dharma 0.7.0), und als „nur in N von M Zeilen getrennt“, wenn es nur einige sind. Die TTFB-Quantile rechnen dann nur über die getrennten Zeilen. Gemessen für 16.–23.10.: 16 von 16 540 Zeilen getrennt, TTFT in 373 Zeilen. TTFT (`ttft_ms`, ab dharma 0.7.0) erscheint als eigene Spalte.

### Abnahme Runde 2 (23.10.2026, 21:58–22:22 UTC)

Gesamtnote **2/10**. Die schwächste Dimension ist der Feld-Nachweis (seit dem Deploy nur abnahme-live-Sitzungen). Die Dimensionen R1 → R2: Hintergrund-Orchestrierung 7 → 8, Rückkanal 8 → 8, Fabrik 7 → 7, dharma 5 → 5, Tests 8 → 7, Feld 2 → 2, Doku 6 → 6.

- **Behauptung (a) erfüllt:** Ein fehlgeschlagener Hot-Reload kostet den Dienst dharma; nach dem Neustart läuft er wieder auf dharma.
- **Behauptung (b) erfüllt (n=1):** Der Guard stellt background in der Kind-Sitzung live auf synchron. Log: `HINTERGRUND→SYNCHRON in Kind-Sitzung … session=ses_e953d77c…`. Der Hauptfaden erhielt den vollständigen Kind-Bericht beim ersten Fertig-Signal.
- **Behoben nach R2:**
  - Befund 1: DRAIN an die run-Kennung gebunden.
  - Befund 2: RELOAD-Sperre 5 min statt 30 min.
  - Befund 5: lokaler mcp-workers-Checkout auf origin/main gezogen (dharma 0.8.0).
  - Befund 6: diese Doku.
  - Befund 7: Guard-Log meldet die richtige Einstufungsquelle (`~/.config/opencode` `8ca50a3`, plugins-shared 1379/0).
- **Offen, Code:**
  - Befund 4: dharma seit 0.8.0 13,8 % Fehlversuche bei n=65 (zai glm-4.6 502/Status 0, yolo 502). Seit 0.8.0 werden auch Zeitlimits und 429/5xx gezählt, die vorher unsichtbar waren. Der Wert ist also erst jetzt ehrlich und braucht eine Ursachenanalyse je Anbieter.
  - Befund 8: Reap mit einem `fabrik_run`, den das Plugin selbst schreibt.
- **Offen, Betreiber:**
  - opencode-go: Schlüssel abgelaufen, still als Rückfall genutzt. Neu ausstellen, deaktivieren oder kündigen.
  - `CANARY_WEBHOOK_URL`: Ziel festlegen.
  - `/metrics.json` ist ohne Anmeldung lesbar: öffentlich lassen oder schützen.
- **Bis 10/10:** Messwoche 24.–30.10. mit den Zielen aus §10, Auswertung `bun bench/woche.ts --von 2026-10-24 --bis 2026-10-30`, danach eine unabhängige Abnahme.
