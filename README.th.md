# OpenFlow

**OpenFlow เป็นเครื่องมือสร้างเวิร์กโฟลว์ AI แบบหลายเอเจนต์ในเชิงภาพ** ลากการ์ดบทบาทลงบน
ผืนผ้าใบ เชื่อมต่อไปป์ไลน์ (ผู้วางแผน → สถาปนิก → ผู้เขียนโค้ด) บันทึกไว้ แล้วรันด้วยเอเจนต์
ที่ทำงานขนานกันจริง

OpenFlow เป็นโปรเจกต์ของตัวเอง มันสร้างขึ้นบน
[opencode](https://github.com/anomalyco/opencode) — และเผยแพร่เป็นฟอร์ก (fork) ของมัน —
โดยเอนจินแบบไม่มีส่วนติดต่อ (`opencode serve`) เป็นตัวขับเคลื่อนเอเจนต์อยู่เบื้องหลัง โค้ด
ของ OpenFlow เองทั้งหมดอยู่ใน [`packages/flow`](packages/flow) ไม่มีการแก้ไขแพ็กเกจ
upstream ใด ๆ ดังนั้นเอนจิน OpenCode จึงทันสมัยอยู่เสมอ และการ merge จาก upstream ก็
สะอาด README ต้นฉบับของ OpenCode อยู่ด้านล่างนี้

### การติดตั้ง

**สิ่งที่ต้องมีก่อน**

- [Bun](https://bun.sh) 1.3 ขึ้นไป — รันไทม์เดียวที่ OpenFlow ต้องใช้ (มันรันเอนจิน การ
  build และผืนผ้าใบ) ตรวจสอบด้วย `bun --version`
- [Git](https://git-scm.com)

**รับโค้ด**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` จะดึงเวิร์กสเปซทั้งหมด — เอนจิน OpenCode พร้อมกับโค้ดของ OpenFlow เองใน
[`packages/flow`](packages/flow) การติดตั้งครั้งแรกมีขนาดใหญ่ มันจะดาวน์โหลดดีเพนเดนซี
เนทีฟของเอนจิน และรัน `postinstall` ที่ build `node-pty`

### การรัน

**เริ่มอย่างรวดเร็ว — คำสั่งเดียวเริ่มทั้งสองโปรเซส:**

```bash
./openflow.ps1   # Windows (PowerShell)
./openflow.sh    # macOS / Linux
```

ตัวเรียกใช้จะเริ่มเอนจิน รอจนกว่ามันจะเริ่มรับฟัง แล้วเปิดผืนผ้าใบที่
http://localhost:5174 ส่วน Ctrl+C จะหยุดทั้งสอง ชี้เอเจนต์ไปยังรีโปอื่นด้วย
`-Project <dir>` (PowerShell) หรือ `-p <dir>` (shell) ส่ง `-Built` / `-b` เพื่อเสิร์ฟ
บันเดิลที่ build แล้ว อย่างไรก็ตาม ให้ล็อกอินผู้ให้บริการก่อน (ดูด้านล่าง)

หรือเริ่มสองโปรเซสด้วยตนเอง เซิร์ฟเวอร์ก่อน:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

จากนั้นผืนผ้าใบ ที่ http://localhost:5174:

```bash
bun run --cwd packages/flow dev
```

หรือรันแบบ build แล้ว ซึ่งเสิร์ฟแอปเดียวกันโดยไม่ใช้ vite:

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
<p align="center">เอเจนต์การเขียนโค้ดด้วย AI แบบโอเพนซอร์ส</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="สถานะการสร้าง" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
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

### การติดตั้ง

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# ตัวจัดการแพ็กเกจ
npm i -g opencode-ai@latest        # หรือ bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS และ Linux (แนะนำ อัปเดตเสมอ)
brew install opencode              # macOS และ Linux (brew formula อย่างเป็นทางการ อัปเดตน้อยกว่า)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # ระบบปฏิบัติการใดก็ได้
nix run nixpkgs#opencode           # หรือ github:anomalyco/opencode สำหรับสาขาพัฒนาล่าสุด
```

> [!TIP]
> ลบเวอร์ชันที่เก่ากว่า 0.1.x ก่อนติดตั้ง

### แอปพลิเคชันเดสก์ท็อป (เบต้า)

OpenCode มีให้ใช้งานเป็นแอปพลิเคชันเดสก์ท็อป ดาวน์โหลดโดยตรงจาก [หน้ารุ่น](https://github.com/anomalyco/opencode/releases) หรือ [opencode.ai/download](https://opencode.ai/download)

| แพลตฟอร์ม             | ดาวน์โหลด                          |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, หรือ AppImage      |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### ไดเรกทอรีการติดตั้ง

สคริปต์การติดตั้งจะใช้ลำดับความสำคัญตามเส้นทางการติดตั้ง:

1. `$OPENCODE_INSTALL_DIR` - ไดเรกทอรีการติดตั้งที่กำหนดเอง
2. `$XDG_BIN_DIR` - เส้นทางที่สอดคล้องกับ XDG Base Directory Specification
3. `$HOME/bin` - ไดเรกทอรีไบนารีผู้ใช้มาตรฐาน (หากมีอยู่หรือสามารถสร้างได้)
4. `$HOME/.opencode/bin` - ค่าสำรองเริ่มต้น

```bash
# ตัวอย่าง
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### เอเจนต์

OpenCode รวมเอเจนต์ในตัวสองตัวที่คุณสามารถสลับได้ด้วยปุ่ม `Tab`

- **build** - เอเจนต์เริ่มต้น มีสิทธิ์เข้าถึงแบบเต็มสำหรับงานพัฒนา
- **plan** - เอเจนต์อ่านอย่างเดียวสำหรับการวิเคราะห์และการสำรวจโค้ด
  - ปฏิเสธการแก้ไขไฟล์โดยค่าเริ่มต้น
  - ขอสิทธิ์ก่อนเรียกใช้คำสั่ง bash
  - เหมาะสำหรับสำรวจโค้ดเบสที่ไม่คุ้นเคยหรือวางแผนการเปลี่ยนแปลง

นอกจากนี้ยังมีเอเจนต์ย่อย **general** สำหรับการค้นหาที่ซับซ้อนและงานหลายขั้นตอน
ใช้ภายในและสามารถเรียกใช้ได้โดยใช้ `@general` ในข้อความ

เรียนรู้เพิ่มเติมเกี่ยวกับ [เอเจนต์](https://opencode.ai/docs/agents)

### เอกสารประกอบ

สำหรับข้อมูลเพิ่มเติมเกี่ยวกับวิธีกำหนดค่า OpenCode [**ไปที่เอกสารของเรา**](https://opencode.ai/docs)

### การมีส่วนร่วม

หากคุณสนใจที่จะมีส่วนร่วมใน OpenCode โปรดอ่าน [เอกสารการมีส่วนร่วม](./CONTRIBUTING.md) ก่อนส่ง Pull Request

### การสร้างบน OpenCode

หากคุณทำงานในโปรเจกต์ที่เกี่ยวข้องกับ OpenCode และใช้ "opencode" เป็นส่วนหนึ่งของชื่อ เช่น "opencode-dashboard" หรือ "opencode-mobile" โปรดเพิ่มหมายเหตุใน README ของคุณเพื่อชี้แจงว่าไม่ได้สร้างโดยทีม OpenCode และไม่ได้เกี่ยวข้องกับเราในทางใด

---

**ร่วมชุมชนของเรา** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
