# OpenFlow

**OpenFlow é um construtor visual de fluxos de trabalho de IA multiagente.**
Arraste cartões de papéis para um canvas, conecte um pipeline (planejador →
arquiteto → programador), salve-o e execute-o com agentes paralelos reais.

OpenFlow é um projeto próprio. Ele é construído sobre o
[opencode](https://github.com/anomalyco/opencode) — e distribuído como um fork dele
—, cujo motor headless (`opencode serve`) conduz os agentes por baixo. Todo o código
próprio do OpenFlow fica em [`packages/flow`](packages/flow); nenhum pacote upstream
é modificado, então o motor OpenCode permanece atualizado e os merges com o upstream
continuam limpos. O README original do OpenCode segue abaixo.

### Instalação

**Pré-requisitos**

- [Bun](https://bun.sh) 1.3 ou mais recente — o único runtime que o OpenFlow precisa
  (ele roda o motor, o build e o canvas). Use `bun --version` para verificar.
- [Git](https://git-scm.com).

**Obter o código**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

O `bun install` baixa todo o workspace — o motor OpenCode mais o código próprio do
OpenFlow em [`packages/flow`](packages/flow). A primeira instalação é grande; ela
baixa as dependências nativas do motor. Uma etapa de `postinstall` marca como
executáveis os binários auxiliares pré-compilados do `node-pty` e, no Windows,
retorna imediatamente.

### Parar o que já estiver rodando

O OpenFlow usa duas portas: **4096** para o motor e **5174** para o canvas. Se
uma execução anterior ainda as ocupa, iniciar o motor à mão falha com `Error:
Unexpected error` / `ServeError` — é porta já ocupada, não instalação quebrada.

`bun openflow.ts` resolve isso sozinho: reutiliza a porta que já está servindo e
libera a que uma execução morta deixou presa. Encerre os processos antigos você
mesmo só quando quiser um motor realmente novo — depois de editar
`opencode.json`, por exemplo, já que o motor guarda a configuração do projeto na
inicialização e nunca a relê.

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

Os dois comandos são seguros quando nada está escutando — simplesmente não
encontram processo algum. Eles matam qualquer processo nessas portas, então
verifique antes se você roda outra coisa ali:

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

### Executar

Um único comando inicia os dois processos, do mesmo jeito em todas as plataformas:

```bash
bun openflow.ts
```

Ele inicia o motor, espera até que ele responda e então abre o canvas em
http://localhost:5174; Ctrl+C para os dois. Uma porta que uma execução morta deixou
ocupada é liberada primeiro, e uma porta que já está servindo é reaproveitada em vez
de iniciada duas vezes.

Dois scripts leves envolvem esse mesmo arquivo para quem prefere o launcher da
própria plataforma. Eles não têm lógica própria — apenas traduzem as flags para as
variáveis de ambiente que o `openflow.ts` já lê.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**No Windows esse script pode se recusar a iniciar:** por padrão o PowerShell não executa
scripts locais sem assinatura, então `.\openflow.ps1` pode falhar com *"openflow.ps1
cannot be loaded because running scripts is disabled on this system"*. Um
repositório baixado como ZIP em vez de clonado também é marcado como vindo da
internet, o que o bloqueia de um segundo jeito. O `bun openflow.ts` não está sujeito
a nenhum dos dois e é o caminho mais curto para contornar ambos. Para usar o script
mesmo assim, permita scripts locais para a sua própria conta e desbloqueie o arquivo
se ele veio de um ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

As flags são opcionais, e as três superfícies resolvem para o mesmo plano:

| PowerShell | shell | ambiente | o que faz |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | o repositório que os agentes leem e escrevem — **eles editam arquivos reais** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | porta do motor, 4096 por padrão |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | compilar e servir o bundle estático em vez de rodar o vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | deixar o canvas ser dono do motor, o que faz o botão de reiniciar dele funcionar |
| `-Help` | `-h`, `--help` | — | imprimir a lista de flags |
| — | — | `OPENFLOW_DRY_RUN=1` | imprimir o plano resolvido e não iniciar nada |

Ou inicie os dois processos manualmente. Primeiro o servidor:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Depois o canvas, em http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Ou execute-o compilado, o que serve o mesmo app sem o vite:

```bash
bun run --cwd packages/flow build && bun run --cwd packages/flow start
```

---

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo do OpenCode">
    </picture>
  </a>
</p>

<p align="center"><sub><b>OpenFlow</b> is an independent fork. It is not affiliated with, sponsored by, or endorsed by the OpenCode team.</sub></p>
<p align="center">O agente de programação com IA de código aberto.</p>
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

### Instalação

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Gerenciadores de pacotes
npm i -g opencode-ai@latest        # ou bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS e Linux (recomendado, sempre atualizado)
brew install opencode              # macOS e Linux (fórmula oficial do brew, atualiza menos)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # qualquer sistema
nix run nixpkgs#opencode           # ou github:anomalyco/opencode para a branch dev mais recente
```

> [!TIP]
> Remova versões anteriores a 0.1.x antes de instalar.

### App desktop (BETA)

O OpenCode também está disponível como aplicativo desktop. Baixe diretamente pela [página de releases](https://github.com/anomalyco/opencode/releases) ou em [opencode.ai/download](https://opencode.ai/download).

| Plataforma            | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` ou AppImage         |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Diretório de instalação

O script de instalação respeita a seguinte ordem de prioridade para o caminho de instalação:

1. `$OPENCODE_INSTALL_DIR` - Diretório de instalação personalizado
2. `$XDG_BIN_DIR` - Caminho compatível com a especificação XDG Base Directory
3. `$HOME/bin` - Diretório binário padrão do usuário (se existir ou puder ser criado)
4. `$HOME/.opencode/bin` - Fallback padrão

```bash
# Exemplos
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

O OpenCode inclui dois agents integrados, que você pode alternar com a tecla `Tab`.

- **build** - Padrão, agent com acesso total para trabalho de desenvolvimento
- **plan** - Agent somente leitura para análise e exploração de código
  - Nega edições de arquivos por padrão
  - Pede permissão antes de executar comandos bash
  - Ideal para explorar codebases desconhecidas ou planejar mudanças

Também há um subagent **general** para buscas complexas e tarefas em várias etapas.
Ele é usado internamente e pode ser invocado com `@general` nas mensagens.

Saiba mais sobre [agents](https://opencode.ai/docs/agents).

### Documentação

Para mais informações sobre como configurar o OpenCode, [**veja nossa documentação**](https://opencode.ai/docs).

### Contribuir

Se você tem interesse em contribuir com o OpenCode, leia os [contributing docs](./CONTRIBUTING.md) antes de enviar um pull request.

### Construindo com OpenCode

Se você estiver trabalhando em um projeto relacionado ao OpenCode e estiver usando "opencode" como parte do nome (por exemplo, "opencode-dashboard" ou "opencode-mobile"), adicione uma nota no README para deixar claro que não foi construído pela equipe do OpenCode e não é afiliado a nós de nenhuma forma.

---

**Junte-se à nossa comunidade** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
