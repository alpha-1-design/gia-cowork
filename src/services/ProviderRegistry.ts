import { logger } from '../utils/logger';
import { fetchModelsDev, mergeProviderModels } from './modelsDevCatalog';

export interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  needsApiKey: boolean;
  listingType: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'huggingface' | 'local' | 'none';
  imageModel?: string;
  headers?: Record<string, string>;
  aliases?: string[];
}

interface StaticModelOption {
  id: string;
  label: string;
  free: boolean;
  context?: string;
  tools?: boolean;
  vision?: boolean;
}

// Exported for tests: this is the offline list the registry seeds before any
// remote enrichment, so parity assertions don't need a network call.
export const FALLBACK_PROVIDERS: ProviderDef[] = [
  // Primary / cloud providers
  { id: 'openai',       label: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',                 defaultModel: 'gpt-4o-mini',      needsApiKey: true,  listingType: 'openai',     aliases: ['oai'] },
  { id: 'anthropic',    label: 'Anthropic',     baseUrl: 'https://api.anthropic.com/v1',               defaultModel: 'claude-sonnet-4-6', needsApiKey: true,  listingType: 'anthropic', aliases: ['ant', 'claude'] },
  { id: 'gemini',       label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com',  defaultModel: 'gemini-2.5-flash', needsApiKey: true,  listingType: 'gemini',    aliases: ['gmi', 'google'] },
  { id: 'opencode',     label: 'OpenCode Zen',  baseUrl: 'https://opencode.ai/zen/v1',                 defaultModel: 'deepseek-v4-flash-free',    needsApiKey: true,  listingType: 'openai',     aliases: ['oc', 'zen'] },
  { id: 'openrouter',   label: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1',               defaultModel: 'google/gemma-3-27b-it:free', needsApiKey: true, listingType: 'openai', aliases: ['or'] },
  { id: 'groq',         label: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1',            defaultModel: 'llama3-70b-8192',  needsApiKey: true,  listingType: 'openai',     aliases: [] },
  { id: 'deepseek',     label: 'DeepSeek',      baseUrl: 'https://api.deepseek.com/v1',                defaultModel: 'deepseek-chat',    needsApiKey: true,  listingType: 'openai',     aliases: ['ds'] },
  { id: 'cerebras',     label: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1',                defaultModel: 'llama3.1-8b',      needsApiKey: true,  listingType: 'openai',     aliases: [] },
  { id: 'mistral',      label: 'Mistral AI',    baseUrl: 'https://api.mistral.ai/v1',                  defaultModel: 'mistral-small-latest', needsApiKey: true, listingType: 'openai',   aliases: [] },
  { id: 'xai',          label: 'xAI (Grok)',    baseUrl: 'https://api.x.ai/v1',                        defaultModel: 'grok-4.5',         needsApiKey: true,  listingType: 'openai',     aliases: ['grok'] },
  { id: 'togetherai',   label: 'Together AI',   baseUrl: 'https://api.together.xyz/v1',                defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', needsApiKey: true, listingType: 'openai', aliases: ['together'] },
  { id: 'huggingface',  label: 'HuggingFace',   baseUrl: 'https://api-inference.huggingface.co/v1',   defaultModel: 'Qwen/Qwen2.5-72B-Instruct', needsApiKey: true, listingType: 'huggingface', aliases: ['hf'] },
  { id: 'perplexity',   label: 'Perplexity',    baseUrl: 'https://api.perplexity.ai',                  defaultModel: 'sonar-pro',        needsApiKey: true,  listingType: 'openai',     aliases: ['pplx'] },
  { id: 'cohere',       label: 'Cohere',        baseUrl: 'https://api.cohere.ai/v1',                   defaultModel: 'command-r-plus',   needsApiKey: true,  listingType: 'openai',     aliases: [] },
  { id: 'fireworks',    label: 'Fireworks AI',  baseUrl: 'https://api.fireworks.ai/inference/v1',      defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'deepinfra',    label: 'DeepInfra',     baseUrl: 'https://api.deepinfra.com/v1/openai',        defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'ai21',         label: 'AI21 Labs',     baseUrl: 'https://api.ai21.com/studio/v1',             defaultModel: 'jamba-1.5-mini',   needsApiKey: true,  listingType: 'openai',     aliases: [] },
  { id: 'replicate',    label: 'Replicate',     baseUrl: 'https://api.replicate.com/v1',               defaultModel: 'meta/meta-llama-3-70b-instruct', needsApiKey: true, listingType: 'openai', aliases: ['rep'] },
  { id: 'nvidia',       label: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1',          defaultModel: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', needsApiKey: true, listingType: 'openai', aliases: ['niv'] },
  // Providers added for opencode parity. Every base URL below was probed and
  // returned 401 (live, auth-gated) — never guessed. Default models are real ids
  // taken from models.dev, not invented.
  { id: 'zai',          label: 'Z.AI',            baseUrl: 'https://api.z.ai/api/paas/v4',                     defaultModel: 'glm-4.6',    needsApiKey: true, listingType: 'openai', aliases: ['glm'] },
  { id: 'zhipuai',      label: 'Zhipu AI',        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',             defaultModel: 'glm-5',      needsApiKey: true, listingType: 'openai', aliases: ['zhipu'] },
  { id: 'moonshotai',   label: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.ai/v1',                       defaultModel: 'kimi-k3',    needsApiKey: true, listingType: 'openai', aliases: ['kimi', 'moonshot'] },
  { id: 'minimax',      label: 'MiniMax',         baseUrl: 'https://api.minimax.chat/v1',                      defaultModel: 'MiniMax-M2.5', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'alibaba',      label: 'Alibaba Qwen',    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-flash', needsApiKey: true, listingType: 'openai', aliases: ['qwen', 'dashscope'] },
  { id: 'siliconflow',  label: 'SiliconFlow',     baseUrl: 'https://api.siliconflow.cn/v1',                    defaultModel: 'google/gemma-4-31B-it', needsApiKey: true, listingType: 'openai', aliases: ['sf'] },
  { id: 'vercel',        label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1',            defaultModel: 'zai/glm-4.5',    needsApiKey: true, listingType: 'openai', aliases: ['vc'] },
  { id: 'nano-gpt',      label: 'NanoGPT',           baseUrl: 'https://nano-gpt.com/api/v1',                 defaultModel: 'gemini-2.5-flash', needsApiKey: true, listingType: 'openai', aliases: ['nanogpt'] },
  { id: 'aihubmix',      label: 'AIHubMix',          baseUrl: 'https://api.aihubmix.com/v1',                 defaultModel: 'glm-4.6',       needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'requesty',      label: 'Requesty',          baseUrl: 'https://router.requesty.ai/v1',               defaultModel: 'ring-2.6-1t',   needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'novita-ai',     label: 'NovitaAI',           baseUrl: 'https://api.novita.ai/v3/openai',            defaultModel: 'deepseek/deepseek-v3.1', needsApiKey: true, listingType: 'openai', aliases: ['novita'] },
  { id: 'baseten',       label: 'Baseten',           baseUrl: 'https://api.baseten.co/v1',                   defaultModel: 'thinkingmachines/inkling-small', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'venice',        label: 'Venice AI',         baseUrl: 'https://api.venice.ai/api/v1',                defaultModel: 'qwen-3-8-2-4t-a95b', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'github-copilot',label: 'GitHub Copilot',    baseUrl: 'https://api.githubcopilot.com',               defaultModel: 'gpt-5.4',       needsApiKey: true, listingType: 'openai', aliases: ['copilot'] },
  { id: 'hyper',         label: 'Hyperbolic',        baseUrl: 'https://api.hyperbolic.xyz/v1',               defaultModel: 'qwen3.7-max',   needsApiKey: true, listingType: 'openai', aliases: ['hyperbolic'] },
  { id: 'ollama-cloud',  label: 'Ollama Cloud',      baseUrl: 'https://ollama.com/v1',                       defaultModel: 'glm-5.3-flash', needsApiKey: true, listingType: 'openai', aliases: ['ollamacloud'] },
  { id: 'crossmodel',    label: 'CrossModel',        baseUrl: 'https://api.crossmodel.ai/v1',                defaultModel: 'anthropic/claude-haiku-4-5', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'empiriolabs',   label: 'EmpirioLabs AI',    baseUrl: 'https://api.empiriolabs.ai/v1',               defaultModel: 'qwen3-8-max-0902', needsApiKey: true, listingType: 'openai', aliases: ['empirio'] },
  { id: '302ai',         label: '302.AI',            baseUrl: 'https://api.302ai.cn/v1',                     defaultModel: 'grok-4-1-fast-reasoning', needsApiKey: true, listingType: 'openai', aliases: ['302'] },
  { id: 'kilo',          label: 'Kilo Gateway',      baseUrl: 'https://api.kilo.ai/api/v1',                  defaultModel: 'openai/gpt-4o-mini', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'morph',         label: 'Morph',             baseUrl: 'https://api.morphllm.com/v1',                 defaultModel: 'morph-v3-large', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'poe',           label: 'Poe',               baseUrl: 'https://api.poe.com/v1',                      defaultModel: 'cerebras/qwen3-32b-cs', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'inference',     label: 'Inference.net',     baseUrl: 'https://api.inference.net/v1',                defaultModel: 'meta/llama-3.1-8b-instruct', needsApiKey: true, listingType: 'openai', aliases: ['inference-net'] },
  { id: 'vivgrid',       label: 'Vivgrid',           baseUrl: 'https://api.vivgrid.com/v1',                   defaultModel: 'viv-fast',      needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'stepfun-ai',    label: 'StepFun',           baseUrl: 'https://api.stepfun.com/v1',                   defaultModel: 'step-5-preview', needsApiKey: true, listingType: 'openai', aliases: ['stepfun'] },
  { id: 'upstage',       label: 'Upstage',           baseUrl: 'https://api.upstage.ai/v1',                    defaultModel: 'solar-pro4',    needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'modal',         label: 'Modal',             baseUrl: 'https://api.modal.com/v1',                     defaultModel: 'thinkingmachines/Inkling-NVFP4', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'arcee',         label: 'Arcee AI',          baseUrl: 'https://api.arcee.ai/v1',                      defaultModel: 'trinity-large-thinking', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'alibaba-cn',    label: 'Alibaba (China)',   baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-flash', needsApiKey: true, listingType: 'openai', aliases: ['aliyun-cn'] },
  { id: 'chutes',        label: 'Chutes AI',         baseUrl: 'https://api.chutes.ai/v1',                     defaultModel: 'google/gemma-4-31B-turbo-TEE', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'meta',          label: 'Meta Llama',        baseUrl: 'https://api.llama.com/v1',                     defaultModel: 'muse-spark-1.3', needsApiKey: true, listingType: 'openai', aliases: ['llama'] },
  { id: 'volcengine',    label: 'Volcengine (Ark)',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',     defaultModel: 'glm-5-3-flash-260828', needsApiKey: true, listingType: 'openai', aliases: ['volc', 'ark'] },
  { id: 'zenmux',        label: 'ZenMux',            baseUrl: 'https://zenmux.ai/api/v1',                     defaultModel: 'anthropic/claude-opus-4.1', needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'scaleway',      label: 'Scaleway',          baseUrl: 'https://api.scaleway.com/v1',                  defaultModel: 'qwen3.8-27b',   needsApiKey: true, listingType: 'openai', aliases: ['scw'] },
  { id: 'wandb',         label: 'CoreWeave',         baseUrl: 'https://inference.coreweave.com/v1',           defaultModel: 'JetBrains/Mellum2-12B-A2.5B-Instruct', needsApiKey: true, listingType: 'openai', aliases: ['coreweave'] },
  { id: 'sarvam',        label: 'Sarvam AI',         baseUrl: 'https://api.sarvam.ai/v1',                     defaultModel: 'sarvam-30b',    needsApiKey: true, listingType: 'openai', aliases: [] },
  { id: 'friendli',      label: 'Friendli AI',       baseUrl: 'https://api.friendli.ai/serverless/v1',        defaultModel: 'google/gemma-4-31B-it', needsApiKey: true, listingType: 'openai', aliases: ['friendliai'] },
  { id: 'berget',        label: 'Berget.AI',         baseUrl: 'https://api.berget.ai/v1',                     defaultModel: 'google/gemma-4-31B-it', needsApiKey: true, listingType: 'openai', aliases: ['berget-ai'] },
  { id: 'orcarouter',    label: 'OrcaRouter',        baseUrl: 'https://api.orcarouter.ai/v1',                 defaultModel: 'grok/grok-4.3',  needsApiKey: true, listingType: 'openai', aliases: ['orca'] },
  // Not published on models.dev, but both expose a real model catalogue
  // unauthenticated — the lists below were read from their own /models
  // endpoints rather than guessed.
  { id: 'sambanova',     label: 'SambaNova',        baseUrl: 'https://api.sambanova.ai/v1',             defaultModel: 'DeepSeek-V3.1', needsApiKey: true, listingType: 'openai', aliases: ['snova'] },
  { id: 'aimlapi',       label: 'AIML API',         baseUrl: 'https://api.aimlapi.com/v1',              defaultModel: 'openai/gpt-4o-mini', needsApiKey: true, listingType: 'openai', aliases: ['aiml'] },
  // Providers that need a user-supplied resource URL (account-scoped),
  // matched with opencode's enterprise set. models.dev supplies their model
  // catalogs; the base URLs below are documented patterns with a placeholder
  // because they cannot be probed without the customer's own account. Settings
  // lets you override baseUrl per provider (`setBaseUrl`), which is exactly how
  // these get pointed at a real resource.
  { id: 'azure',               label: 'Azure OpenAI',            baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',   defaultModel: 'gpt-4o-mini',                            needsApiKey: true, listingType: 'openai', aliases: ['azure-openai'] },
  { id: 'amazon-bedrock',      label: 'Amazon Bedrock',          baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',   defaultModel: 'eu.anthropic.claude-fable-5',             needsApiKey: true, listingType: 'openai', aliases: ['bedrock', 'aws'] },
  { id: 'google-vertex',       label: 'Google Vertex',           baseUrl: 'https://aiplatform.googleapis.com/v1',              defaultModel: 'gemini-2.5-flash',                        needsApiKey: true, listingType: 'openai', aliases: ['vertex'] },
  { id: 'databricks',          label: 'Databricks',              baseUrl: 'https://YOUR-WORKSPACE.cloud.databricks.com/serving-endpoints/openai', defaultModel: 'databricks-claude-opus-4-5', needsApiKey: true, listingType: 'openai', aliases: ['dbx'] },
  { id: 'snowflake-cortex',    label: 'Snowflake Cortex',        baseUrl: 'https://YOUR-ACCOUNT.snowflakecomputing.com/api/v2/cortex', defaultModel: 'claude-haiku-4-5',              needsApiKey: true, listingType: 'openai', aliases: ['snowflake'] },
  { id: 'sap-ai-core',         label: 'SAP AI Core',             baseUrl: 'https://api.sap.ai/ml/inference',                   defaultModel: 'anthropic--claude-4-opus',                needsApiKey: true, listingType: 'openai', aliases: ['sap'] },
  { id: 'gitlab',              label: 'GitLab Duo',              baseUrl: 'https://gitlab.com/api/v4',                         defaultModel: 'duo-chat-gpt-5-4-nano',                   needsApiKey: true, listingType: 'openai', aliases: ['gitlab-duo'] },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai', defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', needsApiKey: true, listingType: 'openai', aliases: ['cloudflare', 'cf'] },
  // Local providers
  { id: 'ollama',       label: 'Ollama (Local)',       baseUrl: 'http://localhost:11434/v1',             defaultModel: 'llama3.2',         needsApiKey: false, listingType: 'ollama',     aliases: ['ol'] },
  { id: 'lmstudio',     label: 'LM Studio (Local)',    baseUrl: 'http://localhost:1234/v1',              defaultModel: 'local-model',      needsApiKey: false, listingType: 'openai',     aliases: ['lms'] },
  { id: 'local-llm',    label: 'Local LLM (On-Device)', baseUrl: '',                                    defaultModel: 'Xenova/Qwen2.5-1.5B-Instruct', needsApiKey: false, listingType: 'local', aliases: ['local', 'ondevice'] },
];

// Curated fallback catalogs — used when live model listing is unavailable
// (some providers block browser CORS, or have no public models endpoint).
// Only well-established, verified model IDs are included.
const FALLBACK_MODELS: Record<string, StaticModelOption[]> = {
  // Read from https://api.sambanova.ai/v1/models (public, unauthenticated).
  sambanova: [
    { id: 'DeepSeek-V3.1',              label: 'DeepSeek V3.1',          free: false, context: '128k', tools: true  },
    { id: 'DeepSeek-V3.2',              label: 'DeepSeek V3.2',          free: false, context: '128k', tools: true  },
    { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B',         free: false, context: '128k', tools: true  },
    { id: 'MiniMax-M3',                 label: 'MiniMax M3',             free: false, context: '200k', tools: true  },
    { id: 'gemma-4-31B-it',             label: 'Gemma 4 31B',            free: false, context: '128k', tools: true  },
    { id: 'gpt-oss-120b',               label: 'GPT-OSS 120B',           free: false, context: '128k', tools: true  },
  ],
  // Read from https://api.aimlapi.com/v1/models (977 models; curated subset).
  aimlapi: [
    { id: 'openai/gpt-4o-mini',         label: 'GPT-4o Mini',            free: false, context: '128k', tools: true, vision: true },
    { id: 'openai/gpt-6.1-sol',         label: 'GPT-6.1 Sol',            free: false, context: '400k', tools: true, vision: true },
    { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5',     free: false, context: '200k', tools: true, vision: true },
    { id: 'inclusionai/ling-3.1-flash', label: 'Ling 3.1 Flash',         free: false, context: '128k', tools: true  },
    { id: 'liquid/d1-router',           label: 'Liquid D1 Router',       free: false, context: '128k', tools: true  },
    { id: 'unbiased/pareto-26.10-preview', label: 'Pareto 26.10',        free: false, context: '128k', tools: true  },
  ],
  opencode: [
    { id: 'deepseek-v4-flash-free',    label: 'DeepSeek V4 Flash',   free: true,  context: '64k',  tools: true, vision: true  },
    { id: 'gpt-4o-mini',               label: 'GPT-4o Mini',         free: false, context: '128k', tools: true, vision: true  },
  ],
  openrouter: [
    { id: 'google/gemma-3-27b-it:free',         label: 'Gemma 3 27B',     free: true,  context: '96k',  tools: true, vision: true  },
    { id: 'deepseek/deepseek-chat:free',        label: 'DeepSeek V3',     free: true,  context: '64k',  tools: true, vision: true  },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B', free: true, context: '128k', tools: true, vision: false },
    { id: 'qwen/qwen3-32b-free',                label: 'Qwen 3 32B',      free: true,  context: '32k',  tools: true, vision: false },
    { id: 'mistralai/mixtral-8x7b-instruct:free', label: 'Mixtral 8x7B',  free: true,  context: '32k',  tools: false, vision: false },
    { id: 'openai/gpt-4o-mini',                 label: 'GPT-4o Mini',     free: false, context: '128k', tools: true, vision: true  },
    { id: 'openai/gpt-4o',                      label: 'GPT-4o',          free: false, context: '128k', tools: true, vision: true  },
    { id: 'anthropic/claude-3.5-sonnet',        label: 'Claude 3.5 Sonnet', free: false, context: '200k', tools: true, vision: true  },
  ],
  openai: [
    { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol',   free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-5.5',       label: 'GPT-5.5',       free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-5.4',       label: 'GPT-5.4',       free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-5.4-mini',  label: 'GPT-5.4 Mini',  free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-5.1',       label: 'GPT-5.1',       free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-4.1',       label: 'GPT-4.1',       free: false, context: '1M', tools: true, vision: true },
    { id: 'gpt-4.1-mini',  label: 'GPT-4.1 Mini',  free: false, context: '1M', tools: true, vision: true },
    { id: 'o3',            label: 'o3',            free: false, context: '200k', tools: true, vision: false },
    { id: 'o4-mini',       label: 'o4 Mini',       free: false, context: '200k', tools: true, vision: false },
    { id: 'o3-mini',       label: 'o3 Mini',       free: false, context: '200k', tools: true, vision: false },
    { id: 'gpt-4o',        label: 'GPT-4o',        free: false, context: '128k', tools: true, vision: true },
    { id: 'gpt-4o-mini',   label: 'GPT-4o Mini',   free: false, context: '128k', tools: true, vision: true },
  ],
  anthropic: [
    { id: 'claude-opus-4-8',   label: 'Claude Opus 4.8',   free: false, context: '1M', tools: true, vision: true },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', free: false, context: '1M', tools: true, vision: true },
    { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  free: false, context: '200k', tools: true, vision: true },
    { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   free: false, context: '1M', tools: true, vision: true },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', free: false, context: '1M', tools: true, vision: true },
  ],
  gemini: [
    { id: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash', free: true,  context: '1M', tools: true, vision: true },
    { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro',   free: false, context: '1M', tools: true, vision: true },
    { id: 'gemini-2.0-flash',     label: 'Gemini 2.0 Flash', free: true,  context: '1M', tools: true, vision: true },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', free: true, context: '1M', tools: true, vision: false },
    { id: 'gemini-1.5-pro',       label: 'Gemini 1.5 Pro',   free: false, context: '2M', tools: true, vision: true },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', free: true, context: '128k', tools: true, vision: false },
    { id: 'llama3-70b-8192',        label: 'Llama 3 70B',   free: true, context: '8k',   tools: true, vision: false },
    { id: 'llama3-8b-8192',         label: 'Llama 3 8B',    free: true, context: '8k',   tools: true, vision: false },
    { id: 'mixtral-8x7b-32768',     label: 'Mixtral 8x7B',  free: true, context: '32k',  tools: false, vision: false },
    { id: 'gemma2-9b-it',           label: 'Gemma 2 9B',    free: true, context: '8k',   tools: true, vision: false },
  ],
  deepseek: [
    { id: 'deepseek-chat',     label: 'DeepSeek V3',    free: false, context: '64k', tools: true, vision: true  },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1',    free: false, context: '64k', tools: false, vision: false },
  ],
  cerebras: [
    { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', free: true, context: '8k', tools: true, vision: false },
    { id: 'llama3.1-8b',   label: 'Llama 3.1 8B',  free: true, context: '8k', tools: true, vision: false },
  ],
  mistral: [
    { id: 'mistral-small-latest',   label: 'Mistral Small',  free: true,  context: '32k',  tools: true, vision: true },
    { id: 'mistral-large-latest',   label: 'Mistral Large',  free: false, context: '128k', tools: true, vision: true },
    { id: 'pixtral-large-latest',   label: 'Pixtral Large',  free: false, context: '128k', tools: true, vision: true },
    { id: 'open-mistral-7b',        label: 'Mistral 7B',     free: true,  context: '32k',  tools: false, vision: false },
    { id: 'open-mixtral-8x7b',      label: 'Mixtral 8x7B',   free: true,  context: '32k',  tools: false, vision: false },
  ],
  xai: [
    { id: 'grok-4.5',    label: 'Grok 4.5',    free: false, context: '500k', tools: true, vision: true },
    { id: 'grok-4.3',    label: 'Grok 4.3',    free: false, context: '1M',   tools: true, vision: true },
    { id: 'grok-4.20',   label: 'Grok 4.20',   free: false, context: '2M',   tools: true, vision: true },
    { id: 'grok-3',      label: 'Grok 3',      free: false, context: '131k', tools: true, vision: false },
    { id: 'grok-2',      label: 'Grok 2',      free: false, context: '128k', tools: true, vision: false },
  ],
  togetherai: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B',   free: false, context: '128k', tools: true, vision: false },
    { id: 'deepseek-ai/DeepSeek-V3',                 label: 'DeepSeek V3',      free: false, context: '128k', tools: true, vision: false },
    { id: 'Qwen/Qwen2.5-72B-Instruct',               label: 'Qwen 2.5 72B',    free: false, context: '128k', tools: true, vision: false },
    { id: 'mistralai/Mixtral-8x7B-Instruct',         label: 'Mixtral 8x7B',     free: false, context: '32k',  tools: false, vision: false },
  ],
  huggingface: [
    { id: 'Qwen/Qwen2.5-72B-Instruct',          label: 'Qwen 2.5 72B',     free: false, context: '128k', tools: true, vision: false },
    { id: 'meta-llama/Llama-3.3-70B-Instruct',  label: 'Llama 3.3 70B',    free: false, context: '128k', tools: true, vision: false },
    { id: 'mistralai/Mistral-7B-Instruct-v0.3', label: 'Mistral 7B',        free: true,  context: '32k',  tools: false, vision: false },
    { id: 'deepseek-ai/DeepSeek-V3',            label: 'DeepSeek V3',       free: false, context: '128k', tools: true, vision: false },
  ],
  perplexity: [
    { id: 'sonar-pro',           label: 'Sonar Pro',           free: false, context: '200k', tools: false, vision: false },
    { id: 'sonar',               label: 'Sonar',               free: false, context: '128k', tools: false, vision: false },
    { id: 'sonar-reasoning',     label: 'Sonar Reasoning',     free: false, context: '128k', tools: false, vision: false },
    { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', free: false, context: '200k', tools: false, vision: false },
  ],
  cohere: [
    { id: 'command-r-plus', label: 'Command R+', free: false, context: '128k', tools: true, vision: false },
    { id: 'command-r',      label: 'Command R',  free: false, context: '128k', tools: true, vision: false },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B', free: false, context: '128k', tools: true, vision: false },
    { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct',  label: 'Llama 3.1 8B',  free: false, context: '8k',   tools: true, vision: false },
    { id: 'accounts/fireworks/models/deepseek-r1',            label: 'DeepSeek R1',    free: false, context: '128k', tools: false, vision: false },
  ],
  deepinfra: [
    { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B',   free: false, context: '128k', tools: true, vision: false },
    { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', label: 'Llama 3.1 70B',   free: false, context: '128k', tools: true, vision: false },
    { id: 'deepseek-ai/DeepSeek-V3',                label: 'DeepSeek V3',      free: false, context: '128k', tools: true, vision: false },
    { id: 'Qwen/Qwen2.5-72B-Instruct',              label: 'Qwen 2.5 72B',    free: false, context: '128k', tools: true, vision: false },
  ],
  ai21: [
    { id: 'jamba-1.5-mini', label: 'Jamba 1.5 Mini', free: false, context: '256k', tools: false, vision: false },
    { id: 'jamba-1.5-large', label: 'Jamba 1.5 Large', free: false, context: '256k', tools: false, vision: false },
  ],
  replicate: [
    { id: 'meta/meta-llama-3.3-70b-instruct', label: 'Llama 3.3 70B', free: false, context: '128k', tools: true, vision: false },
    { id: 'meta/meta-llama-3-70b-instruct',   label: 'Llama 3 70B',   free: false, context: '8k',   tools: false, vision: false },
    { id: 'deepseek-ai/deepseek-v3',          label: 'DeepSeek V3',    free: false, context: '128k', tools: true, vision: false },
  ],
  nvidia: [
    { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B', free: false, context: '128k', tools: true, vision: false },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1',  label: 'Nemotron Super 49B',  free: false, context: '128k', tools: true, vision: true  },
    { id: 'meta/llama-3.3-70b-instruct',             label: 'Llama 3.3 70B',       free: true,  context: '128k', tools: true, vision: true  },
    { id: 'meta/llama-3.1-405b-instruct',            label: 'Llama 3.1 405B',      free: false, context: '128k', tools: true, vision: true  },
    { id: 'mistralai/mistral-large-24-11-07',        label: 'Mistral Large',       free: false, context: '128k', tools: true, vision: true  },
    { id: 'deepseek-ai/deepseek-r1',                 label: 'DeepSeek R1',         free: false, context: '128k', tools: false, vision: false },
  ],
  ollama: [
    { id: 'llama3.2', label: 'Llama 3.2', free: true, context: '128k', tools: true, vision: false },
    { id: 'llama3.3', label: 'Llama 3.3', free: true, context: '128k', tools: true, vision: false },
    { id: 'gemma3',   label: 'Gemma 3',   free: true, context: '128k', tools: true, vision: true  },
    { id: 'phi4',     label: 'Phi-4',     free: true, context: '16k',  tools: true, vision: false },
    { id: 'qwen2.5',  label: 'Qwen 2.5',  free: true, context: '128k', tools: true, vision: false },
  ],
  lmstudio: [
    { id: 'local-model', label: 'Loaded Model', free: true, context: '?', tools: true, vision: false },
  ],
  'local-llm': [
    { id: 'Xenova/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B (Lightning)', free: true, context: '32k', tools: true, vision: false },
    { id: 'Xenova/Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B (Balanced)',  free: true, context: '32k', tools: true, vision: false },
    { id: 'Xenova/Qwen2.5-3B-Instruct',   label: 'Qwen2.5 3B (Ultra)',       free: true, context: '32k', tools: true, vision: false },
  ],
};

// Known image generation models
const FALLBACK_IMAGE_MODELS: Record<string, string> = {
  openai: 'dall-e-3',
  openrouter: 'openai/dall-e-3',
  nvidia: 'nvidia/sana-4k',
};

class ProviderRegistry {
  private providers: Map<string, ProviderDef> = new Map();
  private models: Map<string, StaticModelOption[]> = new Map();
  private imageModels: Map<string, string> = new Map();
  private loaded = false;
  private loading: Promise<void> | null = null;

  async init(): Promise<void> {
    // Start with fallback
    for (const def of FALLBACK_PROVIDERS) {
      this.providers.set(def.id, def);
    }
    for (const [id, models] of Object.entries(FALLBACK_MODELS)) {
      this.models.set(id, models);
    }
    for (const [id, model] of Object.entries(FALLBACK_IMAGE_MODELS)) {
      this.imageModels.set(id, model);
    }

    // Seed every provider with at least its default model. Without this, the
    // providers added for opencode parity would appear in the picker with an
    // empty model list until models.dev responded — or forever, if the fetch
    // is blocked. The catalog enrichment below only ever *grows* these lists.
    for (const def of FALLBACK_PROVIDERS) {
      const existing = this.models.get(def.id);
      if (!existing || existing.length === 0) {
        this.models.set(def.id, [{ id: def.defaultModel, label: def.defaultModel, free: false }]);
      }
    }

    // Try remote config — enrich (not replace) fallback
    this.loading = this.fetchRemote();
    try {
      await this.loading;
    } catch { /* remote config unavailable, fallback only */ }
    this.loaded = true;
    this.loading = null;
  }

  private async fetchRemote(): Promise<void> {
    // `https://opencode.ai/api/providers` has returned 404 for a long time, and
    // the old `if (!res.ok) return` silently swallowed it — so this enrichment
    // never ran and the app was permanently pinned to the static fallback list.
    // models.dev (what opencode itself consumes) is the endpoint that works.
    try {
      const data = await fetchModelsDev();
      if (!data) return;

      // Give every known provider a models bucket so models.dev can fill the
      // ones we ship no curated fallback for.
      for (const id of this.providers.keys()) {
        if (!this.models.has(id)) this.models.set(id, []);
      }

      // Enrich only providers we already ship a base URL for. models.dev does
      // not publish base URLs (opencode gets them from its @ai-sdk/* packages),
      // so registering unknown providers would put entries in the picker that
      // this app cannot actually call.
      const { updated } = mergeProviderModels(this.models, data);
      if (updated.length) {
        logger.info(`[ProviderRegistry] models.dev enriched ${updated.length} provider(s)`);
      }
    } catch (e) {
      logger.warn('[ProviderRegistry] Remote config fetch failed, using fallback:', e);
    }
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded && this.loading) {
      await this.loading;
    }
    if (!this.loaded) {
      await this.init();
    }
  }

  getProvider(id: string): ProviderDef | undefined {
    return this.providers.get(id);
  }

  getLabel(id: string): string {
    return this.providers.get(id)?.label ?? id;
  }

  getBaseUrl(id: string): string {
    return this.providers.get(id)?.baseUrl ?? '';
  }

  getDefaultModel(id: string): string {
    return this.providers.get(id)?.defaultModel ?? '';
  }

  getListingType(id: string): ProviderDef['listingType'] {
    return this.providers.get(id)?.listingType ?? 'openai';
  }

  getImageModel(id: string): string | undefined {
    return this.imageModels.get(id);
  }

  getAllIds(): string[] {
    return Array.from(this.providers.keys());
  }

  getAllProviders(): ProviderDef[] {
    return Array.from(this.providers.values());
  }

  getModels(id: string): StaticModelOption[] {
    return this.models.get(id) ?? [];
  }

  getNeedsApiKey(id: string): boolean {
    return this.providers.get(id)?.needsApiKey ?? true;
  }

  /** Resolve an id or alias to a full provider id, or return the input unchanged if not found. */
  resolveAlias(s: string): string {
    // Direct match
    if (this.providers.has(s)) return s;
    // Alias lookup
    for (const [id, def] of this.providers) {
      if (def.aliases?.includes(s)) return id;
    }
    return s; // return as-is
  }
}

export const providerRegistry = new ProviderRegistry();
