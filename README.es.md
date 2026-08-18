# OpenFlow

**OpenFlow es un constructor visual de flujos de trabajo de IA multiagente.**
Arrastra tarjetas de rol a un lienzo, conecta una tubería (planificador → arquitecto
→ programador), guárdala y ejecútala con agentes paralelos reales.

OpenFlow es un proyecto propio. Está construido sobre
[opencode](https://github.com/anomalyco/opencode) —y se distribuye como un fork del
mismo—, cuyo motor headless (`opencode serve`) impulsa los agentes por debajo. Todo
el código propio de OpenFlow vive en [`packages/flow`](packages/flow); no se
modifica ningún paquete upstream, de modo que el motor OpenCode se mantiene al día y
las fusiones con upstream siguen siendo limpias. El README original de OpenCode
aparece a continuación.

### Instalación

**Requisitos previos**

- [Bun](https://bun.sh) 1.3 o posterior — el único runtime que OpenFlow necesita
  (ejecuta el motor, el build y el lienzo). Usa `bun --version` para comprobarlo.
- [Git](https://git-scm.com).

**Obtener el código**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` descarga todo el workspace: el motor OpenCode más el código propio de
OpenFlow en [`packages/flow`](packages/flow). La primera instalación es grande;
descarga las dependencias nativas del motor y ejecuta un `postinstall` que compila
`node-pty`.

### Ejecutar

**Inicio rápido — un solo comando arranca ambos procesos:**

```bash
./openflow.ps1   # Windows (PowerShell)
./openflow.sh    # macOS / Linux
```

El lanzador arranca el motor, espera a que esté escuchando y luego abre el lienzo en
http://localhost:5174; Ctrl+C detiene ambos. Apunta los agentes a otro repositorio
con `-Project <dir>` (PowerShell) o `-p <dir>` (shell); pasa `-Built` / `-b` para
servir el bundle compilado. Aun así, inicia sesión primero en un proveedor (ver más
abajo).

O arranca los dos procesos a mano. Primero el servidor:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Luego el lienzo, en http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

O ejecútalo compilado, lo que sirve la misma aplicación sin vite:

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
<p align="center">El agente de programación con IA de código abierto.</p>
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

### Instalación

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Gestores de paquetes
npm i -g opencode-ai@latest        # o bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS y Linux (recomendado, siempre al día)
brew install opencode              # macOS y Linux (fórmula oficial de brew, se actualiza menos)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # cualquier sistema
nix run nixpkgs#opencode           # o github:anomalyco/opencode para la rama dev más reciente
```

> [!TIP]
> Elimina versiones anteriores a 0.1.x antes de instalar.

### App de escritorio (BETA)

OpenCode también está disponible como aplicación de escritorio. Descárgala directamente desde la [página de releases](https://github.com/anomalyco/opencode/releases) o desde [opencode.ai/download](https://opencode.ai/download).

| Plataforma            | Descarga                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, o AppImage         |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Directorio de instalación

El script de instalación respeta el siguiente orden de prioridad para la ruta de instalación:

1. `$OPENCODE_INSTALL_DIR` - Directorio de instalación personalizado
2. `$XDG_BIN_DIR` - Ruta compatible con la especificación XDG Base Directory
3. `$HOME/bin` - Directorio binario estándar del usuario (si existe o se puede crear)
4. `$HOME/.opencode/bin` - Alternativa por defecto

```bash
# Ejemplos
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agentes

OpenCode incluye dos agentes integrados que puedes alternar con la tecla `Tab`.

- **build** - Por defecto, agente con acceso completo para tareas de desarrollo
- **plan** - Agente de solo lectura para análisis y exploración de código
  - Deniega ediciones de archivos por defecto
  - Pide permiso antes de ejecutar comandos bash
  - Ideal para explorar codebases desconocidas o planificar cambios

Además, incluye un subagente **general** para búsquedas complejas y tareas de varios pasos.
Se usa internamente y se puede invocar con `@general` en los mensajes.

Más información sobre [agentes](https://opencode.ai/docs/agents).

### Documentación

Para más información sobre cómo configurar OpenCode, [**ve a nuestra documentación**](https://opencode.ai/docs).

### Contribuir

Si te interesa contribuir a OpenCode, lee nuestras [docs de contribución](./CONTRIBUTING.md) antes de enviar un pull request.

### Proyectos basados en OpenCode

Si estás trabajando en un proyecto basado en OpenCode y usas "opencode" como parte del nombre, por ejemplo, "opencode-dashboard" u "opencode-mobile", agrega una nota en tu README para aclarar que no está hecho por el equipo de OpenCode y que no está afiliado con nosotros de ninguna manera.

---

**Únete a nuestra comunidad** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
