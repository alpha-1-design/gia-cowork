# Architecture

This is the high-level shape of GIA Cowork: the Rust backend, the React frontend, the generation pipeline, and how tools are authored.

## Shape of the project

```
src-tauri/              Rust backend (Tauri 2)
  terminal.rs           sh -c / powershell execution, sessions, kill, timeouts
  screen.rs             screen capture + input control
  presence.rs           lock-state via systemd-logind DBus
  desktop_fs.rs         desktop filesystem access
  whatsapp_bridge.rs    supervises the WhatsApp sidecar (Baileys)
  unimind_relay.rs      embedded relay, auto-started on boot
  lib.rs                tray, background daemon, hardware report

src/
  modules/              10 modules — Chat, Analyst, Exam, Planner, Writer,
                        Agents, Autonomy, Dashboard, Build, Settings
  services/             the brain: GiaBrain, ToolRegistry, MCP,
                        ProviderRegistry — 130+ service modules
  services/tools/       292 tools across ~70 files, wired up in tools/index.ts
  services/wakeWord/    openWakeWord engine + shared plugin
  services/SlashCommands.ts   ~55 slash commands, one registry
  unimind/              provider-agnostic learning loop
  store/                Zustand stores (useGiaStore is the core)
  components/           chat, settings, overlays, command palette
```

## Generation pipeline

```
useChatState → useChatGeneration → GiaBrain.generate() → provider adapter → tool loop
```

The frontend hooks own the chat state and generation lifecycle. They call into the brain, which asks a provider adapter for a completion, and the provider adapter figures out the provider-specific shape. If the generation needs to call tools, the tool loop runs and feeds results back in.

## Tool authoring

Authoring a tool uses `defineTool()`. That turns one Zod schema into both the model-facing JSON schema and the runtime validation. The contract therefore lives in exactly one place.

To add a tool:

1. Define it in a file under `src/services/tools/`
2. Export an array of tools from that file
3. Register it in `src/services/tools/index.ts`

That keeps tool definitions local to their file and the wiring centralized.

## Provider abstraction

Providers are not handled by a separate code path each. There is a provider abstraction. Each provider implements that abstraction, and the generation pipeline uses the abstraction rather than the individual provider details.

That is what lets the app support many providers without turning the generation path into a switch statement over every provider.

## Platform detection

The app reuses the gia-app mobile/Android codebase, so a lot of code was written against Capacitor + native Android. `src/platform.ts` is the single source of truth for "what environment are we actually in". It distinguishes Tauri, Capacitor native, and plain web so desktop features can branch to a real implementation instead of silently calling Android-only plugins that do not exist here.

## Why this shape matters

The app is a desktop application with a real Rust backend and a React frontend. The backend owns the things that need to be real: shell, screen, filesystem, presence, relay, and sidecar supervision. The frontend owns the UI and the chat/generation flow. Tools are the boundary between the two: defined once, validated at runtime, and executed where the capability actually lives.

## Related

- [README.md](../README.md)
- [Terminal](terminal.md)
- [Screen Control](screen-control.md)
- [Tools](tools.md)
- [Providers and Models](providers-models.md)
- [Wake Word](wake-word.md)
