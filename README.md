<div align="center">

# ✦ GIA Cowork

**An autonomous AI workspace that runs on your desktop — not in a browser tab.**

`Real shell · Real files · Real screen control · Local-first`

![version](https://img.shields.io/badge/version-0.2.0-8b5cf6?style=for-the-badge)
![Tauri](https://img.shields.io/badge/Tauri%202-6a5acd?style=for-the-badge&logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React%2019-0ea5e9?style=for-the-badge&logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-e07a5f?style=for-the-badge&logo=rust&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![Privacy](https://img.shields.io/badge/local--first%20%7C%20audio%20never%20leaves%20your%20machine-34d399?style=for-the-badge)

Same brain as [GIA](https://github.com/alpha-1-design/gia-app) on Android — except
the phone app runs in a sandbox. Cowork *is* the machine.

[Install](#install) · [First run](#first-run) · [Documentation](#documentation) · [Providers](#providers) · [Development](#development)

</div>

---

## ✦ What it does

| | |
|---|---|
| 🐚 **Real terminal** | `sh -c` on the host (`powershell.exe` on Windows) with sessions, kill, exit codes, timeouts — [how it works](docs/terminal.md) |
| 🖥️ **Screen control** | capture the screen, click, drag, type, scroll — [how it works](docs/screen-control.md) |
| 🧠 **Any model, any provider** | **71 providers** — OpenAI · Anthropic · Gemini · Groq · DeepSeek · Z.AI · Kimi · MiniMax · Qwen · SiliconFlow · SambaNova · Hyperbolic · Chutes · Vercel Gateway · GitHub Copilot · plus Azure / Bedrock / Vertex / Databricks, and local Ollama / LM Studio. Model catalog from [models.dev](https://models.dev). [Provider and model details](docs/providers-models.md) |
| 🔧 **292 registered tools** | files, code execution, web search, email, calendar, notes, tasks, reminders, smart home, messaging — [how tools work](docs/tools.md) |
| 🔁 **Autonomous loop** | leave it on a task; it records what it tried and feeds past attempts back in — bounded, so it can't spin forever — [how it works](docs/autonomous-loop.md) |
| 🎙️ **Local wake word** | openWakeWord runs on-device — no cloud key, no transcription service — [how it works](docs/wake-word.md) |
| 🔔 **Presence-aware** | detects screen lock, pauses background work, resumes when you return — [how it works](docs/presence.md) |
| 📦 **Tray daemon** | close the window, it keeps running — [how it works](docs/tray-daemon.md) |

Each row above links to a detailed page explaining how the feature was built and how it works. The README stays short on purpose.

---

## 🔌 Providers

GIA is bring-your-own-key: pick a provider, paste a key, choose a model. No
provider is preferred and nothing is locked in. Every row below ships in the
app — the in-app picker shows the same description and links straight to where
you get a key.

Account-scoped platforms (Azure, Bedrock, Vertex, Databricks, Snowflake, SAP,
GitLab Duo, Cloudflare) also need their resource URL set in **Settings →
Providers** once you've created the account.

<!-- BEGIN GENERATED PROVIDERS -->

| Provider | Company | Description | Get a key |
|---|---|---|---|
| `openai` | OpenAI | GPT models and the original OpenAI-compatible API. | [Get a key](https://platform.openai.com/api-keys) |
| `anthropic` | Anthropic | Claude models, strong on coding and long context. | [Get a key](https://console.anthropic.com/settings/keys) |
| `gemini` | Google DeepMind | Gemini models with large context and native multimodal input. | [Get a key](https://aistudio.google.com/apikey) |
| `meta` | Meta | Official hosted Llama API for open-weight models. | [Get a key](https://www.llama.com/) |
| `mistral` | Mistral AI | European open-weight and frontier models. | [Get a key](https://console.mistral.ai/api-keys) |
| `cohere` | Cohere | Command models tuned for enterprise RAG and tools. | [Get a key](https://dashboard.cohere.com/api-keys) |
| `openrouter` | OpenRouter | One key for hundreds of models across many vendors. | [Get a key](https://openrouter.ai/keys) |
| `opencode` | OpenCode (SST) | OpenCode Zen — hosted models served by the opencode project. | [Get a key](https://opencode.ai/) |
| `vercel` | Vercel | AI Gateway — unified routing across many model providers. | [Get a key](https://vercel.com/docs/ai-gateway) |
| `requesty` | Requesty | OpenAI-compatible router with usage tracking and failover. | [Get a key](https://requesty.ai/) |
| `kilo` | Kilo | Kilo Gateway — a large routed catalog of open and closed models. | [Get a key](https://kilo.ai/) |
| `302ai` | 302.AI | Pay-as-you-go gateway over many frontier models. | [Get a key](https://www.302.ai/) |
| `aihubmix` | AIHubMix | Aggregated multi-provider endpoint with a single key. | [Get a key](https://aihubmix.com/) |
| `nano-gpt` | NanoGPT | Low-cost gateway with a very large model catalog. | [Get a key](https://nano-gpt.com/) |
| `aimlapi` | AIML API | OpenAI-compatible endpoint covering ~1000 models. | [Get a key](https://aimlapi.com/) |
| `zenmux` | ZenMux | Model router that selects among vendors per request. | [Get a key](https://zenmux.ai/) |
| `orcarouter` | OrcaRouter | Routing layer over many model vendors. | [Get a key](https://orcarouter.com/) |
| `crossmodel` | CrossModel | Single endpoint for open-weight and frontier models. | [Get a key](https://crossmodel.ai/) |
| `inference` | Inference.net | Hosted open-weight model inference. | [Get a key](https://inference.net/) |
| `groq` | Groq | Very fast inference on custom LPU hardware. | [Get a key](https://console.groq.com/keys) |
| `cerebras` | Cerebras | Wafer-scale inference with extremely low latency. | [Get a key](https://cloud.cerebras.ai/) |
| `sambanova` | SambaNova | High-throughput cloud inference for open models. | [Get a key](https://cloud.sambanova.ai/) |
| `deepseek` | DeepSeek | Open-weight reasoning models at very low cost. | [Get a key](https://platform.deepseek.com/api_keys) |
| `fireworks` | Fireworks AI | Fast serving of open-weight models. | [Get a key](https://fireworks.ai/api-keys) |
| `deepinfra` | DeepInfra | Low-cost serverless inference for open models. | [Get a key](https://deepinfra.com/dash/api_keys) |
| `togetherai` | Together AI | Hosted open models plus fine-tuning. | [Get a key](https://api.together.ai/settings/api-keys) |
| `novita-ai` | NovitaAI | Serverless inference for open-weight models. | [Get a key](https://novita.ai/) |
| `hyper` | Hyperbolic | GPU-backed open model inference. | [Get a key](https://hyperbolic.xyz/) |
| `baseten` | Baseten | Hosts and serves custom model deployments. | [Get a key](https://www.baseten.co/) |
| `chutes` | Chutes AI | Community inference platform for open models. | [Get a key](https://chutes.ai/) |
| `modal` | Modal | Serverless GPU compute for running models. | [Get a key](https://modal.com/) |
| `sarvam` | Sarvam AI | Models built for Indian languages. | [Get a key](https://www.sarvam.ai/) |
| `stepfun-ai` | StepFun | Chinese multimodal and text models. | [Get a key](https://platform.stepfun.com/) |
| `vivgrid` | Vivgrid | Open model hosting with an OpenAI-compatible API. | [Get a key](https://vivgrid.com/) |
| `empiriolabs` | EmpirioLabs AI | Hosted open-weight model inference. | [Get a key](https://empiriolabs.ai/) |
| `wandb` | CoreWeave | GPU cloud serving open models. | [Get a key](https://coreweave.com/) |
| `scaleway` | Scaleway | European cloud offering hosted LLM inference. | [Get a key](https://www.scaleway.com/) |
| `berget` | Berget.AI | European hosted open-model inference. | [Get a key](https://berget.ai/) |
| `friendli` | FriendliAI | Optimised serverless inference for open models. | [Get a key](https://friendli.ai/) |
| `arcee` | Arcee AI | Small specialised language models for enterprise. | [Get a key](https://www.arcee.ai/) |
| `morph` | Morph | Low-latency model endpoints for agents. | [Get a key](https://morphllm.com/) |
| `venice` | Venice AI | Privacy-oriented gateway over many models. | [Get a key](https://venice.ai/) |
| `poe` | Quora (Poe) | Access to many models through one subscription. | [Get a key](https://poe.com/) |
| `zai` | Z.AI (Zhipu) | GLM models from Zhipu, exposed on the global endpoint. | [Get a key](https://z.ai/) |
| `zhipuai` | Zhipu AI | GLM models on the mainland-China endpoint. | [Get a key](https://open.bigmodel.cn/) |
| `moonshotai` | Moonshot AI | Kimi long-context models. | [Get a key](https://platform.moonshot.ai/) |
| `minimax` | MiniMax | Text and multimodal models from MiniMax. | [Get a key](https://platform.minimaxi.com/) |
| `alibaba` | Alibaba Cloud | Qwen models via DashScope (international). | [Get a key](https://dashscope.console.aliyun.com/) |
| `alibaba-cn` | Alibaba Cloud | Qwen models on the mainland-China endpoint. | [Get a key](https://dashscope.console.aliyun.com/) |
| `volcengine` | ByteDance | Ark platform — Doubao and open models in China. | [Get a key](https://www.volcengine.com/) |
| `siliconflow` | SiliconFlow | Chinese inference cloud with many open models. | [Get a key](https://cloud.siliconflow.cn/) |
| `xai` | xAI | Grok models. | [Get a key](https://console.x.ai/) |
| `perplexity` | Perplexity | Answer engine models with live web grounding. | [Get a key](https://www.perplexity.ai/settings/api) |
| `nvidia` | NVIDIA | NIM catalogue of hosted open models. | [Get a key](https://build.nvidia.com/) |
| `replicate` | Replicate | Run nearly any published model by the slug. | [Get a key](https://replicate.com/account/api-tokens) |
| `huggingface` | HuggingFace | Inference Endpoints over community models. | [Get a key](https://huggingface.co/settings/tokens) |
| `github-copilot` | GitHub | Models routed through Copilot for subscribers. | [Get a key](https://github.com/features/copilot) |
| `ollama-cloud` | Ollama | Cloud-hosted version of the Ollama model runner. | [Get a key](https://ollama.com/) |
| `ai21` | AI21 Labs | Jamba models with long-context handling. | [Get a key](https://www.ai21.com/) |
| `upstage` | Upstage | Solar models focused on document understanding. | [Get a key](https://www.upstage.ai/) |
| `ollama` | Ollama | Run models locally against a local Ollama server. | Local — no key |
| `lmstudio` | LM Studio | Run models locally against LM Studio. | Local — no key |
| `local-llm` | On-device | In-browser Transformers.js model, no server needed. | Local — no key |
| `azure` | Microsoft Azure | Azure OpenAI — needs your Azure resource URL. | [Get a key](https://portal.azure.com/) |
| `amazon-bedrock` | Amazon Web Services | Bedrock — unified AWS access to many models. | [Get a key](https://aws.amazon.com/bedrock/) |
| `google-vertex` | Google Cloud | Vertex AI — Gemini and partner models on GCP. | [Get a key](https://cloud.google.com/vertex-ai) |
| `databricks` | Databricks | Mosaic AI gateway on your own Databricks workspace. | [Get a key](https://www.databricks.com/) |
| `snowflake-cortex` | Snowflake | Cortex inference inside your Snowflake account. | [Get a key](https://www.snowflake.com/) |
| `sap-ai-core` | SAP | AI Core — models via your SAP BTP landscape. | [Get a key](https://www.sap.com/) |
| `gitlab` | GitLab | GitLab Duo models through your GitLab instance. | [Get a key](https://about.gitlab.com/) |
| `cloudflare-workers-ai` | Cloudflare | Workers AI — models on your Cloudflare account. | [Get a key](https://developers.cloudflare.com/workers-ai/) |

<!-- END GENERATED PROVIDERS -->

> This table is generated from `src/services/providerInfo.ts` — run
> `node scripts/generate-provider-table.mjs` after editing it rather than
> changing the rows by hand.

---

## 📦 Install

Grab the latest from **[Releases](https://github.com/alpha-1-design/gia-cowork/releases)**.

| Platform | Package | Command |
|:---|:---|:---|
| Debian · Ubuntu · Mint | `.deb` | `sudo apt install ./GIA.Cowork_0.2.0_amd64.deb` |
| Fedora · RHEL · openSUSE | `.rpm` | `sudo dnf install ./GIA.Cowork-0.2.0-1.x86_64.rpm` |
| Any Linux | `.AppImage` | `chmod +x GIA.Cowork_0.2.0_amd64.AppImage && ./GIA.Cowork_0.2.0_amd64.AppImage` |
| Windows 10/11 x64 | `.msi` / `-setup.exe` | Run the installer |

> Linux packages build on Ubuntu; Windows installers come from a separate Windows CI workflow.

---

## ▶ First run

1. Open **GIA Cowork** — it starts as a tray daemon
2. **Add a model** — pick a provider, or load a local model by HuggingFace / Ollama id
3. **`Ctrl+K`** opens the command palette (~55 commands, autocompleted as you type `/`)
4. Open the **Terminal** and ask it to run something

---

## 📚 Documentation

The README stays short on purpose. Each feature has its own page explaining how it was built and how it works.

### Core features

- [Terminal](docs/terminal.md)
- [Screen control](docs/screen-control.md)
- [Providers and models](docs/providers-models.md)
- [Tools](docs/tools.md)
- [Autonomous loop](docs/autonomous-loop.md)
- [Wake word](docs/wake-word.md)
- [Presence awareness](docs/presence.md)
- [Tray daemon](docs/tray-daemon.md)

### Optional and device features

- [Jarvis Eyes](docs/jarvis-eyes.md)
- [Unimind relay](docs/unimind-relay.md)
- [WhatsApp bridge](docs/whatsapp-bridge.md)

### Design and policy

- [Architecture](docs/architecture.md)
- [Privacy](docs/privacy.md)

---

## 🎙️ Wake word

Wake word detection uses [openWakeWord](https://github.com/dscripka/openWakeWord) —
a small ONNX keyword model running **locally**, in-process, on both the desktop
app and the browser build.

| | |
|---|---|
| 🔑 **No access key** | Nothing to sign up for |
| 🔒 **Audio never leaves** | No cloud recognition step, ever |
| 📦 **Self-hosted models** | `scripts/copy-wakeword-assets.mjs` stages the ONNX files into `public/openwakeword/models` at dev/build time, served from your own origin — no third-party CDN at runtime |

Tune it under **Settings → Voice**. The 0–1 sensitivity maps *inversely* onto the
model's acceptance threshold — higher means easier to trigger.

> See [Wake word](docs/wake-word.md) for the full detail, including why this replaced the previous implementation.

---

## 👁 Jarvis eyes

A floating orb that watches your desktop — and doubles as a state indicator.

| | | |
|:---:|:---:|:---:|
| 🟢 **Listening** | 🟣 **Thinking** | 🩷 **Acting** |
| wake word heard you | reasoning, ring spins | a desktop-changing tool is running |
| 🔵 **Idle / Seeing** | 🟠 **Speaking** | ⚫ **Off** |
| ambient watch, breathing | talking back | dim, eyes closed |

Toggle it under **Settings → Developer → Jarvis Eyes**, or click the orb.

Every desktop-changing tool flips it to `acting`, then takes a fresh capture
afterwards so the result is **verified rather than assumed**. Ask it directly with
the `jarvis_look` tool. Vision runs on your local models when loaded, otherwise
your chat provider's vision model — only distilled text reaches the brain. It
never watches while your screen is locked.

> See [Jarvis Eyes](docs/jarvis-eyes.md) for the full detail.

---

## 📱 Connect a phone (Unimind)

An embedded relay — no server to install or start.

1. **Desktop** → Settings → Connections → Unimind → copy the URL
   (e.g. `ws://192.168.1.50:8787/unimind`)
2. **Phone** → GIA → Settings → Unimind → paste the same URL + pairing id → Connect

Both devices must share the **same URL and the same pairing id**.

| Variable | Default | Purpose |
|---|---|---|
| `UNIMIND_RELAY_PORT` | `8787` | Relay port |
| `UNIMIND_RELAY_SECRET` | — | Optional shared secret clients must send |

> The relay runs only inside the native app. For the web preview:
> `cd relay && npm install && npm start`

> See [Unimind relay](docs/unimind-relay.md) for the full detail.

---

## 💬 WhatsApp *(optional)*

Run `whatsapp_bridge_start`, then scan the QR from **WhatsApp → Linked Devices**.
GIA answers incoming messages, and calls you if an urgent one goes unread.

> ⚠️ Unofficial client — WhatsApp's ToS apply. Use a secondary number.
> Disable auto-replies with `whatsapp_auto_respond off`.

> See [WhatsApp bridge](docs/whatsapp-bridge.md) for the full detail.

---

## 🏗 Architecture

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

**Generation pipeline**

```
useChatState → useChatGeneration → GiaBrain.generate() → provider adapter → tool loop
```

**Authoring a tool:** `defineTool()` turns one zod schema into both the
model-facing JSON schema *and* runtime validation, so a tool's contract lives in
exactly one place. Export an array from `src/services/tools/*.ts`, register it in
`tools/index.ts`.

> See [Architecture](docs/architecture.md) for the full detail.---

## 🛠 Development

```bash
npm ci --legacy-peer-deps

npm run tauri dev      # native app — requires a Rust toolchain
npm run dev            # web preview at http://localhost:1420

npm test               # vitest
npm run tauri build    # .deb / .AppImage / .rpm
```

> `npm run dev` and `npm run build` stage the wake-word models via a `pre` hook.
> Those binaries are gitignored, not committed.

**CI** runs typecheck, frontend build, and `cargo check` on every push; tag
pushes (`v*.*.*`) build and publish release bundles. CI does **not** currently
run the vitest suite — run `npm test` locally before pushing.

---

## ⚠️ Known limitations

- Some mobile-oriented tools are desktop-stubbed; `capture_photo` targets
  Capacitor (Android) and web, and is not wired into the Tauri shell
- Lock detection relies on **systemd-logind** — X11/Wayland idle detection is not
  implemented
- Wake word ships the `hey_jarvis` openWakeWord head; there is no bespoke "GIA"
  model yet

---

## 🗺 Roadmap

- Richer P2P data sync over the Unimind relay
- Idle-time awareness beyond screen lock
- Full mouse/keyboard autonomy behind an explicit permission surface

---

<div align="center">

**Questions or bugs?** → [Open an issue](https://github.com/alpha-1-design/gia-cowork/issues)

</div>
