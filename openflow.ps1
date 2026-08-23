# OpenFlow launcher (Windows / PowerShell) — thin shim over `bun openflow.ts`.
#
# The launcher itself is cross-platform and lives in `openflow.ts`. This shim
# stays so existing Windows muscle memory (`./openflow.ps1`) keeps working; it
# only translates the two common switches into the environment variables the
# TS launcher already honours, then hands off.
#
# Usage:
#   ./openflow.ps1                          # agents work in this repo
#   ./openflow.ps1 -Project C:\code\my-app  # point the agents at another repo
#   ./openflow.ps1 -ServerPort 4097         # use a non-default engine port

[CmdletBinding()]
param(
    # Repo the agents read and write. These agents edit real files — point this
    # at the project you actually want changed.
    [string]$Project,

    # Port for `opencode serve`. The canvas proxy is pointed here automatically.
    [int]$ServerPort = 4096
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run."
    exit 1
}

$env:OPENCODE_SERVER_URL = "http://127.0.0.1:$ServerPort"
if ($Project) {
    $env:OPENFLOW_PROJECT = (Resolve-Path $Project).Path
}

bun (Join-Path $repo "openflow.ts")
