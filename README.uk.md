# OpenFlow

**OpenFlow — це візуальний конструктор багатоагентних робочих процесів ШІ.**
Перетягуйте картки ролей на полотно, з'єднуйте конвеєр (планувальник → архітектор →
кодер), зберігайте його та запускайте зі справжніми паралельними агентами.

OpenFlow — самостійний проєкт. Він побудований на
[opencode](https://github.com/anomalyco/opencode) і постачається як його форк; його
headless-рушій (`opencode serve`) керує агентами під капотом. Увесь власний код
OpenFlow міститься в [`packages/flow`](packages/flow); жоден upstream-пакет не
змінюється, тож рушій OpenCode лишається актуальним, а злиття з upstream —
чистими. Оригінальний README OpenCode наведено нижче.

### Встановлення

**Передумови**

- [Bun](https://bun.sh) 1.3 або новіший — єдине середовище виконання, потрібне
  OpenFlow (воно запускає рушій, збірку та полотно). Перевірити: `bun --version`.
- [Git](https://git-scm.com).

**Отримати код**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` підтягує весь workspace — рушій OpenCode плюс власний код OpenFlow у
[`packages/flow`](packages/flow). Перше встановлення велике; воно завантажує нативні
залежності рушія. Крок `postinstall` позначає готові допоміжні бінарники `node-pty`
як виконувані, а на Windows завершується одразу.

### Запуск

Одна команда запускає обидва процеси — однаково на будь-якій платформі:

```bash
bun openflow.ts
```

Вона запускає рушій, чекає, доки він відповість, а потім відкриває полотно за
адресою http://localhost:5174; Ctrl+C зупиняє обидва. Порт, що лишився зайнятим
після мертвого запуску, спершу звільняється, а порт, який уже обслуговує запити,
повторно використовується, а не запускається вдруге.

Два тонкі скрипти загортають той самий файл — для тих, кому звичніший лаунчер
власної платформи. Власної логіки вони не мають: вони лише перетворюють прапорці на
змінні середовища, які `openflow.ts` і так читає.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**У Windows цей скрипт може відмовитися запускатися:** PowerShell типово не виконує
непідписані локальні скрипти, тож `.\openflow.ps1` може завершитися помилкою
*"openflow.ps1 cannot be loaded because running scripts is disabled on this
system"*. Репозиторій, завантажений як ZIP, а не клонований, до того ж позначено як
отриманий з інтернету, що блокує його вдруге. `bun openflow.ts` не підпадає під
жодне з цих обмежень і є найкоротшим шляхом повз обидва. Щоб усе ж скористатися цим
скриптом, дозвольте локальні скрипти для власного облікового запису та зніміть
блокування з файлу, якщо він надійшов із ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Прапорці необов'язкові, і всі три поверхні зводяться до одного плану:

| PowerShell | shell | змінна середовища | що робить |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | репозиторій, який агенти читають і в який пишуть — **вони правлять справжні файли** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | порт рушія, типово 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | зібрати й обслуговувати статичний бандл замість запуску vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | віддати рушій у володіння полотну, завдяки чому запрацює його кнопка перезапуску |
| `-Help` | `-h`, `--help` | — | вивести список прапорців |
| — | — | `OPENFLOW_DRY_RUN=1` | вивести визначений план і нічого не запускати |

Або запустіть обидва процеси вручну. Спочатку сервер:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Потім полотно, за адресою http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

Або запустіть зібрану версію, яка обслуговує той самий застосунок без vite:

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
<p align="center">AI-агент для програмування з відкритим кодом.</p>
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

### Встановлення

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Менеджери пакетів
npm i -g opencode-ai@latest        # або bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS і Linux (рекомендовано, завжди актуально)
brew install opencode              # macOS і Linux (офіційна формула Homebrew, оновлюється рідше)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Будь-яка ОС
nix run nixpkgs#opencode           # або github:anomalyco/opencode для найновішої dev-гілки
```

> [!TIP]
> Перед встановленням видаліть версії старші за 0.1.x.

### Десктопний застосунок (BETA)

OpenCode також доступний як десктопний застосунок. Завантажуйте напряму зі [сторінки релізів](https://github.com/anomalyco/opencode/releases) або [opencode.ai/download](https://opencode.ai/download).

| Платформа             | Завантаження                       |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` або AppImage        |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Каталог встановлення

Скрипт встановлення дотримується такого порядку пріоритету для шляху встановлення:

1. `$OPENCODE_INSTALL_DIR` - Користувацький каталог встановлення
2. `$XDG_BIN_DIR` - Шлях, сумісний зі специфікацією XDG Base Directory
3. `$HOME/bin` - Стандартний каталог користувацьких бінарників (якщо існує або його можна створити)
4. `$HOME/.opencode/bin` - Резервний варіант за замовчуванням

```bash
# Приклади
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Агенти

OpenCode містить два вбудовані агенти, між якими можна перемикатися клавішею `Tab`.

- **build** - Агент за замовчуванням із повним доступом для завдань розробки
- **plan** - Агент лише для читання для аналізу та дослідження коду
  - За замовчуванням забороняє редагування файлів
  - Запитує дозвіл перед запуском bash-команд
  - Ідеально підходить для дослідження незнайомих кодових баз або планування змін

Також доступний допоміжний агент **general** для складного пошуку та багатокрокових завдань.
Він використовується всередині системи й може бути викликаний у повідомленнях через `@general`.

Дізнайтеся більше про [agents](https://opencode.ai/docs/agents).

### Документація

Щоб дізнатися більше про налаштування OpenCode, [**перейдіть до нашої документації**](https://opencode.ai/docs).

### Внесок

Якщо ви хочете зробити внесок в OpenCode, будь ласка, прочитайте нашу [документацію для контриб'юторів](./CONTRIBUTING.md) перед надсиланням pull request.

### Проєкти на базі OpenCode

Якщо ви працюєте над проєктом, пов'язаним з OpenCode, і використовуєте "opencode" у назві, наприклад "opencode-dashboard" або "opencode-mobile", додайте примітку до свого README.
Уточніть, що цей проєкт не створений командою OpenCode і жодним чином не афілійований із нами.

---

**Приєднуйтеся до нашої спільноти** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
