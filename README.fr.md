# OpenFlow

**OpenFlow est un constructeur visuel de workflows d'IA multi-agents.** Glissez
des cartes de rôle sur un canevas, câblez un pipeline (planificateur → architecte →
codeur), enregistrez-le et exécutez-le avec de vrais agents parallèles.

OpenFlow est un projet à part entière. Il est bâti sur
[opencode](https://github.com/anomalyco/opencode) — et distribué comme un fork de
celui-ci — dont le moteur headless (`opencode serve`) pilote les agents en dessous.
Tout le code propre à OpenFlow se trouve dans [`packages/flow`](packages/flow) ;
aucun paquet upstream n'est modifié, si bien que le moteur OpenCode reste à jour et
que les merges upstream restent propres. Le README OpenCode original suit
ci-dessous.

### Installation

**Prérequis**

- [Bun](https://bun.sh) 1.3 ou plus récent — le seul runtime dont OpenFlow a besoin
  (il fait tourner le moteur, le build et le canevas). `bun --version` pour vérifier.
- [Git](https://git-scm.com).

**Récupérer le code**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` récupère tout le workspace — le moteur OpenCode plus le code propre à
OpenFlow dans [`packages/flow`](packages/flow). La première installation est
volumineuse ; elle télécharge les dépendances natives du moteur. Une étape
`postinstall` rend exécutables les binaires auxiliaires précompilés de `node-pty`,
et se termine immédiatement sous Windows.

### Arrêter ce qui tourne déjà

OpenFlow utilise deux ports : **4096** pour le moteur et **5174** pour le
canevas. Si une exécution précédente les occupe encore, démarrer le moteur à la
main échoue avec `Error: Unexpected error` / `ServeError` — un port déjà pris,
pas une installation cassée.

`bun openflow.ts` s'en charge : il réutilise un port qui répond déjà et libère
celui qu'une exécution morte a laissé lié. Ne tuez les anciens processus
vous-même que si vous voulez un moteur vraiment neuf — après une modification de
`opencode.json`, par exemple, car le moteur met en cache la configuration du
projet au démarrage et ne la relit jamais.

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

Les deux commandes sont sans danger quand rien n'écoute : elles ne trouvent
alors aucun processus. Elles tuent n'importe quel processus sur ces ports,
vérifiez donc d'abord si vous y faites tourner autre chose :

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

### Lancer

Une seule commande lance les deux processus, de la même façon sur toutes les
plateformes :

```bash
bun openflow.ts
```

Elle démarre le moteur, attend qu'il réponde, puis ouvre le canevas sur
http://localhost:5174 ; Ctrl+C arrête les deux. Un port laissé occupé par une
exécution morte est d'abord libéré, et un port qui sert déjà est réutilisé plutôt
que démarré deux fois.

Deux scripts légers enveloppent ce même fichier pour celles et ceux qui préfèrent le
lanceur de leur plateforme. Ils ne contiennent aucune logique propre : ils
traduisent les options en variables d'environnement que `openflow.ts` lit déjà.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**Sous Windows, ce script peut refuser de démarrer :** PowerShell n'exécute pas les
scripts locaux non signés par défaut, donc `.\openflow.ps1` peut échouer avec
*"openflow.ps1 cannot be loaded because running scripts is disabled on this
system"*. Un dépôt téléchargé en ZIP plutôt que cloné est en outre marqué comme
provenant d'internet, ce qui le bloque une seconde fois. `bun openflow.ts` n'est
soumis ni à l'un ni à l'autre et constitue le chemin le plus court pour contourner
les deux. Pour utiliser ce script malgré tout, autorisez les scripts locaux pour votre
propre compte et débloquez le fichier s'il provient d'un ZIP :

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Les options sont facultatives, et les trois surfaces aboutissent au même plan :

| PowerShell | shell | environnement | ce que ça fait |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | le dépôt que les agents lisent et écrivent — **ils modifient de vrais fichiers** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | port du moteur, 4096 par défaut |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | compiler et servir le bundle statique au lieu de lancer vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | laisser le canevas piloter le moteur, ce qui rend son bouton de redémarrage fonctionnel |
| `-Help` | `-h`, `--help` | — | afficher la liste des options |
| — | — | `OPENFLOW_DRY_RUN=1` | afficher le plan résolu et ne rien démarrer |

Ou lancez les deux processus à la main. Le serveur d'abord :

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Puis le canevas, sur http://localhost:5174 :

```bash
bun run --cwd packages/flow dev
```

Ou exécutez-le compilé, ce qui sert la même application sans vite :

```bash
bun run --cwd packages/flow build && bun run --cwd packages/flow start
```

---

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo OpenCode">
    </picture>
  </a>
</p>

<p align="center"><sub><b>OpenFlow</b> is an independent fork. It is not affiliated with, sponsored by, or endorsed by the OpenCode team.</sub></p>
<p align="center">L'agent de codage IA open source.</p>
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

# Gestionnaires de paquets
npm i -g opencode-ai@latest        # ou bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS et Linux (recommandé, toujours à jour)
brew install opencode              # macOS et Linux (formule officielle brew, mise à jour moins fréquente)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # n'importe quel OS
nix run nixpkgs#opencode           # ou github:anomalyco/opencode pour la branche dev la plus récente
```

> [!TIP]
> Supprimez les versions antérieures à 0.1.x avant d'installer.

### Application de bureau (BETA)

OpenCode est aussi disponible en application de bureau. Téléchargez-la directement depuis la [page des releases](https://github.com/anomalyco/opencode/releases) ou [opencode.ai/download](https://opencode.ai/download).

| Plateforme            | Téléchargement                     |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, ou AppImage        |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Répertoire d'installation

Le script d'installation respecte l'ordre de priorité suivant pour le chemin d'installation :

1. `$OPENCODE_INSTALL_DIR` - Répertoire d'installation personnalisé
2. `$XDG_BIN_DIR` - Chemin conforme à la spécification XDG Base Directory
3. `$HOME/bin` - Répertoire binaire utilisateur standard (s'il existe ou peut être créé)
4. `$HOME/.opencode/bin` - Repli par défaut

```bash
# Exemples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode inclut deux agents intégrés que vous pouvez basculer avec la touche `Tab`.

- **build** - Par défaut, agent avec accès complet pour le travail de développement
- **plan** - Agent en lecture seule pour l'analyse et l'exploration du code
  - Refuse les modifications de fichiers par défaut
  - Demande l'autorisation avant d'exécuter des commandes bash
  - Idéal pour explorer une base de code inconnue ou planifier des changements

Un sous-agent **general** est aussi inclus pour les recherches complexes et les tâches en plusieurs étapes.
Il est utilisé en interne et peut être invoqué via `@general` dans les messages.

En savoir plus sur les [agents](https://opencode.ai/docs/agents).

### Documentation

Pour plus d'informations sur la configuration d'OpenCode, [**consultez notre documentation**](https://opencode.ai/docs).

### Contribuer

Si vous souhaitez contribuer à OpenCode, lisez nos [docs de contribution](./CONTRIBUTING.md) avant de soumettre une pull request.

### Construire avec OpenCode

Si vous travaillez sur un projet lié à OpenCode et que vous utilisez "opencode" dans le nom du projet (par exemple, "opencode-dashboard" ou "opencode-mobile"), ajoutez une note dans votre README pour préciser qu'il n'est pas construit par l'équipe OpenCode et qu'il n'est pas affilié à nous.

---

**Rejoignez notre communauté** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
