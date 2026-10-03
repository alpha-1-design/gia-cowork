import { logger } from '../utils/logger';

const STORAGE_KEY = 'gia-cost-tracker-v1';

/**
 * USD per 1M tokens. Input = prompt tokens, Output = completion tokens.
 * Local runtimes (Ollama, LM Studio, on-device) are absent from the table and
 * cost $0 — running on your own hardware is the whole point of the local
 * tier, so local usage must never inflate a spend report.
 *
 * Keys are matched as substrings against a model id, most specific first.
 * Unknown models fall back to provider-level defaults so a new model in the
 * catalog still reports a sane estimate instead of silently costing $0.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5': { input: 1.25, output: 10 },
  o1: { input: 15, output: 60 },
  o3: { input: 2, output: 8 },

  // Anthropic
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-haiku-4': { input: 1, output: 5 },

  // Google
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },

  // Groq (very cheap, fast)
  'llama3-70b': { input: 0.59, output: 0.79 },
  'llama3.1-8b': { input: 0.05, output: 0.08 },
  'llama3-70b-8192': { input: 0.59, output: 0.79 },
  'llama3.1-70b': { input: 0.59, output: 0.79 },

  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-v4': { input: 0.2, output: 0.8 },

  // Mistral
  'mistral-small': { input: 0.2, output: 0.6 },
  'mistral-large': { input: 2, output: 6 },
  'jamba': { input: 2, output: 8 },

  // xAI
  'grok-4': { input: 3, output: 15 },
  'grok-3': { input: 3, output: 15 },
  'grok-2': { input: 2, output: 10 },

  // Perplexity
  sonar: { input: 1, output: 1 },
  'sonar-pro': { input: 3, output: 15 },

  // Cohere
  'command-r-plus': { input: 2.5, output: 10 },
  'command-r': { input: 0.15, output: 0.6 },

  // Cerebras
  'llama3.1-8b-cerebras': { input: 0.1, output: 0.1 },
};

/** Providers that never bill — local inference on the user's own machine. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'local-llm']);

/** Conservative per-provider fallback when a model id isn't in the table. */
const PROVIDER_FALLBACK: Record<string, ModelPrice> = {
  openai: { input: 2.5, output: 10 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 0.3, output: 2.5 },
  groq: { input: 0.59, output: 0.79 },
  deepseek: { input: 0.27, output: 1.1 },
  xai: { input: 3, output: 15 },
  mistral: { input: 0.2, output: 0.6 },
  perplexity: { input: 3, output: 15 },
  cohere: { input: 2.5, output: 10 },
  cerebras: { input: 0.1, output: 0.1 },
  // Aggregators vary wildly per routed model; assume mid-tier and let the
  // per-model table win whenever we recognise the id.
  openrouter: { input: 1, output: 3 },
  opencode: { input: 0.5, output: 1.5 },
  togetherai: { input: 0.9, output: 0.9 },
  fireworks: { input: 0.9, output: 0.9 },
  deepinfra: { input: 0.35, output: 0.4 },
  ai21: { input: 2, output: 8 },
  replicate: { input: 0.3, output: 0.8 },
  nvidia: { input: 0.2, output: 0.6 },
  huggingface: { input: 0, output: 0 },
};

/** Providers whose model ids carry a ':free' suffix route at no cost. */
function isFreeModelId(model: string): boolean {
  return /:free\b|\bfree\b|-free$/.test(model.toLowerCase());
}

export interface SpendEntry {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD for this call. 0 for local inference. */
  cost: number;
  sessionId: string;
}

export interface SpendSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  calls: number;
  byModel: { model: string; provider: string; cost: number; tokens: number; calls: number }[];
  byProvider: { provider: string; cost: number; tokens: number; calls: number }[];
  byDay: { day: string; cost: number; calls: number }[];
  localTokens: number;
  localCalls: number;
}

const MAX_ENTRIES = 5000;

function emptyData(): SpendEntry[] {
  return [];
}

function load(): SpendEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : emptyData();
    }
  } catch (e) {
    logger.warn('[CostTracker] Failed to load spend history:', e);
  }
  return emptyData();
}

function save(entries: SpendEntry[]) {
  try {
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota or private mode — reporting degrades, generation doesn't */ }
}

/**
 * Resolve the price for a (provider, model) pair. Local providers and
 * ':free' routes are always $0. Unknown models fall back to the provider
 * default rather than reporting $0, because under-reporting cost is worse
 * than a rough estimate when the whole point is telling the user the truth.
 */
export function getPrice(provider: string, model: string): ModelPrice {
  if (LOCAL_PROVIDERS.has(provider)) return { input: 0, output: 0 };
  if (isFreeModelId(model)) return { input: 0, output: 0 };

  const id = model.toLowerCase();
  // Longest matching key wins so 'gpt-4o-mini' beats 'gpt-4o' and
  // 'claude-sonnet-4' beats 'claude-3-5-sonnet'.
  let bestKey = '';
  for (const key of Object.keys(MODEL_PRICES)) {
    if (id.includes(key) && key.length > bestKey.length) bestKey = key;
  }
  if (bestKey) return MODEL_PRICES[bestKey];

  // Some aggregators prefix the vendor: 'anthropic/claude-sonnet-4'.
  const slash = id.lastIndexOf('/');
  if (slash !== -1) {
    const bare = id.slice(slash + 1);
    for (const key of Object.keys(MODEL_PRICES)) {
      if (bare.includes(key)) return MODEL_PRICES[key];
    }
  }

  return PROVIDER_FALLBACK[provider] ?? { input: 0, output: 0 };
}

export function computeCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const price = getPrice(provider, model);
  // Clamp before multiplying: a malformed provider response reporting
  // negative usage would otherwise credit the user's total with a
  // negative cost.
  const input = Math.max(0, inputTokens || 0);
  const output = Math.max(0, outputTokens || 0);
  // Sub-cent calls are common; keep them rather than rounding to zero, so
  // long sessions still accumulate a truthful total.
  return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
}

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

class CostTracker {
  private entries: SpendEntry[];

  constructor() {
    this.entries = load();
  }

  /**
   * Record one generation. Call this at the single point where a provider
   * response returns tokenUsage so no path can bypass accounting.
   */
  record(provider: string, model: string, inputTokens: number, outputTokens: number, sessionId: string): SpendEntry {
    const input = Math.max(0, inputTokens || 0);
    const output = Math.max(0, outputTokens || 0);
    const entry: SpendEntry = {
      timestamp: Date.now(),
      provider,
      model: model || 'unknown',
      inputTokens: input,
      outputTokens: output,
      cost: computeCost(provider, model || '', input, output),
      sessionId: sessionId || 'unknown',
    };
    this.entries.push(entry);
    save(this.entries);
    return entry;
  }

  /** Spend for one chat session — shown per conversation. */
  getSessionCost(sessionId: string): number {
    return this.entries.filter(e => e.sessionId === sessionId).reduce((s, e) => s + e.cost, 0);
  }

  getSummary(sinceMs?: number): SpendSummary {
    const scoped = sinceMs ? this.entries.filter(e => e.timestamp >= sinceMs) : this.entries;

    const modelMap = new Map<string, { model: string; provider: string; cost: number; tokens: number; calls: number }>();
    const providerMap = new Map<string, { provider: string; cost: number; tokens: number; calls: number }>();
    const dayMap = new Map<string, { day: string; cost: number; calls: number }>();

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let localTokens = 0;
    let localCalls = 0;

    for (const e of scoped) {
      totalCost += e.cost;
      totalInputTokens += e.inputTokens;
      totalOutputTokens += e.outputTokens;
      const tokens = e.inputTokens + e.outputTokens;

      if (isLocalProvider(e.provider)) {
        localTokens += tokens;
        localCalls++;
      }

      const mk = `${e.provider}::${e.model}`;
      if (!modelMap.has(mk)) modelMap.set(mk, { model: e.model, provider: e.provider, cost: 0, tokens: 0, calls: 0 });
      const m = modelMap.get(mk)!;
      m.cost += e.cost;
      m.tokens += tokens;
      m.calls++;

      if (!providerMap.has(e.provider)) providerMap.set(e.provider, { provider: e.provider, cost: 0, tokens: 0, calls: 0 });
      const p = providerMap.get(e.provider)!;
      p.cost += e.cost;
      p.tokens += tokens;
      p.calls++;

      const day = new Date(e.timestamp).toISOString().slice(0, 10);
      if (!dayMap.has(day)) dayMap.set(day, { day, cost: 0, calls: 0 });
      const d = dayMap.get(day)!;
      d.cost += e.cost;
      d.calls++;
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      calls: scoped.length,
      byModel: [...modelMap.values()].sort((a, b) => b.cost - a.cost),
      byProvider: [...providerMap.values()].sort((a, b) => b.cost - a.cost),
      byDay: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      localTokens,
      localCalls,
    };
  }

  /** Spend for the trailing 24h — the number people actually panic about. */
  getTodayCost(): number {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return this.entries.filter(e => e.timestamp >= since).reduce((s, e) => s + e.cost, 0);
  }

  getRecent(limit = 50): SpendEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear() {
    this.entries = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

export const costTracker = new CostTracker();
export default costTracker;

/** Format a USD amount for display — sub-cent values keep 4 decimals. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
