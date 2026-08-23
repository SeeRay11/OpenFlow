# OpenFlow

**OpenFlow er en visuell bygger for multi-agent-KI-arbeidsflyter.** Dra rollekort
ut på et lerret, koble sammen en pipeline (planlegger → arkitekt → koder), lagre
den, og kjør den med ekte parallelle agenter.

OpenFlow er sitt eget prosjekt. Det er bygget på
[opencode](https://github.com/anomalyco/opencode) — og distribueres som en fork av
det — hvis headless-motor (`opencode serve`) driver agentene under panseret. All
OpenFlows egen kode ligger i [`packages/flow`](packages/flow); ingen upstream-pakke
endres, så OpenCode-motoren holder seg oppdatert og upstream-merger forblir rene. Den
opprinnelige OpenCode-README-en følger nedenfor.

### Installasjon

**Forutsetninger**

- [Bun](https://bun.sh) 1.3 eller nyere — den eneste kjøretiden OpenFlow trenger
  (den kjører motoren, byggingen og lerretet). Sjekk med `bun --version`.
- [Git](https://git-scm.com).

**Hent koden**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` henter hele arbeidsområdet — OpenCode-motoren pluss OpenFlows egen kode
i [`packages/flow`](packages/flow). Den første installasjonen er stor; den laster ned
motorens native avhengigheter. Et `postinstall`-steg merker `node-pty` sine
ferdigbygde hjelpebinærfiler som kjørbare, og returnerer umiddelbart på Windows.

### Kjør det

Én kommando starter begge prosessene, på samme måte på alle plattformer:

```bash
bun openflow.ts
```

Den starter motoren, venter til den svarer, og åpner så lerretet på
http://localhost:5174; Ctrl+C stopper begge. En port som en død kjøring lot ligge
opptatt, frigjøres først, og en port som allerede betjener, gjenbrukes i stedet for
å startes to ganger.

To shims pakker inn den samme filen for dem som foretrekker plattformens egen
starter. De har ingen logikk selv — de oversetter bare flagg til miljøvariablene
`openflow.ts` allerede leser.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**På Windows kan shimmet nekte å starte:** PowerShell kjører som standard ikke
usignerte lokale skript, så `.\openflow.ps1` kan feile med *"openflow.ps1 cannot be
loaded because running scripts is disabled on this system"*. Et repo som er lastet
ned som ZIP i stedet for klonet, blir dessuten merket som kommet fra internett, noe
som blokkerer det på nok en måte. `bun openflow.ts` rammes av ingen av delene og er
den korteste veien forbi begge. Vil du likevel bruke shimmet, så tillat lokale
skript for din egen konto, og opphev blokkeringen av filen hvis den kom fra en ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Flagg er valgfrie, og de tre flatene ender i den samme planen:

| PowerShell | shell | miljø | hva det gjør |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | repoet agentene leser og skriver — **de redigerer ekte filer** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | motorport, standard 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | bygg og server den statiske bunten i stedet for å kjøre vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | la lerretet eie motoren, noe som får omstart-knappen dens til å virke |
| `-Help` | `-h`, `--help` | — | skriv ut flagglisten |
| — | — | `OPENFLOW_DRY_RUN=1` | skriv ut den utledede planen og start ingenting |

Eller start de to prosessene for hånd. Serveren først:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Deretter lerretet, på http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Eller kjør den bygde, som serverer den samme appen uten vite:

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
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Pakkehåndterere
npm i -g opencode-ai@latest        # eller bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS og Linux (anbefalt, alltid oppdatert)
brew install opencode              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # alle OS
nix run nixpkgs#opencode           # eller github:anomalyco/opencode for nyeste dev-branch
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

OpenCode er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/anomalyco/opencode/releases) eller [opencode.ai/download](https://opencode.ai/download).

| Plattform             | Nedlasting                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` eller AppImage      |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$OPENCODE_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.opencode/bin` - Standard fallback

```bash
# Eksempler
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://opencode.ai/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer OpenCode, [**se dokumentasjonen**](https://opencode.ai/docs).

### Bidra

Hvis du vil bidra til OpenCode, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på OpenCode

Hvis du jobber med et prosjekt som er relatert til OpenCode og bruker "opencode" som en del av navnet; for eksempel "opencode-dashboard" eller "opencode-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av OpenCode-teamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
