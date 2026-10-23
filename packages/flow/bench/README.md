# bench/ — Autonomie messen

Mess-Werkzeuge zum Plan [`docs/AUTONOMIE_10_10_SPEC.md`](../docs/AUTONOMIE_10_10_SPEC.md)
(§3 W0, §6 W4, §9 T-06/T-07, §10 W5). Sie beantworten eine Frage: **Fächert der
Hauptfaden unabhängige Arbeit von selbst im Hintergrund auf, ohne zu warten und
ohne Nutzereingriff?** Bis zum 23.10.2026 lagen sie als Python-Skripte in einem
Job-Temp-Ordner; hier stehen sie wiederholbar und getestet.

| Datei | Zweck |
|---|---|
| `wecken.ts` | W0: Weckt die Fertig-Meldung eines Hintergrund-Auftrags die ruhende Eltern-Sitzung? |
| `bench.ts` + `fixture.sh` | W4: Benchmark B1, B2, B4 in einem Wegwerf-Repo mit festen Sollwerten |
| `live.ts` | Abnahme eines echten Auftrags gegen den laufenden Dienst |
| `woche.ts` | W5: die Wochenanalyse (opencode.db, Fabrik, dharma) in einem Befehl |
| `lib.ts` | die Regeln, auf denen jede Zahl beruht; einmal, für alle vier |

## Aufruf

```bash
cd packages/flow

# W0, Ziel 3/3 je Weg
bun bench/wecken.ts --server http://127.0.0.1:PORT --passwort-datei PW --weg subagent --modell dharma/power
bun bench/wecken.ts --server http://127.0.0.1:PORT --passwort-datei PW --weg shell    --modell dharma/power

# W4: ein Lauf = eine JSON-Zeile (n=3 je Modell und Aufgabe → Schleife außen herum)
bun bench/bench.ts --server http://127.0.0.1:PORT --passwort-datei PW \
  --aufgabe B1 --modell dharma/power --lauf 1 [--frist 900] [--laeufe-dir DIR]

# Nachrechnen ohne Modelllauf: dieselben Regeln, Nachrichten aus einer opencode.db
bun bench/bench.ts --auswerten --db XDG/opencode/opencode.db --session ses_… --aufgabe B1 [--verzeichnis LAUFORDNER]

# Abnahme gegen den Dienst (Standard :49374, Passwort aus ~/.config/opencode/service.json)
bun bench/live.ts --verzeichnis ~/workspace/mcp-workers --titel "W1 23.10." \
  --auftrag-datei auftrag.md --kontrollwert 0.4.2 --kontrollwert 1510

# W5: Fenster 16.–23.10. (bis = letzter Tag EINSCHLIESSLICH, UTC)
bun bench/woche.ts --von 2026-10-16 --bis 2026-10-23 [--json] [--ohne-dharma]
```

Passwort immer entweder als `--passwort-datei` (Klartext, eine Zeile) oder als
`--service-json` (`{"password": …}`); ohne beides gilt `~/.config/opencode/service.json`.

## Kontrollwerte

**Benchmark** — fest im Kopf von `fixture.sh` und in `AUFGABEN` (bench.ts):
alpha TODO 3 / `A-4417` · beta TODO 5 / `B-9062` · gamma TODO 2 / `G-1385` ·
delta nach dem Fix `D-7720` (`add(2,3)` muss 5 liefern) · epsilon scheitert beim
ersten Lauf absichtlich, beim zweiten `E-3051`. Bei B1 entscheidet die
**Tabellenzeile**: Steht dort `alpha | 0 | 3`, ist das ein Exit-Code in der
Code-Spalte und falsch, auch wenn der Code darunter im Fließtext steht (Feldfall
B1 dharma/power #3 vom 23.10.).

**Wecken** — `ALPHA-7341` und `BETA-5528` müssen NACH der ersten
`synthetic`-Nachricht in einer „FERTIG"-Antwort stehen.

**Woche** — gegen die Auswertung vom 23.10. (Fenster ab 16.10. 00:00 UTC):
213 Sitzungen · 5222 Assistant-Nachrichten · dharma-Anteil 62,8 % ·
Modellfehler 10 (0,19 %) · 7039 Tool-Aufrufe, 116 Fehler. Nachgemessen am
23.10. abends mit `--von 2026-10-16 --bis 2026-10-23`: GESAMT 222 · 5262 · 63,1 %
· 10 · 7079/116. Die Differenz sind genau die neun `abnahme-live`-Sitzungen
desselben Abends (40 Assistant-Nachrichten, 40 Tool-Aufrufe, 0 Fehler); ohne sie
ergeben sich alle fünf Werte exakt (213 · 5222 · 62,85 % · 10 · 7039/116).

## Was gezählt wird

- **Arbeitsaufruf**: ein `subagent`, oder eine `shell`, die Arbeit tut. Im
  Benchmark heißt das: sie führt `pruefe.sh` aus. Im Feld: sie ist weder
  Stichprobe (jede Teilanweisung liest nur: `cat`, `grep`, `ls`, `git status` …)
  noch Warte-Abfrage (`sleep`, `ps`, `pgrep`, `wait`, `watch`, `tail -f`).
  Zerlegt wird an `;`, `&&`, `|`, Zeilenumbruch und Klammern, aber nie in
  Anführungszeichen.
- **Fan-out**: eine Assistant-Nachricht mit mindestens zwei Arbeitsaufrufen.
  „Mit background" zählt er nur, wenn **jeder** Arbeitsaufruf darin
  `background: true` trägt. Ein halber Hintergrund blockiert den Hauptfaden trotzdem.
- **Hauptfaden-Sitzung**: ohne Eltern, Agent `build`, `plan` oder `fabrik`.
- **Ausgeschlossen und getrennt gezählt**: Titel beginnt mit `abnahme-live`
  (live.ts setzt das immer), Verzeichnis unter `bench/laeufe/` oder
  `~/.claude/jobs/<id>/tmp/`, IDs `ses_test*`. Ein Kind erbt den Grund seiner
  Wurzel. In `~/.openflow/auto-resume.jsonl` fallen Zeilen mit `ses_test*` in
  `sessionID` oder `parent` heraus.
- `woche.ts` druckt opencode-Zahlen zweimal: **GESAMT** (vergleichbar mit der
  Auswertung vom 23.10.) und **FELD** (ohne die Ausschlüsse).

## Bekannte Grenzen

- **Den Benchmark nie über den Live-Dienst fahren.** Er bläht dessen
  opencode.db auf und verfälscht die Messwoche. Ein eigener Dienst auf Temp:
  ```bash
  T=$(mktemp -d)
  XDG_DATA_HOME=$T/xdg OPENFLOW_LEDGER=$T/ledger.jsonl \
    opencode serve --port 49399 > $T/server.log 2>&1 &
  sleep 5; sed -n 's/^server password //p' $T/server.log > $T/pw
  bun bench/bench.ts --server http://127.0.0.1:49399 --passwort-datei $T/pw …
  ```
  Der Dienst schreibt sein Passwort beim Start ins Log (so im W0-Lauf vom 23.10.).
  `live.ts` ist die Ausnahme: Es prüft absichtlich den Betrieb, und sein Titel
  hält es aus der Messwoche heraus.
- Die Regeln wurden gegen die 15 W4-Läufe vom 23.10. nachgerechnet
  (`--auswerten`). Die Kontrollwerte stimmen in 15 von 15 Läufen mit der ersten
  Fassung überein. Die Zahl der Arbeitsaufrufe weicht in 6 Läufen ab, und zwar
  gewollt: Die erste Fassung prüfte per Regex nur die ersten 160 Zeichen und nur
  das erste Kommando der Zeile. Sie zählte `echo "=== beta/pruefe.sh ==="; cat …`
  als Ausführung (4 Läufe) und `ls … && ./pruefe.sh` nicht (2 Läufe). Beide
  Fälle sind in `lib.test.ts` festgehalten.
- Ohne Cloudflare-Zugang (`CLOUDFLARE_API_TOKEN` oder `wrangler login`; ein
  abgelaufener Token wird mit `wrangler whoami` erneuert) steht bei dharma
  `UNGEPRÜFT`, nie „ok". Bei mehreren sichtbaren Konten muss
  `CLOUDFLARE_ACCOUNT_ID` gesetzt sein.
- Die Fabrik-Zahlen kommen aus `scripts/of-scorecard.ts --json`; gezählt werden
  Runs, deren `started` im Fenster liegt.
- B3 (Fabrik-Run mit Rückruf) und B5 (vom Reaper abgeräumter Lauf) aus §6 W4
  sind live abgenommen (23.10.2026), nicht als Skript in `bench/`: B3 PASS mit
  Rückkehr nach 1388 s, B5 echter Reap mit genau einem Rückruf. Belege in
  `docs/AUTONOMIE_10_10_SPEC.md`, Abschnitt „Stand nach der Abnahme“.
- Alle Messungen laufen über opencode 2.1.4 (`/api/session`). Ändert ein Update
  die API, ist `wecken.ts` der Regressionstest (Spec §8, Kill-Kriterium).
