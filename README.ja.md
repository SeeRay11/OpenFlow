# OpenFlow

**OpenFlow は、マルチエージェント AI ワークフローのためのビジュアルビルダーです。** ロール
カードをキャンバスにドラッグし、パイプライン（プランナー → アーキテクト → コーダー）を配線
して保存し、実際の並列エージェントで実行します。

OpenFlow は独立したプロジェクトです。
[opencode](https://github.com/anomalyco/opencode) の上に構築され、そのフォークとして提供
されます。opencode のヘッドレスエンジン（`opencode serve`）が背後でエージェントを駆動しま
す。OpenFlow 独自のコードはすべて [`packages/flow`](packages/flow) にあります。上流の
パッケージは一切変更しないため、OpenCode エンジンは最新のまま保たれ、上流とのマージもクリーン
に保たれます。オリジナルの OpenCode README は以下に続きます。

### インストール

**前提条件**

- [Bun](https://bun.sh) 1.3 以降 — OpenFlow が必要とする唯一のランタイム（エンジン、ビル
  ド、キャンバスを動かします）。`bun --version` で確認してください。
- [Git](https://git-scm.com)。

**コードを取得する**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` はワークスペース全体を取得します — OpenCode エンジンに加えて、
[`packages/flow`](packages/flow) にある OpenFlow 独自のコードです。初回インストールは大き
く、エンジンのネイティブ依存関係をダウンロードします。`postinstall` のステップは `node-pty`
のビルド済みヘルパーバイナリに実行権限を付けるだけで、Windows では何もせずすぐに終了します。

### 実行する

1 つのコマンドで両方のプロセスが起動します。どのプラットフォームでも同じです：

```bash
bun openflow.ts
```

エンジンを起動し、応答するまで待ってから、http://localhost:5174 でキャンバスを開きます。
Ctrl+C で両方を停止します。終了し損ねた実行が掴んだままのポートは先に解放され、すでに応答して
いるポートは二重に起動せずそのまま再利用します。

同じファイルをラップするシムが 2 つあり、各プラットフォームのランチャーを好む人向けです。シム
自体にロジックはなく、フラグを `openflow.ts` がすでに読んでいる環境変数へ変換するだけです。

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**Windows ではシムが起動を拒否することがあります。** PowerShell は既定で署名のないローカル
スクリプトを実行しないため、`.\openflow.ps1` は *"openflow.ps1 cannot be loaded because
running scripts is disabled on this system"* で失敗することがあります。クローンではなく
ZIP でダウンロードしたリポジトリは、さらにインターネット由来として印が付き、二重にブロックされ
ます。`bun openflow.ts` はそのどちらの対象にもならず、両方を回避する最短の方法です。それでも
シムを使いたい場合は、自分のアカウントについてローカルスクリプトを許可し、ZIP から取得したファ
イルであればブロックを解除してください：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

フラグは任意で、3 つの入口はいずれも同じ結果になります：

| PowerShell | shell | 環境変数 | 何をするか |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | エージェントが読み書きするリポジトリ — **実際のファイルを編集します** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | エンジンのポート、既定は 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | vite を実行する代わりに静的バンドルをビルドして提供する |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | キャンバスにエンジンを所有させ、その再起動ボタンを機能させる |
| `-Help` | `-h`, `--help` | — | フラグ一覧を表示する |
| — | — | `OPENFLOW_DRY_RUN=1` | 決定した内容を表示し、何も起動しない |

または、2 つのプロセスを手動で起動します。まずサーバー：

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

次にキャンバス、http://localhost:5174 で：

```bash
bun run --cwd packages/flow dev
```

または、ビルド済みで実行します。これは vite を使わずに同じアプリを提供します：

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
<p align="center">オープンソースのAIコーディングエージェント。</p>
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

### インストール

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# パッケージマネージャー
npm i -g opencode-ai@latest        # bun/pnpm/yarn でもOK
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS と Linux（推奨。常に最新）
brew install opencode              # macOS と Linux（公式 brew formula。更新頻度は低め）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # どのOSでも
nix run nixpkgs#opencode           # または github:anomalyco/opencode で最新 dev ブランチ
```

> [!TIP]
> インストール前に 0.1.x より古いバージョンを削除してください。

### デスクトップアプリ (BETA)

OpenCode はデスクトップアプリとしても利用できます。[releases page](https://github.com/anomalyco/opencode/releases) から直接ダウンロードするか、[opencode.ai/download](https://opencode.ai/download) を利用してください。

| プラットフォーム      | ダウンロード                       |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`、`.rpm`、または AppImage    |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### インストールディレクトリ

インストールスクリプトは、インストール先パスを次の優先順位で決定します。

1. `$OPENCODE_INSTALL_DIR` - カスタムのインストールディレクトリ
2. `$XDG_BIN_DIR` - XDG Base Directory Specification に準拠したパス
3. `$HOME/bin` - 標準のユーザー用バイナリディレクトリ（存在する場合、または作成できる場合）
4. `$HOME/.opencode/bin` - デフォルトのフォールバック

```bash
# 例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode には組み込みの Agent が2つあり、`Tab` キーで切り替えられます。

- **build** - デフォルト。開発向けのフルアクセス Agent
- **plan** - 分析とコード探索向けの読み取り専用 Agent
  - デフォルトでファイル編集を拒否
  - bash コマンド実行前に確認
  - 未知のコードベース探索や変更計画に最適

また、複雑な検索やマルチステップのタスク向けに **general** サブ Agent も含まれています。
内部的に使用されており、メッセージで `@general` と入力して呼び出せます。

[agents](https://opencode.ai/docs/agents) の詳細はこちら。

### ドキュメント

OpenCode の設定については [**ドキュメント**](https://opencode.ai/docs) を参照してください。

### コントリビュート

OpenCode に貢献したい場合は、Pull Request を送る前に [contributing docs](./CONTRIBUTING.md) を読んでください。

### OpenCode の上に構築する

OpenCode に関連するプロジェクトで、名前に "opencode"（例: "opencode-dashboard" や "opencode-mobile"）を含める場合は、そのプロジェクトが OpenCode チームによって作られたものではなく、いかなる形でも関係がないことを README に明記してください。

---

**コミュニティに参加** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
