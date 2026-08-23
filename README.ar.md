# OpenFlow

**‏OpenFlow هو أداة بناء مرئية لسير عمل الذكاء الاصطناعي متعدد الوكلاء.** اسحب بطاقات
الأدوار إلى لوحة، وصِّل خط أنابيب (مخطِّط ← مهندس معماري ← مبرمج)، احفظه، ثم شغِّله
بوكلاء متوازين حقيقيين.

‏OpenFlow مشروع قائم بذاته. إنه مبني على
[opencode](https://github.com/anomalyco/opencode) — ويُوزَّع كنسخة متفرعة (fork) منه —
ويقود محركه بلا واجهة (`opencode serve`) الوكلاءَ في الأسفل. يوجد كل كود OpenFlow الخاص
في [`packages/flow`](packages/flow)؛ ولا يُعدَّل أي حزمة upstream، لذا يبقى محرك
OpenCode محدَّثًا وتبقى عمليات الدمج مع upstream نظيفة. يلي ذلك أدناه ملف README الأصلي
لـ OpenCode.

### التثبيت

**المتطلبات المسبقة**

- [Bun](https://bun.sh) 1.3 أو أحدث — بيئة التشغيل الوحيدة التي يحتاجها OpenFlow (تشغِّل
  المحرك والبناء واللوحة). تحقَّق عبر `bun --version`.
- [Git](https://git-scm.com).

**احصل على الكود**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

يجلب `bun install` مساحة العمل بأكملها — محرك OpenCode بالإضافة إلى كود OpenFlow الخاص
في [`packages/flow`](packages/flow). التثبيت الأول كبير؛ إذ يُنزِّل التبعيات الأصلية
للمحرك. أما خطوة `postinstall` فتكتفي بوسم الملفات التنفيذية المساعدة المبنية مسبقًا
لـ `node-pty` بأنها قابلة للتنفيذ، وتعود فورًا على Windows دون أن تفعل شيئًا.

### التشغيل

أمر واحد يبدأ كلتا العمليتين، بالطريقة نفسها على كل نظام:

```bash
bun openflow.ts
```

يبدأ المحرك، وينتظر حتى يستجيب، ثم يفتح اللوحة على http://localhost:5174؛ ويوقف Ctrl+C
كليهما. أي منفذ تركه تشغيل ميت محجوزًا يُحرَّر أولًا، وأي منفذ يقدِّم الخدمة بالفعل
يُعاد استخدامه بدل تشغيله مرة ثانية.

‏هناك سكربتان مُغلِّفان بسيطان يلفّان الملف نفسه لمن يفضّل مُشغِّل نظامه. ولا يحتويان على
أي منطق خاص بهما — فهما يترجمان الرايات إلى متغيرات البيئة التي يقرؤها `openflow.ts`
أصلًا.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**على Windows قد يرفض السكربت المُغلِّف الانطلاق:** لا يشغِّل PowerShell افتراضيًا السكربتات
المحلية غير الموقَّعة، لذا قد يفشل `.\openflow.ps1` بالرسالة *"openflow.ps1 cannot be
loaded because running scripts is disabled on this system"*. كما أن المستودع الذي
يُنزَّل كملف ZIP بدل استنساخه يوسَم بأنه آتٍ من الإنترنت، فيُحجب بطريقة ثانية. و`bun
openflow.ts` لا يخضع لأي منهما وهو أقصر طريق لتجاوزهما معًا. ولاستعمال السكربت المُغلِّف
رغم ذلك، اسمح بالسكربتات المحلية لحسابك أنت، وارفع الحجب عن الملف إن كان قادمًا من ملف
ZIP:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

الرايات اختيارية، وتؤول الواجهات الثلاث إلى الخطة نفسها:

| PowerShell | shell | البيئة | ما الذي يفعله |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | المستودع الذي يقرأ منه الوكلاء ويكتبون فيه — **إنهم يعدِّلون ملفات حقيقية** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | منفذ المحرك، والافتراضي 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | بناء الحزمة الساكنة وتقديمها بدل تشغيل vite |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | جعل اللوحة تملك المحرك، وبذلك يعمل زر إعادة التشغيل فيها |
| `-Help` | `-h`, `--help` | — | طباعة قائمة الرايات |
| — | — | `OPENFLOW_DRY_RUN=1` | طباعة الخطة المحسوبة دون تشغيل أي شيء |

أو ابدأ العمليتين يدويًا. الخادم أولًا:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

ثم اللوحة، على http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

أو شغِّله مبنيًا، وهو ما يقدِّم التطبيق نفسه دون vite:

```bash
bun run --cwd packages/flow build && bun run --cwd packages/flow start
```

---

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="شعار OpenCode">
    </picture>
  </a>
</p>

<p align="center"><sub><b>OpenFlow</b> is an independent fork. It is not affiliated with, sponsored by, or endorsed by the OpenCode team.</sub></p>
<p align="center">وكيل برمجة بالذكاء الاصطناعي مفتوح المصدر.</p>
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

### التثبيت

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# مديري الحزم
npm i -g opencode-ai@latest        # او bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS و Linux (موصى به، دائما محدث)
brew install opencode              # macOS و Linux (صيغة brew الرسمية، تحديث اقل)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # اي نظام
nix run nixpkgs#opencode           # او github:anomalyco/opencode لاحدث فرع dev
```

> [!TIP]
> احذف الاصدارات الاقدم من 0.1.x قبل التثبيت.

### تطبيق سطح المكتب (BETA)

يتوفر OpenCode ايضا كتطبيق سطح مكتب. قم بالتنزيل مباشرة من [صفحة الاصدارات](https://github.com/anomalyco/opencode/releases) او من [opencode.ai/download](https://opencode.ai/download).

| المنصة                | التنزيل                            |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb` او `.rpm` او AppImage       |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### مجلد التثبيت

يحترم سكربت التثبيت ترتيب الاولوية التالي لمسار التثبيت:

1. `$OPENCODE_INSTALL_DIR` - مجلد تثبيت مخصص
2. `$XDG_BIN_DIR` - مسار متوافق مع مواصفات XDG Base Directory
3. `$HOME/bin` - مجلد الثنائيات القياسي للمستخدم (ان وجد او امكن انشاؤه)
4. `$HOME/.opencode/bin` - المسار الافتراضي الاحتياطي

```bash
# امثلة
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

يتضمن OpenCode وكيليْن (Agents) مدمجين يمكنك التبديل بينهما باستخدام زر `Tab`.

- **build** - الافتراضي، وكيل بصلاحيات كاملة لاعمال التطوير
- **plan** - وكيل للقراءة فقط للتحليل واستكشاف الكود
  - يرفض تعديل الملفات افتراضيا
  - يطلب الاذن قبل تشغيل اوامر bash
  - مثالي لاستكشاف قواعد كود غير مألوفة او لتخطيط التغييرات

بالاضافة الى ذلك يوجد وكيل فرعي **general** للبحث المعقد والمهام متعددة الخطوات.
يستخدم داخليا ويمكن استدعاؤه بكتابة `@general` في الرسائل.

تعرف على المزيد حول [agents](https://opencode.ai/docs/agents).

### التوثيق

لمزيد من المعلومات حول كيفية ضبط OpenCode، [**راجع التوثيق**](https://opencode.ai/docs).

### المساهمة

اذا كنت مهتما بالمساهمة في OpenCode، يرجى قراءة [contributing docs](./CONTRIBUTING.md) قبل ارسال pull request.

### البناء فوق OpenCode

اذا كنت تعمل على مشروع مرتبط بـ OpenCode ويستخدم "opencode" كجزء من اسمه (مثل "opencode-dashboard" او "opencode-mobile")، يرجى اضافة ملاحظة في README توضح انه ليس مبنيا بواسطة فريق OpenCode ولا يرتبط بنا بأي شكل.

---

**انضم الى مجتمعنا** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
