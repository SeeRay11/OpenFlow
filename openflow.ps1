# OpenFlow launcher (Windows / PowerShell) — thin shim over `bun openflow.ts`.
#
# The launcher itself is cross-platform and lives in `openflow.ts`. This shim
# holds no launcher logic: it only translates the PowerShell-idiomatic switches
# into the environment variables the TS launcher already honours, then hands
# off. `openflow.sh` does the same for POSIX flags, so the two cannot drift.
#
# Usage:
#   ./openflow.ps1                          # agents work in this repo
#   ./openflow.ps1 -Project C:\code\my-app  # point the agents at another repo
#   ./openflow.ps1 -Built                   # serve the built bundle (no vite)

[CmdletBinding()]
param(
    # Repo the agents read and write. These agents edit real files — point this
    # at the project you actually want changed.
    [string]$Project,

    # Build the canvas and serve it with `server.ts` instead of running vite.
    [switch]$Built,

    [switch]$Help
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

if ($Help) {
    Write-Host @"
OpenFlow — starts the canvas, then opens the browser.

Usage: ./openflow.ps1 [-Project <dir>] [-Built] [-Help]

  -Project <dir>    Repo the agents read and write (default: this repo).
                    These agents edit real files — point this at the project
                    you actually want changed.
  -Built            Serve the built bundle instead of the vite dev server.
  -Help             Show this help. (PowerShell answers -? itself, with the
                    one-line parameter syntax.)

Environment:
  OPENFLOW_DRY_RUN=1   Print the resolved plan and exit without starting
                       anything — useful for checking how flags resolved.

Cards run on omp, which must be on PATH: the launcher prints the version it
finds, or what to fix, and starts either way. Connect a provider before the
first run: open Omp settings in the canvas and log in. An empty model menu
means no provider is connected.
"@
    exit 0
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run."
    exit 1
}

if ($Project) {
    # Resolve-Path throws a raw provider exception on a bad path; say what is
    # actually wrong instead.
    $resolved = Resolve-Path -LiteralPath $Project -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Write-Host "Project directory not found: $Project" -ForegroundColor Red
        exit 1
    }
    $env:OPENFLOW_PROJECT = $resolved.Path
}
if ($Built) { $env:OPENFLOW_BUILT = "1" }

bun (Join-Path $repo "openflow.ts")
exit $LASTEXITCODE
