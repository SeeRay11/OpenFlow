# OpenFlow

**OpenFlow is a visual builder for multi-agent AI workflows.** Drag role cards
onto a canvas, wire a pipeline (planner → architect → coder), save it, and run it
with real parallel agents.

![OpenFlow pipeline](assets/openflow-pipeline.png)

OpenFlow is its own project. It is built on — and ships as a fork of —
[opencode](https://github.com/anomalyco/opencode), whose headless engine
(`opencode serve`) drives the agents underneath. All of OpenFlow's own code lives
in [`packages/flow`](packages/flow); no upstream package is modified, so the
OpenCode engine stays current and upstream merges stay clean. The original
OpenCode README follows below.

### Install

**Prerequisites**

- [Bun](https://bun.sh) 1.3 or newer — the only runtime OpenFlow needs (it runs
  the engine, the build, and the canvas). `bun --version` to check.
- [Git](https://git-scm.com).

**Get the code**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` pulls the whole workspace — the OpenCode engine plus OpenFlow's own
code in [`packages/flow`](packages/flow). First install is large; it downloads the
engine's native deps and runs a `postinstall` that marks the engine's prebuilt
`node-pty` helpers executable — a no-op on Windows.

### Stop anything already running

OpenFlow uses two ports: **4096** for the engine and **5174** for the canvas. If a
previous run is still holding them, starting the engine by hand fails with
`Error: Unexpected error` / `ServeError` — that is a port already bound, not a
broken install.

`bun openflow.ts` handles this for you: it reuses a port that is already serving
and frees one a dead run left bound. Kill the old processes yourself only when
you want a genuinely fresh engine — after editing `opencode.json`, for example,
since the engine caches project config at boot and never re-reads it.

**Windows (PowerShell)**

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { taskkill /pid $_ /T /F }
```

**macOS / Linux**

```bash
lsof -t -i :4096 -i :5174 | xargs kill -9
```

Both are safe to run when nothing is listening — they simply match no process.
They kill *any* process on those ports, so check first if you run something else
there:

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

**If the engine fails with `database is locked`,** another opencode engine is
already running somewhere else — a second copy of OpenFlow, or one a previous
launcher left behind. Every engine shares a single database in your opencode data
directory, so the second one to start cannot open it. Freeing the ports does not
help here, because that engine need not be holding them. Stop it by what it is
running instead:

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'openflow\.ts|src/index\.ts serve|packages/flow dev' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```bash
pkill -f 'openflow\.ts|src/index\.ts serve|packages/flow dev'
```

Then start OpenFlow again. If it happens every time, you most likely have OpenFlow
cloned in two places and both are being started — keep one.

### Run it

One command starts both processes. Setting the variable is the only part that
differs per shell, so pick the line for the terminal you are in.

PowerShell (the Windows default):

```powershell
cd OpenFlow
$env:FLOW_MANAGE_SERVER=1; bun openflow.ts
```

bash, zsh, Git Bash, WSL, macOS, Linux:

```bash
FLOW_MANAGE_SERVER=1 bun openflow.ts
```

Windows `cmd.exe`:

```bash
set FLOW_MANAGE_SERVER=1 && bun openflow.ts
```

fish:

```bash
env FLOW_MANAGE_SERVER=1 bun openflow.ts
```

It starts the engine, waits until it answers, then opens the canvas on
http://localhost:5174; Ctrl+C stops both. A port a dead run left bound is freed
first, and a port that is already serving is reused rather than started twice.

`FLOW_MANAGE_SERVER=1` hands the engine to the canvas, so its restart button
works — one click stops `opencode serve`, starts it again, and re-reads agents,
models and MCP status. This is the easy way to apply a merged agent, a new skill
or an MCP change without leaving the app. It is opt-in and never adopts a running
engine; drop it (`bun openflow.ts`, on every shell) to start the engine unmanaged.

Two shims wrap that same file for people who prefer their platform's own
launcher. They hold no logic of their own — they translate flags into the
environment variables `openflow.ts` already reads.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**On Windows the shim may refuse to start:** PowerShell does not run unsigned
local scripts by default, so `.\openflow.ps1` can fail with *"openflow.ps1 cannot
be loaded because running scripts is disabled on this system"*. A repo downloaded
as a ZIP rather than cloned is also marked as coming from the internet, which
blocks it a second way. `bun openflow.ts` is subject to neither and is the
shortest way past both. To use the shim instead, allow local scripts for your own
account, and unblock the file if it came from a ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Flags are optional, and the three surfaces resolve to the same plan:

| PowerShell | shell | environment | what it does |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | the repo the agents read and write — **they edit real files** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | engine port, default 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | build and serve the static bundle instead of running vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | let the canvas own the engine, which makes its restart button work |
| `-Help` | `-h`, `--help` | — | print the flag list |
| — | — | `OPENFLOW_DRY_RUN=1` | print the resolved plan and start nothing |

Or start the two processes by hand. The server first:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Then the canvas, on http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Or run it built, which serves the same app without vite:

```bash
bun run --cwd packages/flow start
```

### Before the first run

- **You can run something immediately, with no key.** opencode's `opencode`
  (zen) provider serves a free tier — the models whose ids end in `-free` — and
  OpenFlow lets a node use them with no credential connected. It is a shared
  quota, so a `429` or a model that answers `400` is the tier being busy, not a
  broken install; pick another `-free` model, or use the **test** button beside a
  node's model to check one before a whole run.
- **For anything else, click "api keys" in the titlebar.** It opens a two-step
  connect dialog — pick a provider, paste its key — and the key takes effect
  immediately, with no server restart. That panel also offers to import keys the
  opencode CLI already holds: `opencode providers login` writes them to
  `auth.json`, which this server never reads for its model catalog, so importing
  them is what makes them count. A paid model needs this; a fresh install with no
  key cannot spend money.
- **Set `OPENFLOW_PROJECT`** to the repo the agents should work in. It defaults
  to this one, and these agents write real files.
- **Restart `opencode serve` after "merge agents".** The server reads a project's
  `opencode.json` once and caches it, so freshly merged agents stay invisible
  until it restarts. Flow's pre-flight check refuses the run rather than letting
  a node execute as an agent that does not exist. Start with `-Manage` / `-m` /
  `FLOW_MANAGE_SERVER=1` and the titlebar's restart button does it in one click.
- **Permissions default to `auto`,** which approves each request for that one
  call. Switch the toolbar to `ask me` if you want to see them. Every decision is
  written to the run log either way.
- **Upgrading?** A generated agent is now keyed per node rather than per role, so
  a pipeline saved before this change needs one "merge agents" re-run before it
  will run again. Once only.

Details — endpoints, engine, data model, generated agent config — are in
[`packages/flow/README.md`](packages/flow/README.md).

---

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>

<p align="center"><sub><b>OpenFlow</b> is an independent fork. It is not affiliated with, sponsored by, or endorsed by the OpenCode team.</sub></p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
