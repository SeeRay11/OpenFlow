#!/usr/bin/env bash
# OpenFlow headless, in two modes:
#
#   of-run.sh <pipeline> <task words...>       detached (setsid); prints PID/LOG
#   of-run.sh --wait <pipeline> <task...>      blocks until the run ends; prints
#                                              LOG= first, then a summary (verdict,
#                                              start of ergebnis.md, checkpoint:,
#                                              ergebnis: as LAST line) and exits
#                                              with the run's code. Meant for a
#                                              BACKGROUND shell (opencode
#                                              shell{background:true}: no timeout,
#                                              the end wakes the caller with this
#                                              stdout). In a FOREGROUND agent shell
#                                              the shell timeout (120 s) kills it —
#                                              there, start detached.
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
# Every start reaps first so the run list stays honest — rule and thresholds
# in of-lebendig.ts (one source with of-loop; a living process is never reaped
# inside the card timeout + buffer).
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

# Zombie-Reap vor jedem Start. KEINE eigene Schwelle (W2.1): hier stand 15 min,
# in of-loop 10, das Karten-Timeout ist 30 — lebende Karten wurden erschossen.
# Regel und Zahlen stehen in of-lebendig.ts. Sichtbar gescheitert ist besser
# als still gescheitert: der Reap darf melden, den Start aber nie blockieren.
# Ausgabe nach stderr: im --wait-Modus ist stdout die Fertig-Meldung.
"$BUN" "$ROOT/packages/flow/scripts/of-reap.ts" 2>&1 | head -2 >&2 || true

# --wait: Zusammenfassung für die Fertig-Meldung des Aufrufers (W0-Spike
# 23.10.2026: opencode liefert die STDOUT eines Hintergrund-Shellbefehls als
# Meldung an die Eltern-Sitzung). Verdict, Anfang der ergebnis.md, dann
# checkpoint: und ergebnis: — die ergebnis:-Zeile ist die LETZTE (Leser nehmen
# den letzten Treffer; ein Modelltext kann Zeilen derselben Form tragen).
ERGEBNIS_AUSZUG="${OPENFLOW_ERGEBNIS_AUSZUG:-3000}"
zusammenfassung() {
  local log="$1" rc="$2" erg cp verdict n
  # jeder Pfad, nicht nur /…: auf Windows heißen sie C:\… (CI-Lauf 23.10.:
  # mit '^ergebnis: /' gewann die Zeile eines Modelltexts)
  erg=$(grep -a '^ergebnis: .' "$log" 2>/dev/null | tail -1 | sed 's/^ergebnis: //') || true
  cp=$(grep -a '^checkpoint: .' "$log" 2>/dev/null | tail -1 | sed 's/^checkpoint: //') || true
  verdict=$(grep -a '^verdict: ' "$log" 2>/dev/null | tail -1) || true
  echo "${verdict:-verdict: UNBEKANNT — kein Abschluss im Log}"
  echo "exit: $rc"
  if [ -n "$erg" ] && [ -f "$erg" ]; then
    n=$(wc -c < "$erg" | tr -d ' ')
    echo "--- ergebnis.md (Anfang) ---"
    if command -v iconv >/dev/null 2>&1; then head -c "$ERGEBNIS_AUSZUG" "$erg" | iconv -f utf-8 -t utf-8 -c; else head -c "$ERGEBNIS_AUSZUG" "$erg"; fi
    echo
    if [ "$n" -gt "$ERGEBNIS_AUSZUG" ]; then echo "--- gekürzt: $ERGEBNIS_AUSZUG von $n Byte, vollständig in der ergebnis.md ---"; fi
  else
    echo "--- keine ergebnis.md; Log-Ende ---"
    tail -n 20 "$log" 2>/dev/null || true
  fi
  if [ -n "$cp" ]; then echo "checkpoint: $cp"; fi
  if [ -n "$erg" ]; then echo "ergebnis: $erg"; fi
  return 0
}

if [ "$MODE" = "wait" ]; then
  # Ab dem Aufruf von headless-run ist der Lauf gestartet; sein Ergebnis
  # meldet er selbst (Log + Checkpoint + ergebnis.md), nicht diese Falle.
  GESTARTET=1
  # LOG= VOR dem Start: das fabrik-gate-Plugin und ein Leser, der mitten im
  # Lauf nachsieht, finden das Log, ohne auf das Ende zu warten.
  echo "LOG=$LOG"
  RC=0
  # A9: früher `|| true` — --wait meldete jeden Lauf mit Exit 0.
  "$BUN" "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 || RC=$?
  zusammenfassung "$LOG" "$RC"
  exit "$RC"
else
  setsid nohup "$BUN" "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 < /dev/null &
  GESTARTET=1
  echo "PID=$!"
fi
echo "LOG=$LOG"
