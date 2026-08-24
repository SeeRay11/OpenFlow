# OpenFlow

**OpenFlow er en visuel builder til multi-agent-AI-workflows.** Træk rollekort ud
på et lærred, forbind en pipeline (planlægger → arkitekt → koder), gem den, og kør
den med rigtige parallelle agenter.

OpenFlow er sit eget projekt. Det er bygget på
[opencode](https://github.com/anomalyco/opencode) — og udgives som en fork af det —
hvis headless-motor (`opencode serve`) driver agenterne nedenunder. Al OpenFlows egen
kode ligger i [`packages/flow`](packages/flow); ingen upstream-pakke ændres, så
OpenCode-motoren forbliver opdateret, og upstream-merges forbliver rene. Den
oprindelige OpenCode-README følger nedenfor.

### Installation

**Forudsætninger**

- [Bun](https://bun.sh) 1.3 eller nyere — den eneste runtime, OpenFlow har brug for
  (den kører motoren, build'et og lærredet). Tjek med `bun --version`.
- [Git](https://git-scm.com).

**Hent koden**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` henter hele workspace'et — OpenCode-motoren plus OpenFlows egen kode i
[`packages/flow`](packages/flow). Den første installation er stor; den henter
motorens native afhængigheder. Et `postinstall`-trin markerer `node-pty`s
færdigbyggede hjælpebinære filer som eksekverbare og vender straks tilbage på
Windows.

### Stop det, der allerede kører

OpenFlow bruger to porte: **4096** til motoren og **5174** til lærredet. Holder
en tidligere kørsel dem stadig, fejler manuel start af motoren med `Error:
Unexpected error` / `ServeError` — det er en optaget port, ikke en ødelagt
installation.

`bun openflow.ts` klarer det selv: den genbruger en port, der allerede svarer,
og frigør en, som en død kørsel efterlod bundet. Dræb kun de gamle processer
selv, når du vil have en helt frisk motor — for eksempel efter en ændring i
`opencode.json`, da motoren cacher projektets konfiguration ved opstart og
aldrig læser den igen.

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

Begge er sikre at køre, når intet lytter — de rammer bare ingen proces. De
dræber enhver proces på de porte, så tjek først, hvis du kører noget andet der:

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

**Hvis motoren fejler med `database is locked`,** kører der allerede en anden
opencode-motor et andet sted — en anden kopi af OpenFlow, eller en motor som en
tidligere starter efterlod. Alle motorer deler én database i din opencode-datamappe,
så den anden, der starter, kan ikke åbne den. At frigøre portene hjælper ikke her,
for den motor holder dem ikke nødvendigvis. Stop den ud fra, hvad den kører:

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'openflow\.ts|src/index\.ts serve|packages/flow dev' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```bash
pkill -f 'openflow\.ts|src/index\.ts serve|packages/flow dev'
```

Start så OpenFlow igen. Sker det hver gang, har du sandsynligvis OpenFlow klonet
to steder, og begge bliver startet — behold ét.

### Kør det

Én kommando starter begge processer, på samme måde på alle platforme:

```bash
bun openflow.ts
```

Den starter motoren, venter, til den svarer, og åbner så lærredet på
http://localhost:5174; Ctrl+C stopper begge. En port, som en død kørsel efterlod
optaget, frigives først, og en port, der allerede betjener, genbruges i stedet for
at blive startet to gange.

To tynde scripts pakker den samme fil ind for dem, der foretrækker deres platforms
egen launcher. De rummer ingen logik selv — de oversætter blot flag til de
miljøvariabler, `openflow.ts` allerede læser.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**På Windows kan scriptet nægte at starte:** PowerShell kører som standard ikke
usignerede lokale scripts, så `.\openflow.ps1` kan fejle med *"openflow.ps1 cannot
be loaded because running scripts is disabled on this system"*. Et repo, der er
hentet som ZIP i stedet for klonet, er desuden markeret som stammende fra
internettet, hvilket blokerer det på endnu en måde. `bun openflow.ts` er ikke
underlagt nogen af delene og er den korteste vej uden om begge. Vil du alligevel
bruge scriptet, så tillad lokale scripts for din egen konto, og fjern blokeringen af
filen, hvis den kom fra en ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Flag er valgfrie, og de tre flader ender i den samme plan:

| PowerShell | shell | miljø | hvad det gør |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | det repo, agenterne læser og skriver — **de redigerer rigtige filer** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | motorens port, standard 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | byg og server det statiske bundle i stedet for at køre vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | lad lærredet eje motoren, hvilket får dets genstart-knap til at virke |
| `-Help` | `-h`, `--help` | — | udskriv listen over flag |
| — | — | `OPENFLOW_DRY_RUN=1` | udskriv den udledte plan og start intet |

Eller start de to processer i hånden. Serveren først:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Derefter lærredet, på http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Eller kør det byggede, som serverer den samme app uden vite:

```bash
bun run --cwd packages/flow build && bun run --cwd packages/flow start
```

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

<p align="center"><sub><b>OpenFlow</b> is an independent fork. It is not affiliated with, sponsored by, or endorsed by the OpenCode team.</sub></p>
<p align="center">Den open source AI-kodeagent.</p>
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

# Pakkehåndteringer
npm i -g opencode-ai@latest        # eller bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS og Linux (anbefalet, altid up to date)
brew install opencode              # macOS og Linux (officiel brew formula, opdateres sjældnere)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # alle OS
nix run nixpkgs#opencode           # eller github:anomalyco/opencode for nyeste dev-branch
```

> [!TIP]
> Fjern versioner ældre end 0.1.x før installation.

### Desktop-app (BETA)

OpenCode findes også som desktop-app. Download direkte fra [releases-siden](https://github.com/anomalyco/opencode/releases) eller [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, eller AppImage     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installationsmappe

Installationsscriptet bruger følgende prioriteringsrækkefølge for installationsstien:

1. `$OPENCODE_INSTALL_DIR` - Tilpasset installationsmappe
2. `$XDG_BIN_DIR` - Sti der følger XDG Base Directory Specification
3. `$HOME/bin` - Standard bruger-bin-mappe (hvis den findes eller kan oprettes)
4. `$HOME/.opencode/bin` - Standard fallback

```bash
# Eksempler
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

Læs mere om [agents](https://opencode.ai/docs/agents).

### Dokumentation

For mere info om konfiguration af OpenCode, [**se vores docs**](https://opencode.ai/docs).

### Bidrag

Hvis du vil bidrage til OpenCode, så læs vores [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygget på OpenCode

Hvis du arbejder på et projekt der er relateret til OpenCode og bruger "opencode" som en del af navnet; f.eks. "opencode-dashboard" eller "opencode-mobile", så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af OpenCode-teamet og ikke er tilknyttet os på nogen måde.

---

**Bliv en del af vores community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
