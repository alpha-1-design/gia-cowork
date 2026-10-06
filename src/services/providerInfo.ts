/**
 * Who runs each provider, what it is, and where to get a key.
 *
 * Kept beside (not inside) `FALLBACK_PROVIDERS` so the operational fields used
 * at request time stay readable, and so this table can be edited without
 * touching base URLs. One entry per provider id — see `FALLBACK_PROVIDERS` for
 * the authoritative id list.
 *
 * `docsUrl` links are the place a user actually obtains credentials, not a
 * marketing homepage. They were HTTP-checked while writing this file; a handful
 * of providers (OpenAI, Azure, Snowflake, Perplexity, xAI, AI21, Poe) reject
 * scripted requests with 403 but resolve normally in a browser, and Mistral's
 * console was unreachable from the build environment. `local` deliberately has
 * no link — it runs on-device.
 */
export interface ProviderInfo {
  /** The organisation that operates the endpoint. */
  company: string;
  /** One line on what it is, for the picker. */
  description: string;
  /** Where to obtain an API key. Empty only for local providers. */
  docsUrl: string;
}

export const PROVIDER_INFO: Record<string, ProviderInfo> = {
  // ── Foundation labs ───────────────────────────────────────────────
  openai: { company: 'OpenAI', description: 'GPT models and the original OpenAI-compatible API.', docsUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { company: 'Anthropic', description: 'Claude models, strong on coding and long context.', docsUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { company: 'Google DeepMind', description: 'Gemini models with large context and native multimodal input.', docsUrl: 'https://aistudio.google.com/apikey' },
  meta: { company: 'Meta', description: 'Official hosted Llama API for open-weight models.', docsUrl: 'https://www.llama.com/' },
  mistral: { company: 'Mistral AI', description: 'European open-weight and frontier models.', docsUrl: 'https://console.mistral.ai/api-keys' },
  cohere: { company: 'Cohere', description: 'Command models tuned for enterprise RAG and tools.', docsUrl: 'https://dashboard.cohere.com/api-keys' },

  // ── Gateways and aggregators ──────────────────────────────────────
  openrouter: { company: 'OpenRouter', description: 'One key for hundreds of models across many vendors.', docsUrl: 'https://openrouter.ai/keys' },
  opencode: { company: 'OpenCode (SST)', description: 'OpenCode Zen — hosted models served by the opencode project.', docsUrl: 'https://opencode.ai/' },
  vercel: { company: 'Vercel', description: 'AI Gateway — unified routing across many model providers.', docsUrl: 'https://vercel.com/docs/ai-gateway' },
  requesty: { company: 'Requesty', description: 'OpenAI-compatible router with usage tracking and failover.', docsUrl: 'https://requesty.ai/' },
  kilo: { company: 'Kilo', description: 'Kilo Gateway — a large routed catalog of open and closed models.', docsUrl: 'https://kilo.ai/' },
  '302ai': { company: '302.AI', description: 'Pay-as-you-go gateway over many frontier models.', docsUrl: 'https://www.302.ai/' },
  aihubmix: { company: 'AIHubMix', description: 'Aggregated multi-provider endpoint with a single key.', docsUrl: 'https://aihubmix.com/' },
  'nano-gpt': { company: 'NanoGPT', description: 'Low-cost gateway with a very large model catalog.', docsUrl: 'https://nano-gpt.com/' },
  aimlapi: { company: 'AIML API', description: 'OpenAI-compatible endpoint covering ~1000 models.', docsUrl: 'https://aimlapi.com/' },
  zenmux: { company: 'ZenMux', description: 'Model router that selects among vendors per request.', docsUrl: 'https://zenmux.ai/' },
  orcarouter: { company: 'OrcaRouter', description: 'Routing layer over many model vendors.', docsUrl: 'https://orcarouter.com/' },
  crossmodel: { company: 'CrossModel', description: 'Single endpoint for open-weight and frontier models.', docsUrl: 'https://crossmodel.ai/' },
  inference: { company: 'Inference.net', description: 'Hosted open-weight model inference.', docsUrl: 'https://inference.net/' },

  // ── Inference clouds ──────────────────────────────────────────────
  groq: { company: 'Groq', description: 'Very fast inference on custom LPU hardware.', docsUrl: 'https://console.groq.com/keys' },
  cerebras: { company: 'Cerebras', description: 'Wafer-scale inference with extremely low latency.', docsUrl: 'https://cloud.cerebras.ai/' },
  sambanova: { company: 'SambaNova', description: 'High-throughput cloud inference for open models.', docsUrl: 'https://cloud.sambanova.ai/' },
  deepseek: { company: 'DeepSeek', description: 'Open-weight reasoning models at very low cost.', docsUrl: 'https://platform.deepseek.com/api_keys' },
  fireworks: { company: 'Fireworks AI', description: 'Fast serving of open-weight models.', docsUrl: 'https://fireworks.ai/api-keys' },
  deepinfra: { company: 'DeepInfra', description: 'Low-cost serverless inference for open models.', docsUrl: 'https://deepinfra.com/dash/api_keys' },
  togetherai: { company: 'Together AI', description: 'Hosted open models plus fine-tuning.', docsUrl: 'https://api.together.ai/settings/api-keys' },
  'novita-ai': { company: 'NovitaAI', description: 'Serverless inference for open-weight models.', docsUrl: 'https://novita.ai/' },
  hyper: { company: 'Hyperbolic', description: 'GPU-backed open model inference.', docsUrl: 'https://hyperbolic.xyz/' },
  baseten: { company: 'Baseten', description: 'Hosts and serves custom model deployments.', docsUrl: 'https://www.baseten.co/' },
  chutes: { company: 'Chutes AI', description: 'Community inference platform for open models.', docsUrl: 'https://chutes.ai/' },
  modal: { company: 'Modal', description: 'Serverless GPU compute for running models.', docsUrl: 'https://modal.com/' },
  sarvam: { company: 'Sarvam AI', description: 'Models built for Indian languages.', docsUrl: 'https://www.sarvam.ai/' },
  'stepfun-ai': { company: 'StepFun', description: 'Chinese multimodal and text models.', docsUrl: 'https://platform.stepfun.com/' },
  vivgrid: { company: 'Vivgrid', description: 'Open model hosting with an OpenAI-compatible API.', docsUrl: 'https://vivgrid.com/' },
  empiriolabs: { company: 'EmpirioLabs AI', description: 'Hosted open-weight model inference.', docsUrl: 'https://empiriolabs.ai/' },
  wandb: { company: 'CoreWeave', description: 'GPU cloud serving open models.', docsUrl: 'https://coreweave.com/' },
  scaleway: { company: 'Scaleway', description: 'European cloud offering hosted LLM inference.', docsUrl: 'https://www.scaleway.com/' },
  berget: { company: 'Berget.AI', description: 'European hosted open-model inference.', docsUrl: 'https://berget.ai/' },
  friendli: { company: 'FriendliAI', description: 'Optimised serverless inference for open models.', docsUrl: 'https://friendli.ai/' },
  arcee: { company: 'Arcee AI', description: 'Small specialised language models for enterprise.', docsUrl: 'https://www.arcee.ai/' },
  morph: { company: 'Morph', description: 'Low-latency model endpoints for agents.', docsUrl: 'https://morphllm.com/' },
  venice: { company: 'Venice AI', description: 'Privacy-oriented gateway over many models.', docsUrl: 'https://venice.ai/' },
  poe: { company: 'Quora (Poe)', description: 'Access to many models through one subscription.', docsUrl: 'https://poe.com/' },

  // ── China-mainland endpoints ──────────────────────────────────────
  zai: { company: 'Z.AI (Zhipu)', description: 'GLM models from Zhipu, exposed on the global endpoint.', docsUrl: 'https://z.ai/' },
  zhipuai: { company: 'Zhipu AI', description: 'GLM models on the mainland-China endpoint.', docsUrl: 'https://open.bigmodel.cn/' },
  moonshotai: { company: 'Moonshot AI', description: 'Kimi long-context models.', docsUrl: 'https://platform.moonshot.ai/' },
  minimax: { company: 'MiniMax', description: 'Text and multimodal models from MiniMax.', docsUrl: 'https://platform.minimaxi.com/' },
  alibaba: { company: 'Alibaba Cloud', description: 'Qwen models via DashScope (international).', docsUrl: 'https://dashscope.console.aliyun.com/' },
  'alibaba-cn': { company: 'Alibaba Cloud', description: 'Qwen models on the mainland-China endpoint.', docsUrl: 'https://dashscope.console.aliyun.com/' },
  volcengine: { company: 'ByteDance', description: 'Ark platform — Doubao and open models in China.', docsUrl: 'https://www.volcengine.com/' },
  siliconflow: { company: 'SiliconFlow', description: 'Chinese inference cloud with many open models.', docsUrl: 'https://cloud.siliconflow.cn/' },

  // ── Specialist / other ────────────────────────────────────────────
  xai: { company: 'xAI', description: 'Grok models.', docsUrl: 'https://console.x.ai/' },
  perplexity: { company: 'Perplexity', description: 'Answer engine models with live web grounding.', docsUrl: 'https://www.perplexity.ai/settings/api' },
  nvidia: { company: 'NVIDIA', description: 'NIM catalogue of hosted open models.', docsUrl: 'https://build.nvidia.com/' },
  replicate: { company: 'Replicate', description: 'Run nearly any published model by the slug.', docsUrl: 'https://replicate.com/account/api-tokens' },
  huggingface: { company: 'HuggingFace', description: 'Inference Endpoints over community models.', docsUrl: 'https://huggingface.co/settings/tokens' },
  'github-copilot': { company: 'GitHub', description: 'Models routed through Copilot for subscribers.', docsUrl: 'https://github.com/features/copilot' },
  'ollama-cloud': { company: 'Ollama', description: 'Cloud-hosted version of the Ollama model runner.', docsUrl: 'https://ollama.com/' },
  ai21: { company: 'AI21 Labs', description: 'Jamba models with long-context handling.', docsUrl: 'https://www.ai21.com/' },
  upstage: { company: 'Upstage', description: 'Solar models focused on document understanding.', docsUrl: 'https://www.upstage.ai/' },

  // ── Local / on-device (no key, no link) ───────────────────────────
  ollama: { company: 'Ollama', description: 'Run models locally against a local Ollama server.', docsUrl: '' },
  lmstudio: { company: 'LM Studio', description: 'Run models locally against LM Studio.', docsUrl: '' },
  'local-llm': { company: 'On-device', description: 'In-browser Transformers.js model, no server needed.', docsUrl: '' },

  // ── Account-scoped platforms (set your own resource URL) ──────────
  azure: { company: 'Microsoft Azure', description: 'Azure OpenAI — needs your Azure resource URL.', docsUrl: 'https://portal.azure.com/' },
  'amazon-bedrock': { company: 'Amazon Web Services', description: 'Bedrock — unified AWS access to many models.', docsUrl: 'https://aws.amazon.com/bedrock/' },
  'google-vertex': { company: 'Google Cloud', description: 'Vertex AI — Gemini and partner models on GCP.', docsUrl: 'https://cloud.google.com/vertex-ai' },
  databricks: { company: 'Databricks', description: 'Mosaic AI gateway on your own Databricks workspace.', docsUrl: 'https://www.databricks.com/' },
  'snowflake-cortex': { company: 'Snowflake', description: 'Cortex inference inside your Snowflake account.', docsUrl: 'https://www.snowflake.com/' },
  'sap-ai-core': { company: 'SAP', description: 'AI Core — models via your SAP BTP landscape.', docsUrl: 'https://www.sap.com/' },
  gitlab: { company: 'GitLab', description: 'GitLab Duo models through your GitLab instance.', docsUrl: 'https://about.gitlab.com/' },
  'cloudflare-workers-ai': { company: 'Cloudflare', description: 'Workers AI — models on your Cloudflare account.', docsUrl: 'https://developers.cloudflare.com/workers-ai/' },
};

/** Metadata for a provider id, or undefined if the id is unknown. */
export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDER_INFO[id];
}

/** Company name, falling back to the id so a row is never blank. */
export function companyFor(id: string): string {
  return PROVIDER_INFO[id]?.company ?? id;
}

/** One-line description, or a neutral fallback for unmapped ids. */
export function descriptionFor(id: string): string {
  return PROVIDER_INFO[id]?.description ?? '';
}

/** Direct link to obtain a key; empty string when there is nothing to sign up for. */
export function docsUrlFor(id: string): string {
  return PROVIDER_INFO[id]?.docsUrl ?? '';
}