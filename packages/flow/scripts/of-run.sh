#!/usr/bin/env bash
# OpenFlow headless, in two modes:
#
#   of-run.sh <pipeline> <task words...>       detached (setsid); prints PID/LOG
#   of-run.sh --wait <pipeline> <task...>      foreground; exits with the run's code
#   of-run.sh --resume <checkpoint|run-id> [task...]
#                                              continue an interrupted run: done
#                                              cards keep their output, the rest
#                                              continue in their sessions
#
#   of-run.sh --nutzung [TAGE]                    Nutzungsanalyse in einem
#                                              Befehl (of-nutzung.ts; Ledger-
#                                              Tabelle, opencode.log-Treffer,
#                                              Scorecard-Kopf, Loop-Sonde;
#                                              Default-Fenster 6 Tage)
#   of-run.sh --reap [flags]                   zombie runs beg (of-reap.ts;
#                                              --dry-run --min-age-min 30 ...)
#   of-run.sh --scorecard [flags]              verdict statistics over all runs
#                                              (of-scorecard.ts; --limit N --json)
#
# Every start reaps first (15 min silence = dead) so the run list stays honest.
# Failed runs retry themselves once via checkpoint-resume (OPENFLOW_AUTO_RETRY,
# default 1) and end with a SCORECARD block on stdout.
#
# Prints LOG=<path> so a caller picks results up without knowing the internals;
# the run's own "checkpoint: <path>" line is the LAST line of the log (stdout,
# after every card output) and names the JSON to read — take the last match,
# a card's model text can carry a line of the same shape (Befund (c)).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"
ENTRY="$ROOT/packages/flow/scripts/headless-run.ts"
# cron-Umgebungen haben kein bun im PATH — der eigene Interpreter, hart
# abgefallen auf den Installationspfad, funktioniert überall.
BUN="${BUN:-$(command -v bun || true)}"
[ -z "$BUN" ] && [ -x "$HOME/.local/bin/bun" ] && BUN="$HOME/.local/bin/bun"
[ -z "$BUN" ] && BUN="bun"

if [ "${1:-}" = "--scorecard" ]; then shift; exec "$BUN" "$ROOT/packages/flow/scripts/of-scorecard.ts" "$@"; fi
if [ "${1:-}" = "--reap" ]; then shift; exec "$BUN" "$ROOT/packages/flow/scripts/of-reap.ts" "$@"; fi
if [ "${1:-}" = "--loop" ]; then shift; exec "$BUN" "$ROOT/packages/flow/scripts/of-loop.ts" "$@"; fi
if [ "${1:-}" = "--loop-check" ]; then shift; exec "$BUN" "$ROOT/packages/flow/scripts/of-loopcheck.ts" "$@"; fi
if [ "${1:-}" = "--nutzung" ]; then shift; exec "$BUN" "$ROOT/packages/flow/scripts/of-nutzung.ts" "$@"; fi

# Defekt 5 (17.10.2026 13:30): ein Start endete vor dem Log-Anlegen (die
# aufrufende Shell lief mit 60 ms Timeout ab) — kein Log, kein Run, keine
# Meldung; das Ledger führte ihn als Start. Ab hier (Monitoring ist per exec
# schon weg) wird jedes Ende VOR dem Start sichtbar: Meldung auf stderr, Exit
# ≠ 0 und eine Ledger-Zeile event=fabrik_start_fehlgeschlagen. Gegen SIGKILL
# hilft keine Falle — das fängt das fabrik-gate-Plugin (Start ohne LOG= in der
# Ausgabe → dieselbe Ledger-Zeile).
LEDGER="${OPENFLOW_LEDGER:-$HOME/.openflow/gate-ledger.jsonl}"
GESTARTET=0
FRUEH_GRUND=""
FRUEH_PIPELINE="${1:-}"
LOG=""
json_text() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; printf '%s' "$s"; }
frueh_abbruch() {
  local code=$?
  [ "$GESTARTET" = 1 ] && return 0
  [ "$code" = 0 ] && code=1
  local grund="${FRUEH_GRUND:-exit $code vor dem Start}"
  mkdir -p "$(dirname "$LEDGER")" 2>/dev/null || true
  # session_id/aufruf_id setzt das fabrik-gate-Plugin vor den Befehl — damit
  # zieht die Scorecard genau diesen Start von den echten Starts ab.
  local sid="${OPENFLOW_SESSION:-}" aid="${OPENFLOW_AUFRUF_ID:-}"
  printf '{"ts":"%s","event":"fabrik_start_fehlgeschlagen","quelle":"of-run.sh","grund":"%s","exit":%s,"pipeline":"%s","pid":%s,"log":%s,"session_id":%s,"aufruf_id":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$(json_text "$grund")" "$code" "$(json_text "$FRUEH_PIPELINE")" "$$" \
    "$([ -n "$LOG" ] && printf '"%s"' "$(json_text "$LOG")" || printf null)" \
    "$([ -n "$sid" ] && printf '"%s"' "$(json_text "$sid")" || printf null)" \
    "$([ -n "$aid" ] && printf '"%s"' "$(json_text "$aid")" || printf null)" >> "$LEDGER" 2>/dev/null || true
  [ -n "$LOG" ] && echo "of-run.sh: Start abgebrochen ($grund, exit $code)" >> "$LOG" 2>/dev/null
  echo "of-run.sh: Start abgebrochen ($grund, exit $code) — kein Lauf; Eintrag in $LEDGER" >&2
  exit "$code"
}
trap frueh_abbruch EXIT
trap 'FRUEH_GRUND="signal TERM"; exit 143' TERM
trap 'FRUEH_GRUND="signal INT"; exit 130' INT
trap 'FRUEH_GRUND="signal HUP"; exit 129' HUP

# Riegel gegen verschachtelte Runs (Abnahme 12.10.2026: eine Boss-Karte
# startete drei weitere Runs, Kosten x4). Karten-Shells erben die Umgebung der
# dauerhaft laufenden Engine, nicht die des Runs — deshalb prüft of-guard.ts die
# Herkunft (OPENFLOW_ENGINE bzw. Engine als Vorfahre), keine Run-Variable.
# Monitoring oben (--scorecard/--reap/--loop/--loop-check/--nutzung) bleibt frei.
"$BUN" "$ROOT/packages/flow/scripts/of-guard.ts" || { rc=$?; FRUEH_GRUND="of-guard lehnt ab (verschachtelter Start)"; exit $rc; }

MODE=detached
RESUME_ARGS=()
if [ "${1:-}" = "--wait" ]; then MODE=wait; shift; fi
if [ "${1:-}" = "--resume" ]; then
  if [ $# -lt 2 ]; then echo "of-run.sh: --resume braucht eine checkpoint-id oder einen Pfad" >&2; FRUEH_GRUND="--resume ohne checkpoint"; exit 2; fi
  MODE=wait; RESUME_ARGS=(--resume "$2"); shift 2
fi
SPREAD_ARGS=()
if [ "${1:-}" = "--spread" ]; then SPREAD_ARGS=(--spread); shift; fi

PIPELINE="${1:-}"
# Unbekannter Schalter ist keine Pipeline (Abnahme R18 K10: `of-run.sh
# --status` startete einen Lauf mit der Pipeline "--status", 404 und
# uncaughtException im Log). Abgelehnt, bevor irgendetwas startet.
case "$PIPELINE" in
  -*)
    echo "of-run.sh: unbekannter Schalter '$PIPELINE'" >&2
    echo "usage: of-run.sh [--wait] [--resume <checkpoint|run-id>] [--spread] <pipeline> <task...>" >&2
    echo "       of-run.sh --scorecard|--reap|--loop|--loop-check|--nutzung [flags]" >&2
    FRUEH_GRUND="unbekannter Schalter $PIPELINE"
    exit 2
    ;;
esac
[ $# -gt 0 ] && shift
# --resume ohne Pipeline-Aufruf: der Name dient nur dem Log; headless-run
# überschreibt ihn mit log.pipeline aus dem Checkpoint.
if [ -z "$PIPELINE" ]; then PIPELINE="resume"; fi
STAMP=$(date +%Y%m%d-%H%M%S)-$$
LOG="${OPENFLOW_LOG_DIR:-/tmp}/of-run-${PIPELINE}-${STAMP}.log"
FRUEH_PIPELINE="$PIPELINE"

# Zombie-Reap vor jedem Start: 15 Minuten stummer Checkpoint = Prozessor tot.
# Sichtbar gescheitert ist besser als still gescheitert: der Reap darf ins
# Log scheiben, er darf den Start nur bei Reap-HÄRTEN nicht blocken.
"$BUN" "$ROOT/packages/flow/scripts/of-reap.ts" --min-age-min 15 --grace-min 5 2>&1 | head -2 || true

if [ "$MODE" = "wait" ]; then
  # Ab dem Aufruf von headless-run ist der Lauf gestartet; sein Ergebnis
  # meldet er selbst (Log + Checkpoint), nicht diese Falle.
  GESTARTET=1
  "$BUN" "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 || true
else
  setsid nohup "$BUN" "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 < /dev/null &
  GESTARTET=1
  echo "PID=$!"
fi
echo "LOG=$LOG"
