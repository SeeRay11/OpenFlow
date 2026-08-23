# OpenFlow launcher (Windows / PowerShell)
#
# Starts both processes OpenFlow needs and wires them together:
#   1. opencode serve  — the headless engine that drives the agents
#   2. the flow canvas — the SolidJS UI at http://localhost:5174
#
# The server is started first and we wait until its port is actually listening
# (it takes ~30s cold) before launching the canvas, so the UI never comes up
# talking to a server that is not there yet. Ctrl+C stops both.
#
# Usage:
#   ./openflow.ps1                          # dev canvas, agents work in this repo
#   ./openflow.ps1 -Project C:\code\my-app  # point the agents at another repo
#   ./openflow.ps1 -Built                   # serve the built bundle (no vite)
#   ./openflow.ps1 -ServerPort 4097         # use a non-default engine port
#   ./openflow.ps1 -Manage                  # let the canvas own the engine, so its
#                                           # "restart engine" button works
#
# Before the first run: log in a provider (`opencode auth login`, a provider env
# var, or OPENCODE_AUTH_CONTENT). Flow inherits the server's credentials; an empty
# model dropdown means no auth.

[CmdletBinding()]
param(
    # Repo the agents read and write. Defaults to this checkout. These agents
    # edit real files — point this at the project you actually want changed.
    [string]$Project,

    # Port for `opencode serve`. The canvas proxy is pointed here automatically.
    [int]$ServerPort = 4096,

    # Serve the built bundle via server.ts instead of the vite dev server.
    [switch]$Built,

    # Seconds to wait for the engine to start listening before giving up.
    [int]$StartupTimeout = 90,

    # Hand the engine to the canvas instead of starting it here. The canvas then
    # holds the process handle, which is what its "restart engine" button needs —
    # the server has no shutdown route, so only its parent can restart it.
    # Without this the button still works, but only to show the command.
    [switch]$Manage
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install Bun 1.3+ from https://bun.sh then re-run."
    exit 1
}

# The canvas talks to the engine through this URL; keep them in lock-step so a
# custom -ServerPort still reaches the right server.
$serverUrl = "http://127.0.0.1:$ServerPort"
$env:OPENCODE_SERVER_URL = $serverUrl
if ($Project) {
    $env:OPENFLOW_PROJECT = (Resolve-Path $Project).Path
}
$projectDisplay = if ($env:OPENFLOW_PROJECT) { $env:OPENFLOW_PROJECT } else { "$repo (this repo)" }

Write-Host ""
Write-Host "OpenFlow" -ForegroundColor Cyan
Write-Host "  engine   : $serverUrl"
Write-Host "  project  : $projectDisplay"
Write-Host "  canvas   : http://localhost:5174"
Write-Host ""

$server = $null

if ($Manage) {
    $env:FLOW_MANAGE_SERVER = "1"
    Write-Host "  engine   : started and owned by the canvas (-Manage)" -ForegroundColor DarkGray
}

# Kill a process and its children (bun spawns a tree; a bare Stop-Process on the
# parent leaves the real server orphaned holding the port).
function Stop-Tree($proc) {
    if ($proc -and -not $proc.HasExited) {
        taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
}

try {
    if ($Manage) {
        # The canvas spawns the engine itself and waits for it before serving,
        # so there is nothing to start or poll here.
        Write-Host "Starting canvas — open http://localhost:5174" -ForegroundColor Green
        Write-Host "Press Ctrl+C to stop both." -ForegroundColor DarkGray
        Write-Host ""
        if ($Built) {
            bun run --cwd (Join-Path $repo "packages/flow") build
            bun run --cwd (Join-Path $repo "packages/flow") start
        } else {
            bun run --cwd (Join-Path $repo "packages/flow") dev
        }
        exit 0
    }

    Write-Host "Starting engine (opencode serve)..." -ForegroundColor DarkGray
    $server = Start-Process -PassThru -NoNewWindow -WorkingDirectory $repo bun `
        -ArgumentList @(
            "run", "--cwd", "packages/opencode", "--conditions=browser",
            "src/index.ts", "serve", "--port", "$ServerPort"
        )

    # Wait for the port to accept a TCP connection. Polling the socket is more
    # reliable than a fixed sleep — cold starts vary.
    $deadline = (Get-Date).AddSeconds($StartupTimeout)
    $listening = $false
    while ((Get-Date) -lt $deadline) {
        if ($server.HasExited) {
            Write-Error "Engine exited during startup (code $($server.ExitCode)). Check the output above."
            exit 1
        }
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $client.Connect("127.0.0.1", $ServerPort)
            $listening = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        } finally {
            $client.Dispose()
        }
    }
    if (-not $listening) {
        Write-Error "Engine did not start listening on $ServerPort within ${StartupTimeout}s."
        exit 1
    }
    Write-Host "Engine listening on $ServerPort." -ForegroundColor Green

    # Canvas runs in the foreground so its logs stream here and Ctrl+C lands in
    # the finally block, which stops the engine too.
    Write-Host "Starting canvas — open http://localhost:5174" -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop both." -ForegroundColor DarkGray
    Write-Host ""
    if ($Built) {
        bun run --cwd (Join-Path $repo "packages/flow") build
        bun run --cwd (Join-Path $repo "packages/flow") start
    } else {
        bun run --cwd (Join-Path $repo "packages/flow") dev
    }
} finally {
    Write-Host ""
    Write-Host "Stopping engine..." -ForegroundColor DarkGray
    Stop-Tree $server
}
