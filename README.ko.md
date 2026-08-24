# OpenFlow

**OpenFlow는 멀티 에이전트 AI 워크플로를 위한 비주얼 빌더입니다.** 역할 카드를 캔버스로
드래그하고, 파이프라인(플래너 → 아키텍트 → 코더)을 연결하고, 저장한 다음, 실제 병렬
에이전트로 실행하세요.

OpenFlow는 독립적인 프로젝트입니다.
[opencode](https://github.com/anomalyco/opencode) 위에 구축되었으며 그 포크로 배포됩니
다. opencode의 헤드리스 엔진(`opencode serve`)이 그 아래에서 에이전트를 구동합니다.
OpenFlow 자체 코드는 모두 [`packages/flow`](packages/flow)에 있습니다. 어떤 업스트림
패키지도 수정하지 않으므로 OpenCode 엔진은 항상 최신 상태로 유지되고 업스트림 병합도 깔끔하
게 유지됩니다. 원본 OpenCode README는 아래에 이어집니다.

### 설치

**사전 요구 사항**

- [Bun](https://bun.sh) 1.3 이상 — OpenFlow에 필요한 유일한 런타임입니다(엔진, 빌드,
  캔버스를 실행합니다). `bun --version`으로 확인하세요.
- [Git](https://git-scm.com).

**코드 가져오기**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install`은 전체 워크스페이스를 가져옵니다 — OpenCode 엔진과
[`packages/flow`](packages/flow)에 있는 OpenFlow 자체 코드입니다. 첫 설치는 용량이 큽니
다. 엔진의 네이티브 의존성을 내려받습니다. `postinstall` 단계는 미리 빌드된 `node-pty` 헬퍼
바이너리에 실행 권한을 표시할 뿐이며, Windows에서는 아무 일도 하지 않고 즉시 반환합니다.

### 이미 실행 중인 것 정리

OpenFlow는 포트 두 개를 쓴다. 엔진은 **4096**, 캔버스는 **5174**. 이전 실행이
아직 잡고 있으면 엔진을 수동으로 띄울 때 `Error: Unexpected error` /
`ServeError`로 실패한다. 설치가 깨진 게 아니라 포트가 이미 점유된 것이다.

`bun openflow.ts`는 이를 알아서 처리한다. 이미 응답 중인 포트는 재사용하고, 죽은
실행이 물고 있던 포트는 해제한다. 직접 종료해야 할 때는 정말로 새 엔진이 필요할
때뿐이다 — 예를 들어 `opencode.json`을 수정한 뒤. 엔진은 부팅 시 프로젝트 설정을
캐시하고 다시 읽지 않는다.

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

아무것도 리스닝하지 않으면 두 명령 모두 안전하며 일치하는 프로세스가 없을
뿐이다. 해당 포트를 점유한 프로세스는 무엇이든 종료시키므로, 다른 것을 돌리고
있다면 먼저 확인할 것:

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

### 실행

명령 하나로 두 프로세스가 모두 시작되며, 모든 플랫폼에서 동일합니다:

```bash
bun openflow.ts
```

엔진을 시작하고, 응답할 때까지 기다린 다음, http://localhost:5174에서 캔버스를 엽니다.
Ctrl+C로 둘 다 중지합니다. 죽은 실행이 점유한 채로 남긴 포트는 먼저 해제되고, 이미 서비스 중인
포트는 두 번 시작하는 대신 재사용됩니다.

같은 파일을 감싸는 얇은 실행 스크립트가 둘 있으며, 자기 플랫폼의 런처를 선호하는 사람을 위한
것입니다. 자체 로직은 없고, 플래그를 `openflow.ts`가 이미 읽는 환경 변수로 옮길 뿐입니다.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**Windows에서는 이 스크립트가 시작을 거부할 수 있습니다.** PowerShell은 기본적으로 서명되지 않은 로
컬 스크립트를 실행하지 않으므로, `.\openflow.ps1`이 *"openflow.ps1 cannot be loaded
because running scripts is disabled on this system"*으로 실패할 수 있습니다. 클론이 아니
라 ZIP으로 내려받은 저장소는 인터넷에서 온 것으로 표시되어 두 번째 방식으로도 차단됩니다.
`bun openflow.ts`는 둘 중 어느 것에도 해당되지 않으며 둘 다 우회하는 가장 짧은 방법입니다. 그
래도 이 스크립트를 쓰려면 본인 계정에 한해 로컬 스크립트를 허용하고, 파일이 ZIP에서 왔다면 차단을 해제
하세요:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

플래그는 선택 사항이며, 세 가지 경로 모두 같은 결과로 이어집니다:

| PowerShell | shell | 환경 변수 | 하는 일 |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | 에이전트가 읽고 쓰는 저장소 — **실제 파일을 편집합니다** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | 엔진 포트, 기본값 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | vite를 실행하는 대신 정적 번들을 빌드해 제공 |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | 캔버스가 엔진을 소유하게 하여 재시작 버튼이 동작하도록 함 |
| `-Help` | `-h`, `--help` | — | 플래그 목록 출력 |
| — | — | `OPENFLOW_DRY_RUN=1` | 결정된 실행 계획만 출력하고 아무것도 시작하지 않음 |

또는 두 프로세스를 수동으로 시작하세요. 먼저 서버:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

그런 다음 캔버스, http://localhost:5174에서:

```bash
bun run --cwd packages/flow dev
```

또는 빌드된 버전으로 실행하세요. vite 없이 동일한 앱을 제공합니다:

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
<p align="center">오픈 소스 AI 코딩 에이전트.</p>
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

### 설치

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# 패키지 매니저
npm i -g opencode-ai@latest        # bun/pnpm/yarn 도 가능
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 및 Linux (권장, 항상 최신)
brew install opencode              # macOS 및 Linux (공식 brew formula, 업데이트 빈도 낮음)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 어떤 OS든
nix run nixpkgs#opencode           # 또는 github:anomalyco/opencode 로 최신 dev 브랜치
```

> [!TIP]
> 설치 전에 0.1.x 보다 오래된 버전을 제거하세요.

### 데스크톱 앱 (BETA)

OpenCode 는 데스크톱 앱으로도 제공됩니다. [releases page](https://github.com/anomalyco/opencode/releases) 에서 직접 다운로드하거나 [opencode.ai/download](https://opencode.ai/download) 를 이용하세요.

| 플랫폼                | 다운로드                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, 또는 AppImage      |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 설치 디렉터리

설치 스크립트는 설치 경로를 다음 우선순위로 결정합니다.

1. `$OPENCODE_INSTALL_DIR` - 사용자 지정 설치 디렉터리
2. `$XDG_BIN_DIR` - XDG Base Directory Specification 준수 경로
3. `$HOME/bin` - 표준 사용자 바이너리 디렉터리 (존재하거나 생성 가능할 경우)
4. `$HOME/.opencode/bin` - 기본 폴백

```bash
# 예시
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 에는 내장 에이전트 2개가 있으며 `Tab` 키로 전환할 수 있습니다.

- **build** - 기본값, 개발 작업을 위한 전체 권한 에이전트
- **plan** - 분석 및 코드 탐색을 위한 읽기 전용 에이전트
  - 기본적으로 파일 편집을 거부
  - bash 명령 실행 전에 권한을 요청
  - 낯선 코드베이스를 탐색하거나 변경을 계획할 때 적합

또한 복잡한 검색과 여러 단계 작업을 위한 **general** 서브 에이전트가 포함되어 있습니다.
내부적으로 사용되며, 메시지에서 `@general` 로 호출할 수 있습니다.

[agents](https://opencode.ai/docs/agents) 에 대해 더 알아보세요.

### 문서

OpenCode 설정에 대한 자세한 내용은 [**문서**](https://opencode.ai/docs) 를 참고하세요.

### 기여하기

OpenCode 에 기여하고 싶다면, Pull Request 를 제출하기 전에 [contributing docs](./CONTRIBUTING.md) 를 읽어주세요.

### OpenCode 기반으로 만들기

OpenCode 와 관련된 프로젝트를 진행하면서 이름에 "opencode"(예: "opencode-dashboard" 또는 "opencode-mobile") 를 포함한다면, README 에 해당 프로젝트가 OpenCode 팀이 만든 것이 아니며 어떤 방식으로도 우리와 제휴되어 있지 않다는 점을 명시해 주세요.

---

**커뮤니티에 참여하기** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
