#!/usr/bin/env bash
# OpenFlow launcher (macOS / Linux) — thin shim over `bun openflow.ts`.
#
# The launcher itself is cross-platform and lives in `openflow.ts`. This shim
# holds no launcher logic: it only translates the POSIX-style flags into the
# environment variables the TS launcher already honours, then hands off.
# `openflow.ps1` does the same for PowerShell, so the two cannot drift — and
# the shared implementation is what brought stale-port freeing, reuse of an
# already-running process, and opening the browser to this platform. It also
# removed this script's dependency on `setsid`, which stock macOS does not ship.
#
# Usage:
#   ./openflow.sh                       # dev canvas, agents work in this repo
#   ./openflow.sh -p ~/code/my-app      # point the agents at another repo
#   ./openflow.sh -b                    # serve the built bundle (no vite)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project=""

usage() {
  cat <<'EOF'
OpenFlow — starts the canvas, then opens the browser.

Usage: ./openflow.sh [-p <dir>] [-b] [-h]

  -p, --project <dir>      Repo the agents read and write (default: this repo).
                           These agents edit real files — point this at the
                           project you actually want changed.
  -b, --built              Serve the built bundle instead of the vite dev server.
  -h, --help               Show this help.

Environment:
  OPENFLOW_DRY_RUN=1   Print the resolved plan and exit without starting
                       anything — useful for checking how flags resolved.

Cards run on omp, which must be on PATH: the launcher prints the version it
finds, or what to fix, and starts either way. Connect a provider before the
first run: open Omp settings in the canvas and log in. An empty model menu
means no provider is connected.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--project)
      [ $# -ge 2 ] || { echo "$1 needs a directory. Use -h for help." >&2; exit 1; }
      project="$2"; shift 2 ;;
    -b|--built) export OPENFLOW_BUILT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1. Use -h for help." >&2; exit 1 ;;
  esac
done

command -v bun >/dev/null 2>&1 || {
  echo "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run." >&2
  exit 1
}

if [ -n "$project" ]; then
  [ -d "$project" ] || { echo "Project directory not found: $project" >&2; exit 1; }
  OPENFLOW_PROJECT="$(cd "$project" && pwd)"
  export OPENFLOW_PROJECT
fi

exec bun "$repo/openflow.ts"
