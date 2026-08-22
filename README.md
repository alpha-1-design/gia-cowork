# GIA Cowork

GIA Cowork is the Linux desktop counterpart to [GIA](https://github.com/alpha-1-design/gia-app) — same brain,
bigger canvas. Where GIA on Android runs in a proot/Alpine sandbox because
phones don't give you a real shell, Cowork runs directly against your real
Linux system: real terminal, real filesystem, real background daemon.

Built with [Tauri](https://tauri.app) (Rust backend, React/TypeScript frontend —
the same frontend codebase as GIA mobile, reused directly).

## Status

This is an early scaffold. What's real and verified as of this commit:

- ✅ Frontend (chat, brain, MCP client, terminal UI, settings) — ports
  directly from GIA mobile with no changes; TypeScript compiles clean,
  production `vite build` succeeds.
- ✅ Real terminal backend (`src-tauri/src/terminal.rs`) — spawns `sh -c`
  directly on the host, no sandbox. Session tracking, kill, exit codes,
  timeouts.
- ✅ System tray + background daemon (close-to-tray instead of quitting).
- ✅ Screen lock-state presence detection via systemd-logind DBus.
- ⚠️ **Not yet verified to compile.** This was built in a sandboxed
  environment capped at Rust 1.75 (Tauri's dependency tree needs
  edition2024, stabilized in Rust 1.85+) with no route to a newer
  toolchain. Run `cargo build` on a real machine with a current Rust
  toolchain (`rustup update`) before trusting any of the Rust code below
  the frontend.

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
- **Unimind** (GIA mobile ↔ Cowork desktop context sync) — designed, not
  yet implemented.

## Development

```bash
npm install
npm run tauri dev      # requires a working Rust toolchain
```

## Building

```bash
npm run tauri build    # produces .deb, .AppImage, .rpm under src-tauri/target/release/bundle
```
