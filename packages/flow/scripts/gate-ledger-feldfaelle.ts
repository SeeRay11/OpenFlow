/**
 * Feldfälle aus ~/.openflow/gate-ledger.jsonl (Woche 16.–23.10.2026),
 * gekürzt und anonymisiert (Heimatpfad → /home/nutzer, Session-IDs ersetzt,
 * Auftragstexte verkürzt). Befehle stehen so, wie das Plugin sie ablegt:
 * auf 200 Zeichen gekürzt — ein Heredoc kann deshalb offen enden.
 *
 * FABRIK_RUN_ZEILEN: alle event=fabrik_run der Woche mit Ledger-Zeilennummer
 * und der Art, die der Aufruf WIRKLICH hatte (nachgesehen im vollständigen
 * Befehl in der opencode-Datenbank):
 *   L670  `cat > plugin-test.mjs <<'EOF'` — of-run.sh nur im Heredoc-Rumpf;
 *         der echte Aufruf dahinter war `of-run.sh --scorecard` (abgeschnitten)
 *   L653  `of-run.sh --loop-check; …` — Monitoring, ohne Flag abgelegt
 *   L682  echter Start, der wegen eines 60-ms-Shell-Timeouts nie ein Log
 *         anlegte (Defekt 5) — als AUFRUF ein Start
 * Run-Datensätze derselben Woche: 4 (17.10. 09:10, 17.10. 13:32, 21.10. 16:18,
 * 21.10. 17:26 — der letzte nicht aus dem Plugin gestartet).
 */
import type { OfRunArt } from "./of-fabrik-aufruf"

export const FABRIK_RUN_ZEILEN: { zeile: number; eintrag: Record<string, unknown>; soll: OfRunArt | null }[] = [
  {
    zeile: 638,
    soll: "start",
    eintrag: { ts: "2026-10-17T09:10:37.522Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow && setsid nohup bash packages/flow/scripts/of-run.sh auto-orchestrator "Lies die README.md im Repo-Root von /home/nutzer/workspace/OpenFlow und schreibe eine 3-saetzig', session_id: "ses_A", task_ref: null },
  },
  {
    zeile: 653,
    soll: "monitoring",
    eintrag: { ts: "2026-10-17T09:39:33.068Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow && echo "=== LOOP-CHECK ==="; bash packages/flow/scripts/of-run.sh --loop-check; echo "LOOP-CHECK-EXIT: $?"; echo; echo "=== SCORECARD ==="; timeout 60 bash packages/', session_id: "ses_B", task_ref: null },
  },
  {
    zeile: 656,
    soll: "monitoring",
    eintrag: { ts: "2026-10-17T09:46:03.770Z", event: "fabrik_run", command: "cd /home/nutzer/workspace/OpenFlow && bash packages/flow/scripts/of-run.sh --scorecard 2>&1 | sed -n '/## Regeltreue/,$p'", session_id: "ses_B", task_ref: "9bbe39ff8e", monitoring: true },
  },
  {
    zeile: 669,
    soll: "monitoring",
    eintrag: { ts: "2026-10-17T12:37:50.655Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow/packages/flow && bun test scripts/scorecard.test.ts 2>&1 | tail -6; echo; echo "=== Live-Scorecard (Phantom-Row-Prüfung) ==="; bash packages/flow/scripts/of-run.sh --', session_id: "ses_B", task_ref: null, monitoring: true },
  },
  {
    zeile: 670,
    soll: null,
    eintrag: { ts: "2026-10-17T12:39:01.002Z", event: "fabrik_run", command: "cat > /tmp/opencode/plugin-test.mjs <<'EOF'\nimport {readFileSync} from 'fs'\nfor (const f of ['/home/nutzer/.config/opencode/plugins/fabrik-gate.ts','/home/nutzer/.config/opencode/plugins-v1/fabrik-gate.", session_id: "ses_B", task_ref: null },
  },
  {
    zeile: 682,
    soll: "start",
    eintrag: { ts: "2026-10-17T13:30:26.718Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow && bash packages/flow/scripts/of-run.sh auto-orchestrator "Register-Audit des Astroworld-Fallregisters packages/workers/wortwert/scripts/register/astroworld.jsonl (Re', session_id: "ses_C", task_ref: null },
  },
  {
    zeile: 684,
    soll: "start",
    eintrag: { ts: "2026-10-17T13:32:26.277Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow && nohup bash packages/flow/scripts/of-run.sh auto-orchestrator "Register-Audit des Astroworld-Fallregisters /home/nutzer/workspace/mcp-workers/packages/workers/wortwe', session_id: "ses_C", task_ref: "3bc93a3b24" },
  },
  {
    zeile: 740,
    soll: "monitoring",
    eintrag: { ts: "2026-10-17T23:46:50.952Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow/packages/flow && (bun typecheck 2>&1 | tail -2 || true); echo "=== live-scorecard (nur regeltreue-sektion) ==="; bash scripts/of-run.sh --scorecard 2>/dev/null | sed ', session_id: "ses_B", task_ref: null, monitoring: true },
  },
  {
    zeile: 949,
    soll: "start",
    eintrag: { ts: "2026-10-21T16:18:39.500Z", event: "fabrik_run", command: 'cd /home/nutzer/workspace/OpenFlow && bash packages/flow/scripts/of-run.sh auto-orchestrator "TIEFENANALYSE aller 44 Massen-Disaster-Events mit WortWert MCP v9.458.0 und Wikidata. \n\nFÜR JEDES EVENT (Li', session_id: "ses_C", task_ref: "b24ad55163" },
  },
]

/** Der vollständige Befehl hinter L670 (opencode-Datenbank), gekürzt auf das Wesentliche. */
export const L670_VOLL = `cat > /tmp/opencode/plugin-test.mjs <<'EOF'
import {readFileSync} from 'fs'
  const cases = [
    ['bash of-run.sh --loop-check; echo x', true],
    ['bash of-run.sh auto-orchestrator "task"', false],
    ['bash of-run.sh --resume ~/.openflow/checkpoint.json', false],
  ]
EOF
bun /tmp/opencode/plugin-test.mjs
cd /home/nutzer/workspace/OpenFlow && bash packages/flow/scripts/of-run.sh --scorecard 2>/dev/null | head`

/**
 * Empfehlungen der Woche in der Form des Ledgers (anonymisiert): je eine
 * user_prompt- und task-FABRIK-Zeile mit Folge bzw. ohne. task-Zeilen trugen
 * bis zu diesem Fix IMMER injiziert:false (194 von 194).
 */
export const EMPFEHLUNGEN_WOCHE = [
  // ses_C: Nutzer-Auftrag mit Pflichtweg, 2 min später Fabrik-Start (L684-Muster)
  { ts: "2026-10-17T13:28:10.000Z", event: "user_prompt", session_id: "ses_C", entscheidung: "FABRIK", injiziert: true, signale: ["analyse"], task: "Register-Audit …" },
  // ses_B: Pflichtweg, danach nur Monitoring-Sonden (L653/L656) — keine Befolgung
  { ts: "2026-10-17T09:38:00.000Z", event: "user_prompt", session_id: "ses_B", entscheidung: "FABRIK", injiziert: true, signale: ["review"], task: "Prüfe alle …" },
  // ses_A: task-FABRIK, nie zugestellt (injiziert:false, Defekt 1)
  { ts: "2026-10-16T19:40:00.000Z", event: "task", quelle: "subagent", session_id: "ses_A", gate_id: "aaaaaaaaaa", entscheidung: "FABRIK", injiziert: false, signale: ["fan-out-quantor"], task: "Prüfe nachweislich …" },
]
