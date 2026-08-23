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
#   ./openflow.ps1 -ServerPort 4097         # use a non-default engine port
#   ./openflow.ps1 -Built                   # serve the built bundle (no vite)
#   ./openflow.ps1 -Manage                  # let the canvas own the engine

[CmdletBinding()]
param(
    # Repo the agents read and write. These agents edit real files — point this
    # at the project you actually want changed.
    [string]$Project,

    # Port for `opencode serve`. The canvas proxy is pointed here automatically.
    [int]$ServerPort = 4096,

    # Build the canvas and serve it with `server.ts` instead of running vite.
    [switch]$Built,

    # Hand the engine to the canvas: it spawns it, waits for it, and can then
    # restart it from the UI. The server has no shutdown route, so only the
    # process that started it can do that.
    [switch]$Manage,

    [switch]$Help
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

if ($Help) {
    Write-Host @"
OpenFlow — starts the engine and the canvas, then opens the browser.

Usage: ./openflow.ps1 [-Project <dir>] [-ServerPort <n>] [-Built] [-Manage] [-Help]

  -Project <dir>    Repo the agents read and write (default: this repo).
                    These agents edit real files — point this at the project
                    you actually want changed.
  -ServerPort <n>   Port for ``opencode serve`` (default: 4096).
  -Built            Serve the built bundle instead of the vite dev server.
  -Manage           Let the canvas own the engine, which enables the UI's
                    "restart engine" button.
  -Help             Show this help. (PowerShell answers -? itself, with the
                    one-line parameter syntax.)

Environment:
  OPENFLOW_DRY_RUN=1   Print the resolved plan and exit without starting
                       anything — useful for checking how flags resolved.

Connect a provider before the first run: click "api keys" in the canvas
titlebar, pick a provider, paste its key — models appear immediately. Keys the
opencode CLI already holds are offered for import there; the server does not
read its ``auth.json`` for the model catalog, so importing is what makes them
count. An empty model menu means no provider is connected.
"@
    exit 0
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run."
    exit 1
}

$env:OPENCODE_SERVER_URL = "http://127.0.0.1:$ServerPort"
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
if ($Manage) { $env:FLOW_MANAGE_SERVER = "1" }

bun (Join-Path $repo "openflow.ts")
exit $LASTEXITCODE
