# Privacy Policy

GIA Cowork is a local-first desktop application designed for data sovereignty and privacy.

## Data Sovereignty
GIA Cowork does not collect, store, or transmit your personal data to any central server. All application state, chat history, memories, and settings remain on your machine.

## Local Storage
All app data is stored locally on your computer — in the app's data directory and local browser-style storage (IndexedDB) used by the desktop shell. Nothing is uploaded unless you explicitly trigger a feature that requires the network. Provider API keys are currently part of this local provider state; OS credential-manager integration remains a release-hardening task.

## API Keys
Your API keys (e.g., OpenRouter, Anthropic) are stored locally on your machine. They are never sent to us; they are only used to authenticate requests directly to the AI service providers you choose.

## Local Processing
All interface logic, module switching, intent analysis, and on-device AI runs locally on your machine.

## Third-Party AI Services
When you use GIA with a cloud AI provider, your prompts are sent to the third-party provider you have configured. We recommend reviewing the privacy policies of those providers (such as OpenRouter or Anthropic) to understand how they process your data. Local models (Ollama, LM Studio, on-device models) never leave your machine.

## Desktop Permissions
GIA Cowork may run shell commands, read or write host files, capture your screen, or control the mouse and keyboard. The desktop terminal runs on the host Linux system rather than inside a sandbox, and filesystem tools can access user-owned paths. Use a dedicated workspace when working with untrusted content. Hands-Off mode changes the confirmation model; native capability enforcement remains release hardening work, so the webview should not be treated as the only security boundary.

## Relay and Pairing
The embedded Unimind relay is localhost-only by default. LAN exposure requires explicitly enabling LAN mode and providing a shared secret of at least 32 characters. LAN traffic is not a substitute for encrypted transport; do not expose the relay to untrusted networks. Relay messages are routed in memory and are not intentionally persisted.

## Plugins
Remote plugin installation accepts declarative manifests only. Executable JavaScript hooks are not loaded from URLs because downloaded code would otherwise run inside the desktop webview and reach native integrations.

## Screen Awareness (Jarvis Eyes) — Optional
The floating "Jarvis eyes" orb is **off by default** and only starts working when you explicitly enable it (Settings → Developer → Jarvis Eyes, or tap the orb). While enabled it captures the screen at a slow ambient cadence and analyzes each capture using the vision pipeline. When your local on-device vision models are loaded, analysis happens **entirely locally** — screenshots are used transiently and are never uploaded, stored, or sent to any provider. If the local models are not loaded, GIA falls back to the vision capability of the AI provider you have active in chat (e.g. GPT-4o, Gemini, Claude), meaning the screen capture is sent to that provider in the same way your chat messages are. Only a short distilled text description enters the brain's context. Screen-watching automatically pauses while your screen is locked.