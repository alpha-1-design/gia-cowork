# GIA Cowork — Documentation

This is the feature reference for **GIA Cowork**, the autonomous AI workspace that runs on your desktop — real shell, real files, real screen control, local-first.

The README at the repository root is now a navigation hub. The detailed "how it's built and how it works" write-ups live here.

## How to use this

Start from the top-level README:

- [README.md](../README.md) — overview, install, first run, providers, development

Then read the deep-dives for the features you care about:

- [Terminal](terminal.md) — real host shell access: sessions, kill, exit codes, timeouts
- [Screen Control](screen-control.md) — capture, click, drag, type, scroll on the desktop
- [Providers and Models](providers-models.md) — 71 providers, bring-your-own-key, local models, model catalog sourcing
- [Tools](tools.md) — 292 registered tools, `defineTool()` contract, tool execution surface
- [Autonomous Loop](autonomous-loop.md) — bounded self-directed task execution with reflection
- [Wake Word](wake-word.md) — on-device openWakeWord, no cloud key, no transcription service
- [Presence Awareness](presence.md) — screen lock detection, pause/resume background work
- [Tray Daemon](tray-daemon.md) — close the window, keep running
- [Jarvis Eyes](jarvis-eyes.md) — optional floating orb: desktop watch, state indicator, local vision
- [Unimind Relay](unimind-relay.md) — embedded cross-device relay for phone/desktop sync
- [WhatsApp Bridge](whatsapp-bridge.md) — optional two-way WhatsApp via unofficial Baileys sidecar
- [Architecture](architecture.md) — Rust backend, React frontend, generation pipeline, tool authoring
- [Privacy](privacy.md) — data sovereignty, local storage, relay and pairing, screen awareness

## Conventions

- Each doc is a standalone markdown file. If a detail is discussed in two places, pick one and point at it — this repo has already hit the "same fact written twice and quietly drifting apart" bug more than once.
- Provider counts, tool counts, and module lists in docs should match the in-app picker and the README. If the app changes, update the doc.
- Architecture decisions with a "why we replaced the previous implementation" note belong in the relevant feature doc, not only in a PR.

## Contributing

If you're adding a feature, add its doc here too. A feature without a doc is a feature the next person has to re-derive from grep.
