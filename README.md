<div align="center">

# ✦ GIA Cowork

**An autonomous AI workspace that lives on your Linux desktop — not in a browser tab.**

Real terminal. Real files. Real control of your machine.
The same brain as [GIA](https://github.com/alpha-1-design/gia-app) on Android — but where the phone app runs in a sandbox, Cowork *is* the machine.

`Tauri 2 · Rust · React 19 · TypeScript`

</div>

---

## Why Cowork?

Most AI assistants are guests. They live in a web page, politely asking permission for everything, unable to touch your actual computer.

**GIA Cowork is a resident.** It launches as a background daemon, lives in your system tray, and gets a real shell on your real system. You can leave it running on a task and walk away — it keeps working, learns from every attempt, and gets back to you. It can:

- 🖥️ **Operate your desktop** — capture the screen, click, drag, type, scroll
- 🐚 **Run a real terminal** — `sh -c` on the host, sessions, kill, exit codes
- 🧠 **Think with any model** — OpenAI, Anthropic, Gemini, or a local model you load yourself (HuggingFace, Ollama — *any* model, no lock-in)
- 🔁 **Learn on the job** — an autonomous loop that reflects, keeps a memory of what it tried, and feeds past attempts back in
- 💬 **Meet you on WhatsApp** — pair it once with a QR code and people can message GIA like they'd message a friend. If you don't read its message in time, it calls you.
- 🔔 **Know when you're away** — it notices when your screen locks, pauses background work, and picks back up when you return

It's not a chatbot with a terminal bolted on. It's an **agent that owns your desktop** — and it's 100% private. Your data, your models, your machine.

---

## ✨ What it can do

| | |
|---|---|
| 💬 **Deep reasoning chats** | Streaming responses with visible think → work → think reasoning, live tool calls, sources, and task tracking |
| 🖥️ **Screen control** | See the screen, click, drag, type, scroll — real desktop automation |
| 🐚 **Real terminal** | Execute anything on the host with session tracking, kill, exit codes, and timeouts |
| 🧠 **Any model, any provider** | OpenAI / Anthropic / Gemini / local. Load a 0.5B Qwen or a 70B GGUF — your choice |
| 📦 **Local model hub** | Browse HuggingFace or your Ollama server, one-click download with live progress |
| 🔁 **Autonomous loop** | Leave GIA on a task. It thinks, acts, records what it tried, and improves across runs — bounded so it can't spin forever |
| 🧩 **MCP + plugins + skills** | Model Context Protocol servers (SSE/stdio, OAuth), a plugin system, and a skills marketplace |
| 🛠️ **~120 tools** | Files, code execution, web search, email, calendar, notes, tasks, reminders, smart home, messaging, and more |
| 💬 **Two-way WhatsApp** | Pair via QR. Incoming messages notify you — and GIA answers them. Unread for too long? It calls with the message read aloud |
| 🔔 **Presence-aware** | Screen locked → background work pauses. You're back → it resumes. No wasted cycles |
| 🧠 **Activity intelligence** | GIA learns when you're most productive and can tell you your best hours, what deserves attention, and how it triages notifications |
| ⌨️ **Built for the desktop** | `Ctrl/Cmd+K` command palette everywhere, right-click menus on messages, system tray, close-to-tray daemon |

---

## 🚀 Quick start

### Install

| Package | For | Install |
|---|---|---|
| `.deb` | Debian · Ubuntu · Linux Mint | `sudo apt install ./GIA.Cowork_0.1.0_amd64.deb` |
| `.rpm` | Fedora · RHEL · openSUSE | `sudo dnf install ./GIA.Cowork-0.1.0-1.x86_64.rpm` |
| `.AppImage` | Any Linux | `chmod +x GIA.Cowork_0.1.0_amd64.AppImage && ./GIA.Cowork_0.1.0_amd64.AppImage` |

Grab the latest from the **[Releases](https://github.com/alpha-1-design/gia-cowork/releases)** page.

### First run

1. Open GIA Cowork — it starts as a tray daemon.
2. Add a model: pick a provider (OpenAI/Anthropic/Gemini) or load a **local model** — the curated Qwen set is one click; or paste any HuggingFace/Ollama id.
3. Try the command palette: **`Ctrl+K`** → *"Open Engine Room"*, *"Pick Project Folder"*, *"Export Brain"*.
4. Press **`Ctrl+K` → "Terminal"** and ask GIA to run something. It has a real shell.

### Connect WhatsApp (optional, but cool)

1. Run `whatsapp_bridge_start` (or ask GIA to).
2. Scan the QR with **WhatsApp → Linked Devices** on the number you want GIA to use *(use a secondary number — this is an unofficial client, and WhatsApp's ToS apply)*.
3. Message that number from another phone. GIA answers. If it sends *you* something urgent and you don't read it, it calls.

> Turn auto-answering off anytime with `whatsapp_auto_respond off`.

---

## 🏗️ Architecture

```
src-tauri/            Rust backend (Tauri 2)
  terminal.rs         real sh -c execution, session tracking, kill, timeouts
  screen.rs           screen capture + input control (click/drag/type/scroll)
  presence.rs         lock-state via systemd-logind DBus
  whatsapp_bridge.rs  supervises the WhatsApp sidecar (Baileys, localhost API)
  lib.rs              system tray, background daemon, real /proc/meminfo hardware report

src/
  modules/            9 modules: Chat, Analyst, Exam, Planner, Writer, Agents, Autonomy, Dashboard, Settings
  services/           the brain: GiaBrain, ToolRegistry, MCP, LocalLLM, ProviderRegistry, ~150 services
  services/tools/     ~120 tool definitions, registered in tools/index.ts
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
```

Build the installers:

```bash
npm run tauri build        # produces .deb / .AppImage / .rpm in src-tauri/target/release/bundle
```

CI runs typecheck + frontend build + `cargo check` on every push; tag pushes (`v*.*.*`) build and publish the release bundles.

---

## 🗺️ On the roadmap

- **Unimind sync** — the cross-device protocol spine is designed (`src/unimind/types.ts`); live P2P sync and device pairing come next
- **Idle-time awareness** — beyond screen lock (X11/Wayland idle detection needs its own pass)
- **Full "computer use"** — complete mouse/keyboard autonomy behind an explicit permission surface
- **Camera presence & OCR** — privacy-sensitive; ships gated behind explicit toggles only

---

<div align="center">

**Built for people who'd rather own their assistant than rent one.**

Questions, ideas, bugs → [open an issue](https://github.com/alpha-1-design/gia-cowork/issues).

</div>
