# GIA Cowork

**An autonomous AI workspace that runs on your Linux desktop.** GIA Cowork is the desktop counterpart to [GIA](https://github.com/alpha-1-design/gia-app) — same brain, bigger canvas. Where the Android app runs in a sandbox because phones don't give you a real shell, Cowork runs directly against your real system: a real terminal, a real filesystem, and a background daemon that stays alive after you close the window.

Built with [Tauri 2](https://tauri.app) — a Rust backend with a React 19 / TypeScript / Vite frontend.

**Version:** 0.1.0 (mobile GIA is on the `2.4.x` line).

---

## What it does

| Capability | How |
|---|---|
| 💬 **Chat + reasoning** | Streaming chat with visible think → work → think reasoning, tool calls, sources, and tasks |
| 🖥️ **Real terminal** | `src-tauri/src/terminal.rs` spawns `sh -c` directly on the host — sessions, kill, exit codes, timeouts. No proot, no sandbox |
| 📸 **Screen control** | Capture the screen, click, drag, type, scroll — real desktop automation (`screen.rs`) |
| 🧠 **Local LLM, model-agnostic** | Load *any* model — curated Qwen2.5 set (0.5B/1.5B/3B), or paste any HuggingFace/Ollama id with live progress bars. Load/unload to free RAM |
| 🔁 **Autonomous learning loop** | `src/unimind/` — leave GIA running on a task; it reflects, keeps a trace of what it tried, and feeds past attempts back in. Bounded (max iterations + stall-halt) so it can't spin forever |
| 🧩 **MCP + plugins + skills** | Model Context Protocol servers (SSE/stdio, OAuth), a plugin system, and a skills marketplace |
| 🛠️ **~120 tools** | Terminal, filesystem, code execution, web search, email, calendar, notes, tasks, reminders, smart home, messaging, and more — registered in `src/services/tools/index.ts` |
| 🔔 **Background daemon** | System tray + close-to-tray. GIA stays alive when the window is hidden |

## The desktop intelligence spine

These are the "always-on agent" features — they were built into the codebase but never connected to the app until they were wired up here:

- **Command palette** — `Ctrl/Cmd + K` anywhere in the app: switch modules, toggle web search / extended thinking / hands-off, open the terminal, pick a project folder, export/import your brain, manage MCP servers.
- **Right-click message menu** — copy, edit, retry, fork, continue, delete. The desktop-native way to act on a message (the mobile bottom-sheet is still there for touch).
- **Presence-aware autonomy** — polls the real lock state via systemd-logind (`presence.rs`). When you lock the screen, background work (automation engine + proactive engine) pauses; it resumes when you're back.
- **Smart notification triage** — every incoming notification is scored by `SmartNotificationEngine` (immediate / batched / silent) and only what matters gets a desktop notification. It learns from your dismissals.
- **Activity learning + proactive suggestions** — `AdaptiveScheduler` learns when you're most active from real interaction events; `ContextFusionEngine` fuses time-of-day, memories, and pending goals into proactive suggestions. Ask GIA for `activity_patterns`, `proactive_suggestions`, or `notification_policy`.
- **Rich MCP rendering** — images, GIFs, video, audio, JSON, markdown, and code from MCP servers render natively in the chat.
- **Real WhatsApp channel (OpenClaw-style two-way)** — a Baileys sidecar (supervised from `whatsapp_bridge.rs`) holds a real WhatsApp connection. Pair it by scanning a QR, and WhatsApp becomes a full channel: people message GIA → it surfaces a notification and **answers through GiaBrain**, replying in the same chat. Text goes out immediately; if a message stays unread past a deadline, GIA places a real WhatsApp voice call playing a TTS clip — auto-cancelled the moment the text is read. Tools: `whatsapp_bridge_start`, `whatsapp_bridge_status`, `whatsapp_bridge_stop`, `whatsapp_notify`, `whatsapp_auto_respond` (toggle automatic answering on/off).

## Architecture

```
src-tauri/            Rust backend (Tauri 2)
  terminal.rs         real sh -c execution, session tracking
  screen.rs           screen capture + input control
  presence.rs         lock-state via systemd-logind DBus
  whatsapp_bridge.rs  supervises the WhatsApp sidecar
  lib.rs              tray, background daemon, real /proc/meminfo system_info

src/
  modules/            9 modules: Chat, Analyst, Exam, Planner, Writer, Agents, Autonomy, Dashboard, Settings
  services/           ~150 services: GiaBrain, ToolRegistry, MCP, LocalLLM, ProviderRegistry, …
  services/tools/     ~120 tool definitions registered in tools/index.ts
  unimind/            autonomous learning loop (provider-agnostic)
  store/              Zustand stores (useGiaStore is the core)
  components/         UI: chat, settings, overlays, command palette, message context menu
```

**Generation pipeline:** `useChatState → useChatGeneration → GiaBrain.generate() → provider adapter → tool loop`. GIA is provider-agnostic — bring your own OpenAI/Anthropic/Gemini/local model.

## Honest status

**Working and verified:** frontend + tool system, real terminal, screen control, system tray daemon, system_info hardware report, local LLM loading (HF/Ollama), the learning loop, MCP client, command palette, right-click menus, presence-aware pausing, smart notifications, WhatsApp bridge tools.

**Deliberately not built yet:**
- **Unimind transport/sync** — the protocol spine exists (`src/unimind/types.ts`); the live P2P sync, device pairing, and cross-device action delegation are not implemented.
- **Keyboard/mouse idle-time detection** — X11/Wayland don't share one API; needs its own pass.
- **Camera presence / full-screen OCR** — privacy-sensitive; will ship gated behind explicit toggles.
- **Full "computer use" input control** — a bigger permission surface; gets its own design pass.
- **Browser automation** — the `browserAutomation` tools expect an external Playwright server at `localhost:3091`; Playwright is not bundled.

## Development

```bash
npm ci --legacy-peer-deps
npm run tauri dev        # requires a working Rust toolchain
```

## Building

```bash
npm run tauri build      # produces .deb, .AppImage, .rpm under src-tauri/target/release/bundle
```

## CI

`ci.yml` runs typecheck (`tsc -b --noEmit`) + frontend build + `cargo check`. `release.yml` builds the Linux bundles.
