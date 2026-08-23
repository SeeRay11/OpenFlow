# OpenFlow

**OpenFlow, çok ajanlı yapay zekâ iş akışları için görsel bir oluşturucudur.** Rol
kartlarını bir tuvale sürükleyin, bir işlem hattını (planlayıcı → mimar → kodlayıcı)
bağlayın, kaydedin ve gerçek paralel ajanlarla çalıştırın.

OpenFlow kendi başına bir projedir. [opencode](https://github.com/anomalyco/opencode)
üzerine inşa edilmiştir ve onun bir çatalı (fork) olarak dağıtılır; başsız motoru
(`opencode serve`) alttaki ajanları sürer. OpenFlow'un kendi kodunun tamamı
[`packages/flow`](packages/flow) içinde yer alır; hiçbir upstream paketi
değiştirilmez, böylece OpenCode motoru güncel kalır ve upstream birleştirmeleri temiz
kalır. Orijinal OpenCode README'i aşağıda yer alır.

### Kurulum

**Ön koşullar**

- [Bun](https://bun.sh) 1.3 veya üzeri — OpenFlow'un ihtiyaç duyduğu tek çalışma
  zamanı (motoru, derlemeyi ve tuvali çalıştırır). Kontrol için `bun --version`.
- [Git](https://git-scm.com).

**Kodu alın**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` tüm workspace'i çeker — OpenCode motoru artı OpenFlow'un
[`packages/flow`](packages/flow) içindeki kendi kodu. İlk kurulum büyüktür; motorun
yerel (native) bağımlılıklarını indirir. Bir `postinstall` adımı `node-pty`'nin
önceden derlenmiş yardımcı ikili dosyalarını çalıştırılabilir olarak işaretler ve
Windows'ta hemen geri döner.

### Çalıştırma

Tek bir komut her iki süreci de başlatır, her platformda aynı şekilde:

```bash
bun openflow.ts
```

Motoru başlatır, yanıt verene kadar bekler, sonra tuvali http://localhost:5174
adresinde açar; Ctrl+C ikisini de durdurur. Ölü bir çalıştırmanın bağlı bıraktığı
bir port önce serbest bırakılır, halihazırda hizmet veren bir port ise ikinci kez
başlatılmak yerine yeniden kullanılır.

İki ince betik, kendi platformunun başlatıcısını tercih edenler için aynı dosyayı
sarar. Kendilerine ait bir mantıkları yoktur — yalnızca bayrakları `openflow.ts`'nin
zaten okuduğu ortam değişkenlerine çevirirler.

```powershell
.\openflow.ps1
```

```bash
./openflow.sh
```

**Windows'ta bu betik başlamayı reddedebilir:** PowerShell varsayılan olarak imzasız
yerel betikleri çalıştırmaz, bu yüzden `.\openflow.ps1` *"openflow.ps1 cannot be
loaded because running scripts is disabled on this system"* hatasıyla
başarısız olabilir. Klonlanmak yerine ZIP olarak indirilen bir depo ayrıca
internetten geldiği şeklinde işaretlenir ve bu da onu ikinci bir yoldan engeller.
`bun openflow.ts` bunların hiçbirine tabi değildir ve ikisini de aşmanın en kısa
yoludur. Yine de bu betiği kullanmak isterseniz kendi hesabınız için yerel betiklere
izin verin ve dosya bir ZIP'ten geldiyse engelini kaldırın:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\openflow.ps1
```

Bayraklar isteğe bağlıdır ve üç yüzey de aynı plana çözümlenir:

| PowerShell | shell | ortam | ne yapar |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | ajanların okuyup yazdığı depo — **gerçek dosyaları düzenlerler** |
| `-ServerPort <n>` | `-s`, `--server-port <n>` | `OPENCODE_SERVER_URL` | motor portu, varsayılan 4096 |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | vite çalıştırmak yerine statik paketi derleyip sun |
| `-Manage` | `-m`, `--manage` | `FLOW_MANAGE_SERVER=1` | motorun sahipliğini tuvale bırak; böylece yeniden başlatma düğmesi çalışır |
| `-Help` | `-h`, `--help` | — | bayrak listesini yazdır |
| — | — | `OPENFLOW_DRY_RUN=1` | çözümlenen planı yazdır ve hiçbir şey başlatma |

Ya da iki süreci elle başlatın. Önce sunucu:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Ardından tuval, http://localhost:5174 adresinde:

```bash
bun run --cwd packages/flow dev
```

Ya da derlenmiş halini çalıştırın; bu, aynı uygulamayı vite olmadan sunar:

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
<p align="center">Açık kaynaklı yapay zeka kodlama asistanı.</p>
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

### Kurulum

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Paket yöneticileri
npm i -g opencode-ai@latest        # veya bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS ve Linux (önerilir, her zaman güncel)
brew install opencode              # macOS ve Linux (resmi brew formülü, daha az güncellenir)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Tüm işletim sistemleri
nix run nixpkgs#opencode           # veya en güncel geliştirme dalı için github:anomalyco/opencode
```

> [!TIP]
> Kurulumdan önce 0.1.x'ten eski sürümleri kaldırın.

### Masaüstü Uygulaması (BETA)

OpenCode ayrıca masaüstü uygulaması olarak da mevcuttur. Doğrudan [sürüm sayfasından](https://github.com/anomalyco/opencode/releases) veya [opencode.ai/download](https://opencode.ai/download) adresinden indirebilirsiniz.

| Platform              | İndirme                            |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` veya AppImage       |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Kurulum Dizini (Installation Directory)

Kurulum betiği (install script), kurulum yolu (installation path) için aşağıdaki öncelik sırasını takip eder:

1. `$OPENCODE_INSTALL_DIR` - Özel kurulum dizini
2. `$XDG_BIN_DIR` - XDG Base Directory Specification uyumlu yol
3. `$HOME/bin` - Standart kullanıcı binary dizini (varsa veya oluşturulabiliyorsa)
4. `$HOME/.opencode/bin` - Varsayılan yedek konum

```bash
# Örnekler
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Ajanlar

OpenCode, `Tab` tuşuyla aralarında geçiş yapabileceğiniz iki yerleşik (built-in) ajan içerir.

- **build** - Varsayılan, geliştirme çalışmaları için tam erişimli ajan
- **plan** - Analiz ve kod keşfi için salt okunur ajan
  - Varsayılan olarak dosya düzenlemelerini reddeder
  - Bash komutlarını çalıştırmadan önce izin ister
  - Tanımadığınız kod tabanlarını keşfetmek veya değişiklikleri planlamak için ideal

Ayrıca, karmaşık aramalar ve çok adımlı görevler için bir **genel** alt ajan bulunmaktadır.
Bu dahili olarak kullanılır ve mesajlarda `@general` ile çağrılabilir.

[Ajanlar](https://opencode.ai/docs/agents) hakkında daha fazla bilgi edinin.

### Dokümantasyon

OpenCode'u nasıl yapılandıracağınız hakkında daha fazla bilgi için [**dokümantasyonumuza göz atın**](https://opencode.ai/docs).

### Katkıda Bulunma

OpenCode'a katkıda bulunmak istiyorsanız, lütfen bir pull request göndermeden önce [katkıda bulunma dokümanlarımızı](./CONTRIBUTING.md) okuyun.

### OpenCode Üzerine Geliştirme

OpenCode ile ilgili bir proje üzerinde çalışıyorsanız ve projenizin adının bir parçası olarak "opencode" kullanıyorsanız (örneğin, "opencode-dashboard" veya "opencode-mobile"), lütfen README dosyanıza projenin OpenCode ekibi tarafından geliştirilmediğini ve bizimle hiçbir şekilde bağlantılı olmadığını belirten bir not ekleyin.

---

**Topluluğumuza katılın** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
