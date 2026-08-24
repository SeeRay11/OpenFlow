# OpenFlow

**OpenFlow — это визуальный конструктор мультиагентных рабочих процессов ИИ.**
Перетаскивайте карточки ролей на холст, соединяйте конвейер (планировщик → архитектор
→ кодер), сохраняйте его и запускайте с реальными параллельными агентами.

OpenFlow — самостоятельный проект. Он построен на
[opencode](https://github.com/anomalyco/opencode) и поставляется как его форк; его
headless-движок (`opencode serve`) управляет агентами под капотом. Весь собственный
код OpenFlow находится в [`packages/flow`](packages/flow); ни один upstream-пакет не
изменяется, поэтому движок OpenCode остаётся актуальным, а слияния с upstream —
чистыми. Оригинальный README OpenCode приведён ниже.

### Установка

**Требования**

- [Bun](https://bun.sh) 1.3 или новее — единственная среда выполнения, которая нужна
  OpenFlow (она запускает движок, сборку и холст). Проверить: `bun --version`.
- [Git](https://git-scm.com).

**Получить код**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` подтягивает весь workspace — движок OpenCode плюс собственный код
OpenFlow в [`packages/flow`](packages/flow). Первая установка большая; она загружает
нативные зависимости движка. Шаг `postinstall` помечает готовые вспомогательные
бинарники `node-pty` как исполняемые, а на Windows завершается сразу.

### Остановить то, что уже запущено

OpenFlow занимает два порта: **4096** для движка и **5174** для холста. Если их
всё ещё держит предыдущий запуск, ручной старт движка падает с `Error:
Unexpected error` / `ServeError` — это занятый порт, а не сломанная установка.

`bun openflow.ts` справляется с этим сам: он переиспользует порт, который уже
отвечает, и освобождает тот, что оставил занятым мёртвый запуск. Убивать старые
процессы вручную стоит только тогда, когда нужен по-настоящему свежий движок —
например, после правки `opencode.json`, потому что движок кеширует конфигурацию
проекта при старте и больше её не перечитывает.

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

Обе команды безопасны, когда ничего не слушает: они просто не найдут процесс.
Они убивают любой процесс на этих портах, поэтому сначала проверьте, не запущено
ли там что-то другое:

```powershell
Get-NetTCPConnection -LocalPort 4096,5174 -State Listen | Select-Object LocalPort,OwningProcess
```

```bash
lsof -i :4096 -i :5174
```

**Если движок падает с `database is locked`,** значит где-то уже работает другой
движок opencode — вторая копия OpenFlow или движок, оставшийся от предыдущего
запуска. Все движки используют одну базу данных в каталоге данных opencode,
поэтому второй запущенный открыть её не может. Освобождение портов здесь не
помогает: тот движок вовсе не обязан их занимать. Остановите его по тому, что он
выполняет:

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'openflow\.ts|src/index\.ts serve|packages/flow dev' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```bash
pkill -f 'openflow\.ts|src/index\.ts serve|packages/flow dev'
```

Затем запустите OpenFlow снова. Если это повторяется каждый раз, скорее всего
OpenFlow склонирован в двух местах и запускаются оба — оставьте один.

### Запуск

Одна команда запускает оба процесса — одинаково на любой платформе:

```bash
bun openflow.ts
```

Она запускает движок, ждёт, пока он ответит, а затем открывает холст по адресу
http://localhost:5174; Ctrl+C останавливает оба. Порт, оставшийся занятым после
мёртвого запуска, сначала освобождается, а порт, который уже обслуживает запросы,
переиспользуется, а не запускается второй раз.

Два тонких скрипта оборачивают тот же самый файл — для тех, кому привычнее лаунчер
своей платформы. Собственной логики у них нет: они лишь превращают флаги в
переменные окружения, которые `openflow.ts` и так читает.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**В Windows этот скрипт может отказаться запускаться:** PowerShell по умолчанию не выполняет
неподписанные локальные скрипты, поэтому `.\openflow.ps1` может завершиться ошибкой
*"openflow.ps1 cannot be loaded because running scripts is disabled on this
system"*. Репозиторий, скачанный как ZIP, а не клонированный, вдобавок помечен как
полученный из интернета, что блокирует его вторым способом. `bun openflow.ts` не
подпадает ни под одно из этих ограничений и является кратчайшим путём в обход обоих.
Чтобы всё же использовать этот скрипт, разрешите локальные скрипты для своей учётной записи
и снимите блокировку с файла, если он пришёл из ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Флаги необязательны, и все три поверхности приводят к одному и тому же плану:

| PowerShell | shell | переменная окружения | что делает |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | репозиторий, который агенты читают и в который пишут — **они правят настоящие файлы** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | порт движка, по умолчанию 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | собрать и обслуживать статический бандл вместо запуска vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | отдать движок во владение холсту, благодаря чему заработает его кнопка перезапуска |
| `-Help` | `-h`, `--help` | — | вывести список флагов |
| — | — | `OPENFLOW_DRY_RUN=1` | вывести разрешённый план и ничего не запускать |

Либо запустите оба процесса вручную. Сначала сервер:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Затем холст, по адресу http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Либо запустите собранную версию, которая обслуживает то же приложение без vite:

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
<p align="center">Открытый AI-агент для программирования.</p>
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

### Установка

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Менеджеры пакетов
npm i -g opencode-ai@latest        # или bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS и Linux (рекомендуем, всегда актуально)
brew install opencode              # macOS и Linux (официальная формула brew, обновляется реже)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # любая ОС
nix run nixpkgs#opencode           # или github:anomalyco/opencode для самой свежей ветки dev
```

> [!TIP]
> Перед установкой удалите версии старше 0.1.x.

### Десктопное приложение (BETA)

OpenCode также доступен как десктопное приложение. Скачайте его со [страницы релизов](https://github.com/anomalyco/opencode/releases) или с [opencode.ai/download](https://opencode.ai/download).

| Платформа             | Загрузка                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` или AppImage        |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Каталог установки

Скрипт установки выбирает путь установки в следующем порядке приоритета:

1. `$OPENCODE_INSTALL_DIR` - Пользовательский каталог установки
2. `$XDG_BIN_DIR` - Путь, совместимый со спецификацией XDG Base Directory
3. `$HOME/bin` - Стандартный каталог пользовательских бинарников (если существует или можно создать)
4. `$HOME/.opencode/bin` - Fallback по умолчанию

```bash
# Примеры
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

В OpenCode есть два встроенных агента, между которыми можно переключаться клавишей `Tab`.

- **build** - По умолчанию, агент с полным доступом для разработки
- **plan** - Агент только для чтения для анализа и изучения кода
  - По умолчанию запрещает редактирование файлов
  - Запрашивает разрешение перед выполнением bash-команд
  - Идеален для изучения незнакомых кодовых баз или планирования изменений

Также включен сабагент **general** для сложных поисков и многошаговых задач.
Он используется внутренне и может быть вызван в сообщениях через `@general`.

Подробнее об [agents](https://opencode.ai/docs/agents).

### Документация

Больше информации о том, как настроить OpenCode: [**наши docs**](https://opencode.ai/docs).

### Вклад

Если вы хотите внести вклад в OpenCode, прочитайте [contributing docs](./CONTRIBUTING.md) перед тем, как отправлять pull request.

### Разработка на базе OpenCode

Если вы делаете проект, связанный с OpenCode, и используете "opencode" как часть имени (например, "opencode-dashboard" или "opencode-mobile"), добавьте примечание в README, чтобы уточнить, что проект не создан командой OpenCode и не аффилирован с нами.

---

**Присоединяйтесь к нашему сообществу** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
