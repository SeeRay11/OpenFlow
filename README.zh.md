# OpenFlow

**OpenFlow 是一个用于多智能体 AI 工作流的可视化构建器。** 将角色卡片拖到画布上，连接一条
流水线（规划者 → 架构师 → 编码者），保存它，然后用真正的并行智能体运行它。

OpenFlow 是一个独立的项目。它构建于
[opencode](https://github.com/anomalyco/opencode) 之上，并作为其分支（fork）发布；其
无头引擎（`opencode serve`）在底层驱动这些智能体。OpenFlow 自己的全部代码都位于
[`packages/flow`](packages/flow) 中；不修改任何上游包，因此 OpenCode 引擎始终保持最新，
上游合并也保持干净。原始的 OpenCode README 见下方。

### 安装

**前置条件**

- [Bun](https://bun.sh) 1.3 或更高版本——OpenFlow 唯一需要的运行时（它运行引擎、构建和画
  布）。用 `bun --version` 检查。
- [Git](https://git-scm.com)。

**获取代码**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` 会拉取整个工作区——OpenCode 引擎，加上 OpenFlow 自己在
[`packages/flow`](packages/flow) 中的代码。首次安装体积较大；它会下载引擎的原生依赖。
`postinstall` 这一步只是把 `node-pty` 预编译好的辅助二进制文件标记为可执行，在 Windows 上会
立即返回、什么也不做。

### 先停掉已经在跑的进程

OpenFlow 占用两个端口：引擎 **4096**，画布
**5174**。若上一次运行仍占着它们，手动启动引擎会以 `Error: Unexpected error` /
`ServeError` 失败——这是端口被占用，不是安装损坏。

`bun openflow.ts`
会自行处理：已在提供服务的端口直接复用，死掉的运行残留占用的端口会被释放。只有在确实需要一个全新引擎时才手动结束旧进程——例如改过
`opencode.json` 之后，因为引擎在启动时缓存项目配置，之后不再重读。

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

两条命令在无人监听时都是安全的，只是匹配不到任何进程。它们会结束这些端口上的任何进程，所以若你在那里跑着别的东西，请先确认：

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

**如果引擎报 `database is locked` 而失败，** 说明别处已经有另一个 opencode 引擎在运行
——可能是 OpenFlow 的第二份副本，也可能是上一次启动残留的引擎。所有引擎共用 opencode
数据目录中的同一个数据库，因此后启动的那个打不开它。这时释放端口没有用，因为那个引擎
未必占着端口。改用它正在运行的内容来停止它：

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'openflow\.ts|src/index\.ts serve|packages/flow dev' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```bash
pkill -f 'openflow\.ts|src/index\.ts serve|packages/flow dev'
```

然后重新启动 OpenFlow。如果每次都这样，多半是你把 OpenFlow 克隆到了两个位置并且都被
启动了——只保留一个。

### 运行

一条命令即可同时启动两个进程，在所有平台上用法相同：

```bash
bun openflow.ts
```

它会启动引擎，等到引擎有响应后，在 http://localhost:5174 打开画布；Ctrl+C 会同时停止二者。上
一次运行残留占用的端口会先被释放，而已经在提供服务的端口会被复用，而不是再启动一次。

有两个轻量脚本包装同一个文件，供更习惯自己平台启动方式的人使用。它们自身不含任何逻辑——只是把
命令行参数翻译成 `openflow.ts` 本来就会读取的环境变量。

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**在 Windows 上，该脚本可能拒绝启动：** PowerShell 默认不运行未签名的本地脚本，因此
`.\openflow.ps1` 可能会以 *"openflow.ps1 cannot be loaded because running scripts is
disabled on this system"* 失败。以 ZIP 下载而非克隆得到的仓库还会被标记为来自互联网，从而以
第二种方式被拦截。`bun openflow.ts` 不受这两者的限制，是绕过它们最短的路径。若仍想使用该脚本，
请为你自己的账户允许本地脚本，并在文件来自 ZIP 时解除其阻止：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

参数都是可选的，三种入口最终得到同一套配置：

| PowerShell | shell | 环境变量 | 作用 |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | 智能体读写的仓库——**它们会修改真实文件** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | 引擎端口，默认 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | 构建并提供静态产物，而不是运行 vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | 让画布掌管引擎，从而使其重启按钮可用 |
| `-Help` | `-h`, `--help` | — | 打印参数列表 |
| — | — | `OPENFLOW_DRY_RUN=1` | 打印解析出的方案，不启动任何进程 |

或者手动启动这两个进程。先启动服务器：

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

然后是画布，在 http://localhost:5174：

```bash
bun run --cwd packages/flow dev
```

或者运行已构建版本，它在不使用 vite 的情况下提供同一个应用：

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
<p align="center">开源的 AI Coding Agent。</p>
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

### 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用程序 (BETA)

OpenCode 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台                  | 下载文件                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`、`.rpm` 或 AppImage         |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

### 文档

更多配置说明请查看我们的 [**官方文档**](https://opencode.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 OpenCode 进行开发

如果你在项目名中使用了 “opencode”（如 “opencode-dashboard” 或 “opencode-mobile”），请在 README 里注明该项目不是 OpenCode 团队官方开发，且不存在隶属关系。

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=52ao9352-5623-4fa0-b7dd-3407c392c1af&qr_code=true) | [X.com](https://x.com/opencode)
