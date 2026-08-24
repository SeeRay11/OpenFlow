# OpenFlow

**OpenFlow 是一個用於多代理 AI 工作流程的視覺化建構器。** 將角色卡片拖曳到畫布上，連接一條
管線（規劃者 → 架構師 → 編碼者），儲存它，然後用真正的並行代理執行它。

OpenFlow 是一個獨立的專案。它建構於
[opencode](https://github.com/anomalyco/opencode) 之上，並作為其分支（fork）發布；其
無頭引擎（`opencode serve`）在底層驅動這些代理。OpenFlow 自己的全部程式碼都位於
[`packages/flow`](packages/flow) 中；不修改任何上游套件，因此 OpenCode 引擎始終保持最新，
上游合併也保持乾淨。原始的 OpenCode README 見下方。

### 安裝

**先決條件**

- [Bun](https://bun.sh) 1.3 或更新版本——OpenFlow 唯一需要的執行環境（它執行引擎、建構與畫
  布）。用 `bun --version` 檢查。
- [Git](https://git-scm.com)。

**取得程式碼**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` 會拉取整個工作區——OpenCode 引擎，加上 OpenFlow 自己在
[`packages/flow`](packages/flow) 中的程式碼。首次安裝體積較大；它會下載引擎的原生相依套件。
`postinstall` 這一步只是把 `node-pty` 預先建置好的輔助執行檔標記為可執行，在 Windows 上會
立即返回、什麼也不做。

### 先停掉已經在跑的行程

OpenFlow 佔用兩個連接埠：引擎 **4096**，畫布
**5174**。若上一次執行仍佔著它們，手動啟動引擎會以 `Error: Unexpected error` /
`ServeError` 失敗——這是連接埠被佔用，不是安裝損毀。

`bun openflow.ts`
會自行處理：已在提供服務的連接埠直接沿用，死掉的執行殘留佔用的連接埠會被釋放。只有在確實需要全新引擎時才手動結束舊行程——例如改過
`opencode.json` 之後，因為引擎在啟動時快取專案設定，之後不再重讀。

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

兩條指令在沒有任何監聽時都是安全的，只是匹配不到任何行程。它們會結束這些連接埠上的任何行程，所以若你在那裡跑著別的東西，請先確認：

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

### 執行

一條命令即可同時啟動兩個行程，在所有平台上用法相同：

```bash
bun openflow.ts
```

它會啟動引擎，等到引擎有回應後，在 http://localhost:5174 開啟畫布；Ctrl+C 會同時停止兩者。上
一次執行殘留佔用的連接埠會先被釋放，而已經在提供服務的連接埠會被重複使用，而不是再啟動一次。

有兩個輕量指令碼包裝同一個檔案，供更習慣自己平台啟動方式的人使用。它們自身不含任何邏輯——只是
把命令列參數轉換成 `openflow.ts` 本來就會讀取的環境變數。

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**在 Windows 上，該指令碼可能拒絕啟動：** PowerShell 預設不執行未簽署的本機指令碼，因此
`.\openflow.ps1` 可能會以 *"openflow.ps1 cannot be loaded because running scripts is
disabled on this system"* 失敗。以 ZIP 下載而非複製（clone）取得的儲存庫還會被標記為來自網
際網路，因而以第二種方式被阻擋。`bun openflow.ts` 不受這兩者的限制，是繞過它們最短的路徑。若
仍想使用該指令碼，請為你自己的帳戶允許本機指令碼，並在檔案來自 ZIP 時解除其封鎖：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

參數都是選用的，三種入口最終得到同一套設定：

| PowerShell | shell | 環境變數 | 作用 |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | 代理讀寫的儲存庫——**它們會修改真實檔案** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | 引擎連接埠，預設 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | 建置並提供靜態產物，而不是執行 vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | 讓畫布掌管引擎，從而使其重新啟動按鈕可用 |
| `-Help` | `-h`, `--help` | — | 印出參數清單 |
| — | — | `OPENFLOW_DRY_RUN=1` | 印出解析後的方案，不啟動任何行程 |

或者手動啟動這兩個行程。先啟動伺服器：

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

然後是畫布，在 http://localhost:5174：

```bash
bun run --cwd packages/flow dev
```

或者執行已建構版本，它在不使用 vite 的情況下提供同一個應用程式：

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
<p align="center">開源的 AI Coding Agent。</p>
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

### 安裝

```bash
# 直接安裝 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 套件管理員
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 與 Linux（推薦，始終保持最新）
brew install opencode              # macOS 與 Linux（官方 brew formula，更新頻率較低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任何作業系統
nix run nixpkgs#opencode           # 或使用 github:anomalyco/opencode 以取得最新開發分支
```

> [!TIP]
> 安裝前請先移除 0.1.x 以前的舊版本。

### 桌面應用程式 (BETA)

OpenCode 也提供桌面版應用程式。您可以直接從 [發佈頁面 (releases page)](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下載。

| 平台                  | 下載連結                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, 或 AppImage        |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 安裝目錄

安裝腳本會依據以下優先順序決定安裝路徑：

1. `$OPENCODE_INSTALL_DIR` - 自定義安裝目錄
2. `$XDG_BIN_DIR` - 符合 XDG 基礎目錄規範的路徑
3. `$HOME/bin` - 標準使用者執行檔目錄 (若存在或可建立)
4. `$HOME/.opencode/bin` - 預設備用路徑

```bash
# 範例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 內建了兩種 Agent，您可以使用 `Tab` 鍵快速切換。

- **build** - 預設模式，具備完整權限的 Agent，適用於開發工作。
- **plan** - 唯讀模式，適用於程式碼分析與探索。
  - 預設禁止修改檔案。
  - 執行 bash 指令前會詢問權限。
  - 非常適合用來探索陌生的程式碼庫或規劃變更。

此外，OpenCode 還包含一個 **general** 子 Agent，用於處理複雜搜尋與多步驟任務。此 Agent 供系統內部使用，亦可透過在訊息中輸入 `@general` 來呼叫。

了解更多關於 [Agents](https://opencode.ai/docs/agents) 的資訊。

### 線上文件

關於如何設定 OpenCode 的詳細資訊，請參閱我們的 [**官方文件**](https://opencode.ai/docs)。

### 參與貢獻

如果您有興趣參與 OpenCode 的開發，請在提交 Pull Request 前先閱讀我們的 [貢獻指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基於 OpenCode 進行開發

如果您正在開發與 OpenCode 相關的專案，並在名稱中使用了 "opencode"（例如 "opencode-dashboard" 或 "opencode-mobile"），請在您的 README 中加入聲明，說明該專案並非由 OpenCode 團隊開發，且與我們沒有任何隸屬關係。

---

**加入我們的社群** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=52ao9352-5623-4fa0-b7dd-3407c392c1af&qr_code=true) | [X.com](https://x.com/opencode)
