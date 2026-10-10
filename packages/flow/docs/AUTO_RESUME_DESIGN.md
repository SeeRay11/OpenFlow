# Auto-Resume-Kette — Design (Entscheidung B: Design statt Implementierung)

Ziel: Läuft eine Task-Session (OpenFlow-Worker-Karte) gegen ihr Step-Limit
(`agent.steps`, Maximum Steps) oder endet mit offenen „Next Moves", soll ein
opencode-Plugin die Task-Session automatisch mit dem Next-Move-Text fortsetzen
(`resume`) — statt die Karte als „bei Maximum Steps abgebrochen" zu verlieren.

**Entscheidung vom 10.10.2026: B (Design-Doc).** Grund: Das Kriterium für A —
ein *zuverlässig identifizierbares* Completion-Signal — ist im Event-Strom
nicht erfüllt (Details unter „Erkenntnis 1"). Die Resume-Seite (Schicken eines
Prompts an die Task-Session) wäre einfach; die Trigger-Seite ist es nicht.
Implementierung erst, wenn die offenen Punkte (Abschnitt „Offene Punkte vor
Implementierung") geklärt sind.

Alle Datei:Zeilen-Belege beziehen sich auf den opencode-Fork im OpenFlow-Repo
(`packages/opencode`, v1.18.17) bzw. auf `packages/schema` im selben Repo.

## 1. Erkenntnisse aus dem Fork-Code (Beleglage)

### 1.1 Task-Tool: Resume via `task_id` ist vorhanden und trivial

- `packages/opencode/src/tool/task.ts:47-50` — Parameter `task_id`:
  „This should only be set if you mean to resume a previous task (you can pass
  a prior task_id and the task will continue the same subagent session as
  before instead of creating a fresh one)".
- `packages/opencode/src/tool/task.ts:136-138` — `task_id` IST eine SessionID:
  `sessions.get(SessionID.make(params.task_id))`; bei ungültiger ID → `undefined`.
- `packages/opencode/src/tool/task.ts:156-157` — `nextSession = session ??
  sessions.create({...})`: Resume führt in derselben Session weiter.
- `packages/opencode/src/tool/task.ts:200-214` — der Task-Läuft feuert
  `ops.prompt({ sessionID: nextSession.id, agent: next.name, parts, ... })`;
  das Result für den Hauptfaden ist der LETZTE Text-Part:
  `result.parts.findLast((item) => item.type === "text")?.text ?? ""`.
- `packages/opencode/src/tool/task.ts:64-79` — `renderOutput` verpackt das für
  den Hauptfaden als `<task id="<sessionID>" state="completed">
  <task_result>…letzter Text…</task_result></task>` (bzw. `task_error`).
- `packages/opencode/src/tool/task.ts:185-195` — `ctx.metadata({ metadata:
  { parentSessionId, sessionId, model, background? } })`: die Task-SessionID
  steht in den Tool-Metadaten → für ein Plugin über `tool.execute.after`
  abgreifbar.

### 1.2 Wie „Maximum Steps" endet — kein eigenständiges Signal

- `packages/opencode/src/session/prompt.ts:1178-1179` — `maxSteps =
  agent.steps ?? Infinity; isLastStep = step >= maxSteps`.
- `packages/opencode/src/session/prompt.ts:1281` — im letzten Step wird
  `MAX_STEPS_PROMPT` als *assistant-Nachricht in den Modellkontext* injiziert
  (`...(isLastStep ? [{ role: "assistant", content: MAX_STEPS_PROMPT }] : [])`).
- `packages/core/src/session/runner/max-steps.ts` — Inhalt des Prompts: Antwort
  NUR mit Text, inkl. „Statement that maximum steps … have been reached",
  Summary, verbleibende Aufgaben, „Recommendations for what should be done
  next". Das Next-Move-Material steht also in der letzten Text-Antwort.
- Konsequenz: Der Maximum-Steps-Fall endet als ganz normaler Step mit
  `finish: "stop"`; das Limit ist nur im INHALT der Antwort erkennbar
  („maximum steps … reached"), nicht in irgendeinem Event-Feld.

### 1.3 Event-Properties: was step.ended / text.ended tragen

`packages/schema/src/session-event.ts` (identisch zum Package
`@opencode-ai/schema`, das `packages/opencode` konsumiert):

- `session.next.step.ended` — Z. 162-183. Properties: `timestamp`,
  `sessionID`, `assistantMessageID`, **`finish: Schema.String`**, `cost`,
  `tokens {input, output, reasoning, cache{read,write}}`, `snapshot?`,
  `files?`. KEIN „letzter Step"-Flag, kein max-steps-Hinweis, kein
  parentSessionID.
- `session.next.step.failed` — Z. 185-194: `…, error`.
- `session.next.text.ended` — Z. 221-231. Properties: `timestamp`,
  `sessionID`, `assistantMessageID`, `textID`, **`text: Schema.String`** (der
  vollständige Text-Part, replaybares Vollwert-Boundary laut Kommentar Z. 209).
- Vollständige Event-Typen-Liste der Datei (Z. 55-442): agent.switched,
  model.switched, moved, prompted, prompt.admitted, context.updated,
  synthetic, shell.started/ended, step.started/ended/failed,
  text.started/delta/ended, reasoning.started/delta/ended,
  tool.input.started/delta/ended, tool.called, tool.progress,
  tool.success/failed, retried, compaction.started/delta/ended,
  revert.staged/cleared/committed.
  **Es existiert KEIN `session.next.completed`, kein `session.idle`, kein
  task-Ende-Event.**

Antwort auf die beiden Leitfragen:

- **(a) Task-Session-Ende erkennen?** NEIN, nicht zuverlässig. `step.ended`
  feuert nach JEDEM Modell-Step (auch Zwischen-Steps mit
  `finish: "tool-calls"`); ob danach ein weiterer Step kommt, ist aus dem
  Event nicht ablesbar. Das Prompt-Loop-Ende (Break, `prompt.ts:1319`)
  publiziert kein Event. Einzig mögliche Heuristik: Ruhe-Debounce nach einem
  `step.ended` mit `finish ∉ {"tool-calls"}` — anfällig für Fehl-Trigger,
  siehe Risiken.
- **(b) Letzte Antwort / Next-Move lesen?** JA, sauber. `text.ended.text`
  (Z. 221-231) liefert den vollständigen letzten Text je `sessionID`; das
  Plugin kann den letzten Stand pro Task-Session cachen und daraus den
  Next-Move-Abschnitt („Recommendations…") bzw. einen gesetzten Marker
  (`NEXT MOVE:` o. ä.) extrahieren.

### 1.4 Plugin-Seite (aus Vorrunde, hier nur referenziert)

- Plugin-Registry: `packages/opencode/src/plugin/index.ts:282-295`; Hooks in
  `node_modules/@opencode-ai/plugin/src/index.ts:222-335`, u. a. generisches
  `event`-Hook (Z. 224) und `tool.execute.after` (Z. 274).
- Plugins erhalten einen SDK-Client (`plugin/index.ts:144-166`,
  `createOpencodeClient`) → Server-API-Calls inkl. `client.session.prompt`.
- Jedes Plugin hört ALLE Bus-Events via `events.listen`
  (`plugin/index.ts:253-260`).
- Referenz-Plugin: `~/.config/opencode/plugins/fabrik-gate.ts` — Muster
  `(ctx) => ({...})`, Hooks `tool.execute.before`/`chat.message`, Fail-open.

## 2. Design des Auto-Resume-Plugins (falls A nachträglich grün wird)

### 2.1 Hook-/Event-Kandidaten (exakt)

| Rolle | Kandidat | Beleg |
|---|---|---|
| Spawn-Beobachtung (Task-Session registrieren) | Hook `tool.execute.after`, tool `task` → `result.metadata.sessionId` + `parentSessionId` | `task.ts:185-195`; Hook `plugin/src/index.ts:274` |
| Ende-Heuristik | generisches `event`-Hook auf `session.next.step.ended` mit `finish != "tool-calls"` + Ruhe-Debounce 30 s auf registrierter Task-SessionID | `session-event.ts:162-183`; `plugin/src/index.ts:224` |
| Debounce-Verlängerer (Aktivität = Uhr neu stellen) | `session.next.step.started`, `session.next.tool.called/progress`, `session.next.compaction.started/ended`, `session.next.retried` derselben sessionID | `session-event.ts:150, 313, 332, 388, 400-421` |
| Next-Move-Quelle | `session.next.text.ended` → `properties.text` cachen (letzte pro sessionID) | `session-event.ts:221-231` |
| Resume-Injektion | `client.session.prompt({ sessionID: <taskSessionID>, parts: [{ type: "text", text: "RESUME: …" }] })` — semantisch identisch zu `ops.prompt` in `runTask` | `task.ts:202-212`; Client `plugin/index.ts:144-166` |
| Alternativer Resume über Task-Tool | im Haupt-Agent: `task`-Aufruf mit `task_id = <taskSessionID>` (setzt dieselbe Subagent-Session fort) — für Plugins nicht direkt feuuerbar, nur als Agent-/Skript-Weg | `task.ts:47-50, 136-138, 156-157` |

### 2.2 Datenfluss

1. **Registrieren:** `tool.execute.after` sieht jeden task-Tool-Aufruf;
   `metadata.sessionId` (Z. 185-195) landet in der Map
   `taskSessions: Map<sessionID, { parentSessionID, resumes: 0, lastText: "",
   lastActivity: ts }>`.
2. **Mitschreiben:** jedes `text.ended` einer registrierten sessionID
   aktualisiert `lastText` (Volltext, Z. 228).
3. **Erkennen:** `step.ended` mit `finish != "tool-calls"` startet einen
   30-s-Debounce-Timer; JEDES weitere Event derselben sessionID (Liste 2.1)
   verwirft/verschiebt ihn. Läuft der Timer ab → Task-Session gilt als beendet.
4. **Next Move extrahieren:** aus `lastText` per Marker (`NEXT MOVE:` /
   „Recommendations") den Fortsetzungstext schneiden; fehlt er, gilt der
   komplette letzte Absatz. Zusatz-Bedingung (konfigurierbar): Auto-Resume nur
   wenn Text das Maximum-Steps-Muster enthält ODER ein Next-Move-Marker
   gesetzt ist — sonst normal beendete Karte, kein Eingriff.
5. **Resumen:** `client.session.prompt` an die Task-Session (kein neues
   task-Tool nötig); `resumes++`.
6. **Protokollieren:** eine Zeile pro Auto-Resume nach
   `~/.openflow/auto-resume.jsonl` (sessionID, Versuch Nr., Trigger-Typ,
   Next-Move-Head, Zeitstempel) — messbar wie das gate-ledger.

### 2.3 Budget / Loop-Schutz (max 3)

- Hartes Budget `resumes >= 3` pro Task-Session → kein weiterer Auto-Resume;
  statt dessen EIN synthetischer Hinweis an die Parent-Session
  (`client.session.prompt` an `parentSessionID`, Text: Budget erschöpft,
  letzter Next Move) — nur einmalig, per Flag.
- State rein im Plugin-Speicher (Map); Server-Restart = Budget zurückgesetzt —
  akzeptiert, da jeder Resume im Ledger steht (Zählung/Audit nachholbar).
- Mindestabstand 60 s zwischen zwei Resumes derselben Session.
- Alle Handler in try/catch; ein Plugin-Fehler darf niemals die Session
  brechen (Fail-open, wie fabrik-gate.ts).
- Kein Auto-Resume für Sessions, die nicht über `tool.execute.after`
  registriert wurden (Haupt-Sessions bleiben unangetastet).

### 2.4 Risiken

- **Fehl-Trigger (Kernrisiko):** Compaction (`prompt.ts:1320-1328`) und
  langsame Provider-Steps erzeugen Ruhephasen zwischen `step.ended` und dem
  nächsten `step.started` → Debounce kann mitten in einer laufenden Session
  feuern. Milderung: compaction/tool/retried-Events als Aktivität werten,
  Fenster 30 s; Restrisiko bleibt (reine Provider-Latenz ohne Events).
- **Doppelter Prompt auf laufender Session:** `client.session.prompt` während
  der Loop noch läuft → paralleler zweiter Lauf, State-Race. Milderung:
  Resume nur nach abgelaufenem Debounce; harte Absicherung fehlt (kein
  „session busy"-Signal in der API bekannt — vor Implementierung klären).
- **Duplikat-Events:** `events.listen` liefert den Bus an alle Plugins;
  ohne Dedup-Schlüssel `(sessionID, assistantMessageID)` feuert die Logik
  mehrfach. Milderung: lastAssistantMessageID pro Session merken.
- **Session-State/Rechte:** Task-Sessions haben Denies (task-Tool, todowrite;
  `task.ts:143-149`) — ein Resume erbt sie (gewollt). Aber: synchrone
  Task-Sessions (Vordergrund, `task.ts:317-347`) blockieren den Hauptfaden —
  ein Auto-Resume dort ist überflüssig (Ende ist ja sichtbar); nur
  Background- bzw. OpenFlow-Karten-Sessions sind Ziel. Filterkriterium vor
  Implementierung festlegen.
- **Inhalts-Matcher:** „maximum steps" im Text ist kein eindeutiges Signal
  (kann zitiert werden); Marker-basiert (`NEXT MOVE:`) ist robuster.

### 2.5 Umsetzungsschritte (Schätzung)

1. `packages/flow/plugins/auto-resume.ts` — Plugin-Funktion nach
   fabrik-gate-Muster: Registrierung, Event-Filter, Debounce, Next-Move-Schnitt,
   `client.session.prompt`, Budget, Ledger-Zeile, try/catch überall
   (~130-160 Zeilen).
2. Optional `packages/flow/scripts/of-auto-resume-status.ts` — Ledger-Auswertung
   (wie many Resumes, wie viele Karten dadurch gerettet; ~40 Zeilen).
3. Tests: `packages/flow/scripts/`-Testsuiten-Stil — Event-Fixtures
   (step.ended/text.ended-Sequenzen) gegen reine Funktionen (Next-Move-Schnitt,
   Budget-Entscheidung) ohne echten Server (~80 Zeilen).
4. Aktivierung (Doku-only, siehe 2.6).

### 2.6 Aktivierungspfad (keine Änderung an ~/.config/opencode durch diesen Auftrag)

```jsonc
// ~/.config/opencode/opencode.json (Beispiel, vom Betreiber zu setzen):
{
  "plugin": ["~/workspace/OpenFlow/packages/flow/plugins/auto-resume.ts"]
}
```

Alternativ project-lokal: `"plugin": ["packages/flow/plugins/auto-resume.ts"]`
im OpenFlow-Repo. Umgebungsvariable `OPENFLOW_AUTO_RESUME_MAX` (Default 3) und
`OPENFLOW_AUTO_RESUME_IDLE_MS` (Default 30000) überschreiben Budget/Fenster.

## 3. Offene Punkte vor Implementierung (Kriterium A erneut prüfen)

1. Gibt es einen dokumentierten Weg zu erkennen, ob eine Session gerade einen
   aktiven Prompt-Loop hat (API `/session`-Feld o. ä.)? Wenn ja: Debounce
   ersetzbar → A wird trivial und sicher.
2. Soll Auto-Resume nur Background-Tasks (`task.ts:25-41, 305-308`) oder alle
   Task-Sessions treffen?
3. Welcher Next-Move-Marker ist verbindlich (`NEXT MOVE:` vs.
   „Recommendations"-Schnitt)? (Empfehlung: Marker, vom Orchestrator-Prompt
   gefordert.)
