<div align="center">

# ✦ GIA Cowork

**An autonomous AI workspace that lives on your Linux desktop — not in a browser tab.**

```
        .--"""--.
       /  °    °  \    👁  "I see you."
      |    ----    |      on-device. always. privately.
       \   (==)   /
        '--...--'
```

Real terminal. Real files. Real control of your machine.
The same brain as [GIA](https://github.com/alpha-1-design/gia-app) on Android — but where the phone app runs in a sandbox, Cowork *is* the machine.

![version](https://img.shields.io/badge/version-0.1.0-8b5cf6?style=for-the-badge)
![Tauri](https://img.shields.io/badge/Tauri%202-6a5acd?style=for-the-badge&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-e07a5f?style=for-the-badge&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React%2019-0ea5e9?style=for-the-badge&logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Privacy](https://img.shields.io/badge/local--first%20-%20never%20leaves%20your%20machine-34d399?style=for-the-badge)

</div>

---

## 🧬 Why Cowork?

Most AI assistants are guests. They live in a web page, politely asking permission for everything, unable to touch your actual computer.

**GIA Cowork is a resident.** It launches as a background daemon, lives in your system tray, and gets a real shell on your real system. You can leave it running on a task and walk away — it keeps working, learns from every attempt, and gets back to you.

- 🖥️ **Operate your desktop** — capture the screen, click, drag, type, scroll
- 👁️ **Jarvis eyes** — a floating orb that watches your desktop — on-device with your local models, or through your chat provider's vision model. Say "Hey GIA" and it lights up
- 🐚 **Run a real terminal** — `sh -c` on the host, sessions, kill, exit codes
- 🧠 **Think with any model** — OpenAI, Anthropic, Gemini, or a local model you load yourself (HuggingFace, Ollama — *any* model, no lock-in)
- 🔁 **Learn on the job** — an autonomous loop that reflects, keeps a memory of what it tried, and feeds past attempts back in
- 💬 **Meet you on WhatsApp** — pair it once with a QR code and people can message GIA like they'd message a friend. If you don't read its message in time, it calls you.
- 🔔 **Know when you're away** — it notices when your screen locks, pauses background work, and picks back up when you return

It's not a chatbot with a terminal bolted on. It's an **agent that owns your desktop** — and it's 100% private. Your data, your models, your machine.

---

## ✨ What it can do

| 🧠 Thinking | 🖥️ Acting |
|---|---|
| 💬 **Deep reasoning chats** — streaming responses with visible think → work → think reasoning, live tool calls, sources, task tracking | 🖥️ **Screen control** — see the screen, click, drag, type, scroll. Real desktop automation |
| 🧠 **Any model, any provider** — OpenAI / Anthropic / Gemini / local. A 0.5B Qwen or a 70B GGUF — your choice | 🐚 **Real terminal** — execute anything on the host with session tracking, kill, exit codes, timeouts |
| 📦 **Local model hub** — browse HuggingFace or your Ollama server, one-click download with live progress | 🧩 **MCP + plugins + skills** — Model Context Protocol (SSE/stdio, OAuth), plugins, a skills marketplace |

| 🔁 Autonomy | 👁️ Eyes & ears |
|---|---|
| 🔁 **Autonomous loop** — leave GIA on a task. It thinks, acts, records what it tried, improves across runs — bounded so it can't spin forever | 👁️ **Jarvis eyes** — floating orb + on-device vision (caption / OCR / objects). Call GIA by voice and it lights up; every action is observed → verified |
| 🛠️ **~120 tools** — files, code execution, web search, email, calendar, notes, tasks, reminders, smart home, messaging, and more | 💬 **Two-way WhatsApp** — pair via QR. Incoming messages notify you — and GIA answers them. Unread too long? It calls with the message read aloud |
| 🧠 **Activity intelligence** — GIA learns your most productive hours and how it should triage notifications | 🔔 **Presence-aware** — screen locked → work pauses. You're back → it resumes. No wasted cycles |

| 🔒 Trust |
|---|
| ⌨️ **Built for the desktop** — `Ctrl/Cmd+K` palette everywhere, right-click menus, system tray, close-to-tray daemon |
| 🔒 **Local-first privacy** — on-device models run locally; screenshots use your local vision models when loaded, otherwise your chat provider's vision model |

---

## 👁️ Jarvis eyes — the floating orb

A glass orb lives on your screen. It's GIA's attention made visible.

```
   SEE            THINK              FEED               ACT              VERIFY
┌──────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│ capture  │ → │ caption ·  │ → │ distilled  │ → │ she clicks │ → │ re-capture │
│ desktop  │   │ OCR · objs │   │ 1-line txt │   │ types,    │   │ did it     │
│ (20s,    │   │ all on-    │   │ to the     │   │ runs sh    │   │ land?      │
│ ambient) │   │ device     │   │ brain      │   │            │   │            │
└──────────┘   └────────────┘   └────────────┘   └────────────┘   └────────────┘
```

**The orb is her state bar:**

| | | |
|---|---|---|
| 🟢 **Listening** — you said "Hey GIA" (wake word / push-to-talk) | 🟣 **Thinking** — she's reasoning (ring spins) | 🩷 **Acting** — a desktop-changing tool is running now |
| 🔵 **Idle / Seeing** — ambient watch, breathing slowly | 🟠 **Speaking** — the orb pulses amber when she talks | ⚫ **Off** — dim little orb, eyes closed |

- **Toggle anytime** — *Settings → Developer → Jarvis Eyes (screen orb)*, or just tap the orb
- **Let it roam** — drag the orb to park it, or leave it alone: it wanders the screen on its own while it's watching
- **Observe → act → verify** — every desktop-changing tool flips her to `acting`, then takes a fresh look afterwards so she *sees her result land*
- **Private by design** — analysis runs on your on-device models (Transformers.js / ONNX) when they're loaded; if they aren't, the orb uses the vision model from your chat provider (the same provider your messages already go to). Only the distilled text ever reaches GIA's brain
- **Respects your lock screen** — no screen-watching while your screen is locked (presence-aware)
- **Ask about it** — use the `jarvis_look` tool to see what she's seeing right now

---

## 🚀 Quick start

### Install

| Package | For | Install |
|---|---|---|
| 📦 `.deb` | Debian · Ubuntu · Linux Mint | `sudo apt install ./GIA.Cowork_0.1.0_amd64.deb` |
| 🌀 `.rpm` | Fedora · RHEL · openSUSE | `sudo dnf install ./GIA.Cowork-0.1.0-1.x86_64.rpm` |
| 🧵 `.AppImage` | Any Linux | `chmod +x GIA.Cowork_0.1.0_amd64.AppImage && ./GIA.Cowork_0.1.0_amd64.AppImage` |

Grab the latest from the **[Releases](https://github.com/alpha-1-design/gia-cowork/releases)** page.

### First run

1. Open GIA Cowork — it starts as a tray daemon.
2. Add a model: pick a provider (OpenAI/Anthropic/Gemini) or load a **local model** — the curated Qwen set is one click; paste any HuggingFace/Ollama id.
3. Try the command palette: **`Ctrl+K`** → *"Open Engine Room"*, *"Pick Project Folder"*, *"Export Brain"*.
4. Press **`Ctrl+K` → "Terminal"** and ask GIA to run something. It has a real shell.
5. 👁️ Enable *Jarvis Eyes* in **Settings → Developer** and watch the orb wake up.

### Connect WhatsApp (optional, but cool)

1. Run `whatsapp_bridge_start` (or ask GIA to).
2. Scan the QR with **WhatsApp → Linked Devices** on the number you want GIA to use *(use a secondary number — this is an unofficial client, and WhatsApp's ToS apply)*.
3. Message that number from another phone. GIA answers. If it sends *you* something urgent and you don't read it, it calls.

> Turn auto-answering off anytime with `whatsapp_auto_respond off`.

### Connect the phone (Unimind pairing)

GIA Cowork runs a **built-in Unimind relay** — no server to install or start.

1. Open **Settings → Connections → Unimind** (or ask GIA to open it).
2. The relay shows that it's **running** and gives you the phone URL, e.g. `ws://192.168.1.50:8787/unimind` (tap it to copy).
3. On your phone: **GIA → Settings → Unimind**, enter the **same relay URL** and tap Connect.
4. Back on the desktop, your phone appears under **Devices** — now chat messages reach it, it can delegate actions to the desktop, and the follow-lock rule can lock this machine when you're active on mobile.

Two devices only find each other when they share **the same relay URL AND the same pairing id**. The pairing id is shown on the desktop's Unimind page (`uni-…`).

> Relay config: `UNIMIND_RELAY_PORT` (default `8787`), `UNIMIND_RELAY_SECRET` (optional shared secret clients must send). Only runs as part of the native desktop app; web previews use `relay/index.js` (`cd relay && npm install && npm start`).

---

## 🏗️ Architecture

```
src-tauri/            Rust backend (Tauri 2)
  terminal.rs         real sh -c execution, session tracking, kill, timeouts
  screen.rs           screen capture + input control (click/drag/type/scroll)
  presence.rs         lock-state via systemd-logind DBus
  whatsapp_bridge.rs  supervises the WhatsApp sidecar (Baileys, localhost API)
  unimind_relay.rs    embedded Unimind relay (auto-started on boot; no Node needed)
  lib.rs              system tray, background daemon, real /proc/meminfo hardware report

src/
  modules/            9 modules: Chat, Analyst, Exam, Planner, Writer, Agents, Autonomy, Dashboard, Settings
  services/           the brain: GiaBrain, ToolRegistry, MCP, LocalLLM, ProviderRegistry, ~150 services
  services/tools/     ~120 tool definitions, registered in tools/index.ts
  services/JarvisOrbService.ts   the orb driver — SEE → THINK → FEED (distills on-device vision)
  services/tools/jarvis.ts       the jarvis_look tool GIA uses to see the screen
  store/useJarvisStore.ts        orb state: enabled · state · vision readiness · feed
  unimind/            autonomous learning loop — provider-agnostic by design
  store/              Zustand state (useGiaStore is the core)
  components/         chat, settings, overlays, command palette, message context menus
```

**The generation pipeline:** `useChatState → useChatGeneration → GiaBrain.generate() → provider adapter → tool loop`. GIA is provider-agnostic — bring your own key or your own model.

**Authoring tools:** `defineTool()` (`src/services/tools/defineTool.ts`) — one zod schema produces the model-facing JSON schema *and* runtime validation, so a tool's contract lives in exactly one place. New tools export an array from `src/services/tools/*.ts` and register it in `tools/index.ts`.

---

## 🛠️ Development

```bash
npm ci --legacy-peer-deps
npm run tauri dev          # requires a Rust toolchain
npm run dev                # web preview at http://localhost:1420 (Tauri-only pieces are safely stubbed)
```

Build the installers:

```bash
npm run tauri build        # produces .deb / .AppImage / .rpm in src-tauri/target/release/bundle
```

CI runs typecheck + frontend build + `cargo check` on every push; tag pushes (`v*.*.*`) build and publish the release bundles.

---

## 🗺️ On the roadmap

- **Unimind sync** — live presence, chat, and cross-device actions ship today over the embedded relay; richer P2P data sync comes next
- **Idle-time awareness** — beyond screen lock (X11/Wayland idle detection needs its own pass)
- **Full "computer use"** — complete mouse/keyboard autonomy behind an explicit permission surface
- **Camera presence** — the last privacy-sensitive sensor; ships gated behind explicit toggles only

---

<div align="center">

**Built for people who'd rather own their assistant than rent one.**

```
        .--"""--.
       /  °    °  \
      |    ----    |    "Still watching. Still local."
       \   (==)   /
        '--...--'
```

Questions, ideas, bugs → [open an issue](https://github.com/alpha-1-design/gia-cowork/issues).

</div>