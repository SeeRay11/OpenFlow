#!/usr/bin/env bash
# OpenFlow launcher (macOS / Linux)
#
# Starts both processes OpenFlow needs and wires them together:
#   1. opencode serve  — the headless engine that drives the agents
#   2. the flow canvas — the SolidJS UI at http://localhost:5174
#
# The engine starts first; we wait until its port is actually listening (~30s
# cold) before launching the canvas so the UI never comes up talking to a server
# that is not there yet. Ctrl+C stops both.
#
# Usage:
#   ./openflow.sh                       # dev canvas, agents work in this repo
#   ./openflow.sh -p ~/code/my-app      # point the agents at another repo
#   ./openflow.sh -b                    # serve the built bundle (no vite)
#   ./openflow.sh -s 4097               # use a non-default engine port
#
# Before the first run: log in a provider (`opencode auth login`, a provider env
# var, or OPENCODE_AUTH_CONTENT). Flow inherits the server's credentials; an empty
# model dropdown means no auth.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project=""
server_port=4096
built=0
startup_timeout=90

while getopts "p:s:bh" opt; do
  case "$opt" in
    p) project="$OPTARG" ;;
    s) server_port="$OPTARG" ;;
    b) built=1 ;;
    h) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown flag. Use -h for help." >&2; exit 1 ;;
  esac
done

command -v bun >/dev/null 2>&1 || {
  echo "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run." >&2
  exit 1
}

# Keep the canvas proxy pointed at whatever engine port we use.
export OPENCODE_SERVER_URL="http://127.0.0.1:${server_port}"
if [ -n "$project" ]; then
  export OPENFLOW_PROJECT="$(cd "$project" && pwd)"
fi
project_display="${OPENFLOW_PROJECT:-$repo (this repo)}"

echo
echo "OpenFlow"
echo "  engine   : $OPENCODE_SERVER_URL"
echo "  project  : $project_display"
echo "  canvas   : http://localhost:5174"
echo

server_pid=""
cleanup() {
  echo
  echo "Stopping engine..."
  # Kill the whole process group; bun spawns a child that holds the port.
  [ -n "$server_pid" ] && kill -- -"$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting engine (opencode serve)..."
# setsid gives the engine its own process group so cleanup can take the tree.
setsid bun run --cwd "$repo/packages/opencode" --conditions=browser \
  src/index.ts serve --port "$server_port" &
server_pid=$!

# Poll the port instead of sleeping a fixed amount — cold starts vary.
deadline=$(( $(date +%s) + startup_timeout ))
until (exec 3<>"/dev/tcp/127.0.0.1/${server_port}") 2>/dev/null; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Engine exited during startup. Check the output above." >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Engine did not start listening on ${server_port} within ${startup_timeout}s." >&2
    exit 1
  fi
  sleep 0.5
done
exec 3<&- 3>&- 2>/dev/null || true
echo "Engine listening on ${server_port}."

echo "Starting canvas — open http://localhost:5174"
echo "Press Ctrl+C to stop both."
echo
if [ "$built" -eq 1 ]; then
  bun run --cwd "$repo/packages/flow" build
  bun run --cwd "$repo/packages/flow" start
else
  bun run --cwd "$repo/packages/flow" dev
fi
