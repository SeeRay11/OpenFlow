# OpenFlow

**OpenFlow ist ein visueller Builder für Multi-Agent-KI-Workflows.** Ziehe
Rollenkarten auf eine Arbeitsfläche, verdrahte eine Pipeline (Planer → Architekt →
Coder), speichere sie und führe sie mit echten parallelen Agenten aus.

OpenFlow ist ein eigenständiges Projekt. Es baut auf
[opencode](https://github.com/anomalyco/opencode) auf und wird als Fork davon
ausgeliefert; dessen Headless-Engine (`opencode serve`) steuert die Agenten im
Hintergrund. Der gesamte eigene Code von OpenFlow liegt in
[`packages/flow`](packages/flow); kein Upstream-Paket wird verändert, sodass die
OpenCode-Engine aktuell bleibt und Upstream-Merges sauber bleiben. Die
ursprüngliche OpenCode-README folgt weiter unten.

### Installation

**Voraussetzungen**

- [Bun](https://bun.sh) 1.3 oder neuer — die einzige Runtime, die OpenFlow
  benötigt (sie betreibt Engine, Build und Canvas). Mit `bun --version` prüfen.
- [Git](https://git-scm.com).

**Code holen**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` zieht den gesamten Workspace — die OpenCode-Engine plus OpenFlows
eigenen Code in [`packages/flow`](packages/flow). Die erste Installation ist groß;
sie lädt die nativen Abhängigkeiten der Engine herunter. Ein `postinstall`-Schritt
markiert die vorgebauten `node-pty`-Hilfsprogramme als ausführbar und kehrt unter
Windows sofort zurück.

### Ausführen

Ein Befehl startet beide Prozesse, auf jeder Plattform gleich:

```bash
bun openflow.ts
```

Er startet die Engine, wartet, bis sie antwortet, und öffnet dann die Canvas unter
http://localhost:5174; Ctrl+C stoppt beide. Ein Port, den ein abgebrochener Lauf
belegt zurückgelassen hat, wird zuerst freigegeben, und ein Port, auf dem bereits
etwas läuft, wird wiederverwendet statt ein zweites Mal gestartet.

Zwei Shims umschließen dieselbe Datei für alle, die den Launcher ihrer Plattform
bevorzugen. Sie enthalten keine eigene Logik — sie übersetzen Flags nur in die
Umgebungsvariablen, die `openflow.ts` ohnehin liest.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**Unter Windows kann der Shim den Start verweigern:** PowerShell führt unsignierte
lokale Skripte standardmäßig nicht aus, sodass `.\openflow.ps1` mit *"openflow.ps1
cannot be loaded because running scripts is disabled on this system"* fehlschlagen
kann. Ein als ZIP heruntergeladenes statt geklontes Repo ist zusätzlich als aus dem
Internet stammend markiert, was es ein zweites Mal blockiert. `bun openflow.ts`
unterliegt keinem von beidem und ist der kürzeste Weg an beidem vorbei. Um
stattdessen den Shim zu verwenden, erlaube lokale Skripte für dein eigenes Konto und
hebe die Blockierung der Datei auf, falls sie aus einem ZIP stammt:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Flags sind optional, und alle drei Oberflächen führen zum selben Plan:

| PowerShell | Shell | Umgebung | was es tut |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | das Repo, das die Agenten lesen und schreiben — **sie bearbeiten echte Dateien** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | Engine-Port, Standard 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | das statische Bundle bauen und ausliefern, statt vite zu starten |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | die Canvas die Engine besitzen lassen, wodurch ihr Neustart-Button funktioniert |
| `-Help` | `-h`, `--help` | — | die Flag-Liste ausgeben |
| — | — | `OPENFLOW_DRY_RUN=1` | den ermittelten Plan ausgeben und nichts starten |

Oder starte die beiden Prozesse von Hand. Zuerst der Server:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Dann die Canvas, unter http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Oder gebaut ausführen, was dieselbe App ohne vite serviert:

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
<p align="center">Der Open-Source KI-Coding-Agent.</p>
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

# Paketmanager
npm i -g opencode-ai@latest        # oder bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS und Linux (empfohlen, immer aktuell)
brew install opencode              # macOS und Linux (offizielle Brew-Formula, seltener aktualisiert)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # jedes Betriebssystem
nix run nixpkgs#opencode           # oder github:anomalyco/opencode für den neuesten dev-Branch
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

### Desktop-App (BETA)

OpenCode ist auch als Desktop-Anwendung verfügbar. Lade sie direkt von der [Releases-Seite](https://github.com/anomalyco/opencode/releases) oder [opencode.ai/download](https://opencode.ai/download) herunter.

| Plattform             | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` oder AppImage       |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installationsverzeichnis

Das Installationsskript beachtet die folgende Prioritätsreihenfolge für den Installationspfad:

1. `$OPENCODE_INSTALL_DIR` - Benutzerdefiniertes Installationsverzeichnis
2. `$XDG_BIN_DIR` - XDG Base Directory Specification-konformer Pfad
3. `$HOME/bin` - Standard-Binärverzeichnis des Users (falls vorhanden oder erstellbar)
4. `$HOME/.opencode/bin` - Standard-Fallback

```bash
# Beispiele
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode enthält zwei eingebaute Agents, zwischen denen du mit der `Tab`-Taste wechseln kannst.

- **build** - Standard-Agent mit vollem Zugriff für Entwicklungsarbeit
- **plan** - Nur-Lese-Agent für Analyse und Code-Exploration
  - Verweigert Datei-Edits standardmäßig
  - Fragt vor dem Ausführen von bash-Befehlen nach
  - Ideal zum Erkunden unbekannter Codebases oder zum Planen von Änderungen

Außerdem ist ein **general**-Subagent für komplexe Suchen und mehrstufige Aufgaben enthalten.
Dieser wird intern genutzt und kann in Nachrichten mit `@general` aufgerufen werden.

Mehr dazu unter [Agents](https://opencode.ai/docs/agents).

### Dokumentation

Mehr Infos zur Konfiguration von OpenCode findest du in unseren [**Docs**](https://opencode.ai/docs).

### Beitragen

Wenn du zu OpenCode beitragen möchtest, lies bitte unsere [Contributing Docs](./CONTRIBUTING.md), bevor du einen Pull Request einreichst.

### Auf OpenCode aufbauen

Wenn du an einem Projekt arbeitest, das mit OpenCode zusammenhängt und "opencode" als Teil seines Namens verwendet (z.B. "opencode-dashboard" oder "opencode-mobile"), füge bitte einen Hinweis in deine README ein, dass es nicht vom OpenCode-Team gebaut wird und nicht in irgendeiner Weise mit uns verbunden ist.

---

**Tritt unserer Community bei** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
