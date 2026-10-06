# Providers and Models

GIA is bring-your-own-key. Pick a provider, paste a key, choose a model. No provider is preferred and nothing is locked in.

## What it does

- Support a large set of model providers
- Let the user bring their own API key for each provider
- Let the user choose a specific model within a provider
- Support local models that never leave the machine
- Pull the structured provider list from a single source of truth in code

## Providers

The app supports many providers. The in-app provider picker shows them with the same descriptions and key links as the README, because both come from the same source rather than being written twice.

Cloud providers include OpenAI, Anthropic, Gemini, Groq, DeepSeek, Z.AI, Kimi, MiniMax, Qwen, SiliconFlow, SambaNova, Hyperbolic, Chutes, Vercel Gateway, GitHub Copilot, and others.

Account-scoped platforms such as Azure, Bedrock, Vertex, Databricks, Snowflake, SAP, GitLab Duo, and Cloudflare also need their resource URL set in **Settings → Providers** once the account is created.

Local providers include Ollama, LM Studio, and an on-device browser model. Those do not require a cloud key.

## How the provider list stays accurate

The provider table in the README and the provider list in the app are generated from `src/services/providerInfo.ts`. If you change the provider list, you regenerate the README table with:

```bash
node scripts/generate-provider-table.mjs
```

That keeps the README and the app from drifting apart.

## Model catalog

The app uses the model catalog from [models.dev](https://models.dev), the same source some other coding tools use. That gives the app a provider-agnostic view of what models exist, independent of whichever provider the user is currently plugged into.

## How a generation uses a provider

When the app generates a response, it goes through a provider adapter. The adapter knows how to talk to that provider's API shape. The generation pipeline asks the adapter for a completion, and the adapter figures out the provider-specific details.

That means the rest of the app does not need a separate code path for every provider. It needs a provider abstraction, and each provider implements that abstraction.

## Local models

Local models are important to the product because the product is local-first. Ollama and LM Studio run models on the machine. The in-browser model runs in the browser without a server. In those cases, prompts never leave the machine for inference.

## Why this matters

A model-agnostic agent is more useful than one locked to one vendor. Users have different providers, different keys, different cost targets, and different privacy requirements. Supporting many providers and local models lets the same app work for a user running a cloud key, a user running local models, and a user doing both.

## Notes and limitations

- API keys are currently part of local provider state. OS credential-manager integration is a release-hardening task.
- Some providers are account-scoped and need a resource URL in addition to a key.
- The provider list is long and maintained through code, not hand-edited in the README.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Tools](tools.md)
- [Privacy](privacy.md)
