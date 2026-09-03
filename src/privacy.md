# Privacy Policy

GIA Cowork is a local-first desktop application designed for data sovereignty and privacy.

## Data Sovereignty
GIA Cowork does not collect, store, or transmit your personal data to any central server. All application state, chat history, memories, and settings remain on your machine.

## Local Storage
All app data is stored locally on your computer — in the app's data directory and local browser-style storage (IndexedDB) used by the desktop shell. Nothing is uploaded unless you explicitly trigger a feature that requires the network.

## API Keys
Your API keys (e.g., OpenRouter, Anthropic) are stored locally on your machine. They are never sent to us; they are only used to authenticate requests directly to the AI service providers you choose.

## Local Processing
All interface logic, module switching, intent analysis, and on-device AI runs locally on your machine.

## Third-Party AI Services
When you use GIA with a cloud AI provider, your prompts are sent to the third-party provider you have configured. We recommend reviewing the privacy policies of those providers (such as OpenRouter or Anthropic) to understand how they process your data. Local models (Ollama, LM Studio, on-device models) never leave your machine.

## Desktop Permissions
GIA Cowork may run shell commands, read or write files you explicitly open, capture your screen, or control the mouse and keyboard — but only when a feature you invoked requires it (e.g. GIA acting as your co-worker with your approval). Every tool call that touches your system is surfaced for approval unless you enable Hands-Off mode.