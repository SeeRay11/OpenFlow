# OpenFlow

**OpenFlow হলো মাল্টি-এজেন্ট AI ওয়ার্কফ্লোর জন্য একটি ভিজ্যুয়াল বিল্ডার।** রোল কার্ডগুলো
একটি ক্যানভাসে টেনে আনুন, একটি পাইপলাইন (প্ল্যানার → আর্কিটেক্ট → কোডার) সংযুক্ত করুন,
সেটি সেভ করুন, এবং সত্যিকারের সমান্তরাল এজেন্ট দিয়ে চালান।

OpenFlow তার নিজস্ব একটি প্রকল্প। এটি
[opencode](https://github.com/anomalyco/opencode)-এর উপর তৈরি — এবং এর একটি ফর্ক
হিসেবে সরবরাহ করা হয় — যার হেডলেস ইঞ্জিন (`opencode serve`) ভেতরে এজেন্টগুলো চালায়।
OpenFlow-এর নিজস্ব সমস্ত কোড [`packages/flow`](packages/flow)-এ থাকে; কোনো আপস্ট্রিম
প্যাকেজ পরিবর্তন করা হয় না, তাই OpenCode ইঞ্জিন সর্বদা হালনাগাদ থাকে এবং আপস্ট্রিম মার্জ
পরিষ্কার থাকে। মূল OpenCode README নিচে দেওয়া হলো।

### ইনস্টলেশন

**পূর্বশর্ত**

- [Bun](https://bun.sh) 1.3 বা তার নতুন — OpenFlow-এর প্রয়োজন হয় এমন একমাত্র রানটাইম
  (এটি ইঞ্জিন, বিল্ড এবং ক্যানভাস চালায়)। `bun --version` দিয়ে যাচাই করুন।
- [Git](https://git-scm.com)।

**কোড সংগ্রহ করুন**

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` পুরো ওয়ার্কস্পেস টেনে আনে — OpenCode ইঞ্জিন এবং সেই সাথে
[`packages/flow`](packages/flow)-এ থাকা OpenFlow-এর নিজস্ব কোড। প্রথম ইনস্টল বড়; এটি
ইঞ্জিনের নেটিভ নির্ভরতা ডাউনলোড করে এবং একটি `postinstall` চালায় যা `node-pty` বিল্ড
করে।

### চালানো

**দ্রুত শুরু — একটি কমান্ডই দুটি প্রসেস চালু করে:**

```bash
./openflow.ps1   # Windows (PowerShell)
./openflow.sh    # macOS / Linux
```

লঞ্চারটি ইঞ্জিন চালু করে, এটি লিসেন করা শুরু না করা পর্যন্ত অপেক্ষা করে, তারপর
http://localhost:5174-এ ক্যানভাস খোলে; Ctrl+C দুটোই থামায়। `-Project <dir>`
(PowerShell) বা `-p <dir>` (shell) দিয়ে এজেন্টগুলোকে অন্য একটি রিপোতে নির্দেশ করুন;
বিল্ড করা বান্ডল পরিবেশন করতে `-Built` / `-b` পাস করুন। তবুও আগে একটি প্রোভাইডারে লগ ইন
করুন (নিচে দেখুন)।

অথবা দুটি প্রসেস হাতে চালু করুন। প্রথমে সার্ভার:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

তারপর ক্যানভাস, http://localhost:5174-এ:

```bash
bun run --cwd packages/flow dev
```

অথবা বিল্ড করা সংস্করণে চালান, যা vite ছাড়াই একই অ্যাপ পরিবেশন করে:

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
<p align="center">ওপেন সোর্স এআই কোডিং এজেন্ট।</p>
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

### ইনস্টলেশন (Installation)

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> ইনস্টল করার আগে ০.১.x এর চেয়ে পুরোনো ভার্সনগুলো মুছে ফেলুন।

### ডেস্কটপ অ্যাপ (BETA)

OpenCode ডেস্কটপ অ্যাপ্লিকেশন হিসেবেও উপলব্ধ। সরাসরি [রিলিজ পেজ](https://github.com/anomalyco/opencode/releases) অথবা [opencode.ai/download](https://opencode.ai/download) থেকে ডাউনলোড করুন।

| প্ল্যাটফর্ম           | ডাউনলোড                            |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### ইনস্টলেশন ডিরেক্টরি (Installation Directory)

ইনস্টল স্ক্রিপ্টটি ইনস্টলেশন পাতের জন্য নিম্নলিখিত অগ্রাধিকার ক্রম মেনে চলে:

1. `$OPENCODE_INSTALL_DIR` - কাস্টম ইনস্টলেশন ডিরেক্টরি
2. `$XDG_BIN_DIR` - XDG বেস ডিরেক্টরি স্পেসিফিকেশন সমর্থিত পাথ
3. `$HOME/bin` - সাধারণ ব্যবহারকারী বাইনারি ডিরেক্টরি (যদি বিদ্যমান থাকে বা তৈরি করা যায়)
4. `$HOME/.opencode/bin` - ডিফল্ট ফলব্যাক

```bash
# উদাহরণ
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### এজেন্টস (Agents)

OpenCode এ দুটি বিল্ট-ইন এজেন্ট রয়েছে যা আপনি `Tab` কি(key) দিয়ে পরিবর্তন করতে পারবেন।

- **build** - ডিফল্ট, ডেভেলপমেন্টের কাজের জন্য সম্পূর্ণ অ্যাক্সেসযুক্ত এজেন্ট
- **plan** - বিশ্লেষণ এবং কোড এক্সপ্লোরেশনের জন্য রিড-ওনলি এজেন্ট
  - ডিফল্টভাবে ফাইল এডিট করতে দেয় না
  - ব্যাশ কমান্ড চালানোর আগে অনুমতি চায়
  - অপরিচিত কোডবেস এক্সপ্লোর করা বা পরিবর্তনের পরিকল্পনা করার জন্য আদর্শ

এছাড়াও জটিল অনুসন্ধান এবং মাল্টিস্টেপ টাস্কের জন্য একটি **general** সাবএজেন্ট অন্তর্ভুক্ত রয়েছে।
এটি অভ্যন্তরীণভাবে ব্যবহৃত হয় এবং মেসেজে `@general` লিখে ব্যবহার করা যেতে পারে।

এজেন্টদের সম্পর্কে আরও জানুন: [docs](https://opencode.ai/docs/agents)।

### ডকুমেন্টেশন (Documentation)

কিভাবে OpenCode কনফিগার করবেন সে সম্পর্কে আরও তথ্যের জন্য, [**আমাদের ডকস দেখুন**](https://opencode.ai/docs)।

### অবদান (Contributing)

আপনি যদি OpenCode এ অবদান রাখতে চান, অনুগ্রহ করে একটি পুল রিকোয়েস্ট সাবমিট করার আগে আমাদের [কন্ট্রিবিউটিং ডকস](./CONTRIBUTING.md) পড়ে নিন।

### OpenCode এর উপর বিল্ডিং (Building on OpenCode)

আপনি যদি এমন প্রজেক্টে কাজ করেন যা OpenCode এর সাথে সম্পর্কিত এবং প্রজেক্টের নামের অংশ হিসেবে "opencode" ব্যবহার করেন, উদাহরণস্বরূপ "opencode-dashboard" বা "opencode-mobile", তবে দয়া করে আপনার README তে একটি নোট যোগ করে স্পষ্ট করুন যে এই প্রজেক্টটি OpenCode দল দ্বারা তৈরি হয়নি এবং আমাদের সাথে এর কোনো সরাসরি সম্পর্ক নেই।

---

**আমাদের কমিউনিটিতে যুক্ত হোন** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
