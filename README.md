# GIA Cowork

GIA Cowork is the Linux desktop counterpart to [GIA](https://github.com/alpha-1-design/gia-app) — same brain,
bigger canvas. Where GIA on Android runs in a proot/Alpine sandbox because
phones don't give you a real shell, Cowork runs directly against your real
Linux system: real terminal, real filesystem, real background daemon.

Built with [Tauri](https://tauri.app) (Rust backend, React/TypeScript frontend —
the same frontend codebase as GIA mobile, reused directly).

**Version:** desktop Cowork is `0.1.0` (mobile GIA is on the `2.4.x` line).

## Status

What's real and verified as of this commit:

- ✅ Frontend (chat, brain, MCP client, terminal UI, settings) — ports
  directly from GIA mobile with no changes; TypeScript compiles clean,
  production `vite build` succeeds.
- ✅ Real terminal backend (`src-tauri/src/terminal.rs`) — spawns `sh -c`
  directly on the host, no sandbox. Session tracking, kill, exit codes,
  timeouts.
- ✅ System tray + background daemon (close-to-tray instead of quitting).
- ✅ Screen lock-state presence detection via systemd-logind DBus
  (`src-tauri/src/presence.rs`).
- ✅ **Real device detection** — `src-tauri/src/lib.rs` exposes a `system_info`
  Rust command that reads `/proc/meminfo` and CPU core count from the OS
  (not Chromium's capped `navigator.deviceMemory`). `DeviceCapabilities.ts`
  shows true measured RAM/cores and only labels numbers "estimated" when
  measurement isn't available.
- ✅ **Local LLM, model-agnostic (no lock-in)** — `LocalModelId` is an open
  string, not a fixed catalog. You can load *any* model:
  - Curated Qwen2.5 set (0.5B/1.5B/3B) for one-click start.
  - **"Load any model"** — paste a HuggingFace or Ollama id.
  - **HuggingFace browser** (`HuggingFaceBrowser.tsx`) — save/validate your
    HF token, search the live model hub, one-click Get → downloads with a
    **real progress bar** (`modelHub.ts`).
  - **Ollama browser** (`OllamaBrowser.tsx`) — point at your Ollama endpoint,
    see installed models, search the library, **pull with streamed progress**.
  - Load / **Unload** frees memory (`unload()`).
- ✅ **Autonomous self-learning loop (on-device)** — `src/unimind/learningLoop.ts`.
  Leave GIA running on a task; the local model reflects, accumulates its own
  **trace** (memory of what it tried), and feeds past attempts back in so it
  gets smarter across runs. Bounded by design: max iterations + stall-halt, so
  a shaky local model can't loop forever and burn RAM. The loop core is
  provider-agnostic (it takes a `generate` callback) — `localAdapter.ts` is
  the only piece wired to the local model. UI: "Run loop" in the Local Models
  settings card.

## Unimind (GIA mobile ↔ Cowork desktop fusion)

**Protocol spine — implemented** (`src/unimind/types.ts`):

- `UnimindEnvelope` — every event carries `actor`, `channel`, `device`,
  `deviceId`, `seq`. `channel` is the provenance stamp (e.g. `whatsapp`,
  `telegram`, `desktop-app`, `mobile-app`, `voice`, `face`) so a synced agent
  always knows *which* surface a message came from.
- `ModelRef` — open model reference (no provider lock-in).
- `LoopConfig` / `SAFE_LOOP` — bounded autonomous-loop guardrails
  (max 25 iterations, stall-halt, 60s stall threshold).
- Message types: `chat`, `agent-trigger`, `action-delegation`,
  `verify-request` / `verify-response`, `presence`.

**Not yet built** (designed, spine ready): the P2P transport/sync engine,
device pairing, the shared session store that stamps provenance at the
messaging bridge, cross-device **action delegation** (desktop ↔ phone), and
the **verification handshake** (attest "it's really me at the computer" via
biometrics/voice/face before an agent acts). See `src/unimind/` for the spine
to build on.

## What's intentionally not built yet

- Keyboard/mouse idle-time detection (X11/Wayland don't share one API for
  this; needs its own pass).
- Cross-device approval mesh (SMS/call escalation via Twilio, watch
  notifications) — real feature, real ongoing cost once wired up, needs
  your Twilio keys and an explicit go-ahead.
- Camera-based presence and full-screen OCR — both privacy-sensitive by
  default-on, will ship gated behind an explicit toggle, not silently on.
- Full mouse/keyboard input control ("computer use") — bigger permission
  surface than the above, gets its own design pass before implementation.
- Unimind **transport/sync** — the spine is in `src/unimind/`; the live P2P
  sync, pairing, session store, and action/verification handshakes are not
  implemented.
- **Playwright is not bundled.** Browser automation (`tools/browserAutomation.ts`)
  expects an external Playwright server at `localhost:3091`; it is not a build
  dependency.

> Note: real model downloads and the HF/Ollama browsers need network access at
> runtime. They were built but not exercised end-to-end in a sandbox.

## Development

```bash
npm install
npm run tauri dev      # requires a working Rust toolchain
```

## Building

```bash
npm run tauri build    # produces .deb, .AppImage, .rpm under src-tauri/target/release/bundle
```
