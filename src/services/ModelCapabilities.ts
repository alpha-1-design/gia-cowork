/**
 * Model capabilities.
 *
 * A model id like `gpt-4o` is not a capability description. This module turns
 * one into a set of explicit abilities — can it see an image, can it take
 * audio, can it generate one, does it do tool calls — so two things can use it:
 *
 *   1. The model picker, which shows what you are actually choosing between.
 *   2. GIA herself, via the system prompt, so she can tell you "the active
 *      model cannot read images, switch to one that can" instead of quietly
 *      failing on a task that needs vision.
 *
 * Two sources, in priority order:
 *   - Explicit metadata from the provider registry or a live API listing,
 *     which is authoritative when present.
 *   - Inference from the model id, used when the provider does not say.
 *     Inference is deliberately conservative and marks itself as inferred, so
 *     the UI never presents a guess as a guarantee.
 */

export interface ModelCapabilities {
  /** Accepts image input. */
  vision: boolean;
  /** Accepts audio input. */
  audioInput: boolean;
  /** Accepts video / a sequence of frames as input. */
  videoInput: boolean;
  /** Generates images as output. */
  imageGeneration: boolean;
  /** Supports native tool/function calling. */
  tools: boolean;
  /** Produces visible step-by-step reasoning. */
  reasoning: boolean;
  /** Declared context window in tokens, when known. */
  contextWindow: number | null;
  /** True when these values were inferred from the id, not declared. */
  inferred: boolean;
}

export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  vision: false, audioInput: false, videoInput: false,
  imageGeneration: false, tools: false, reasoning: false,
  contextWindow: null, inferred: true,
};

export function emptyCapabilities(): ModelCapabilities {
  return { ...UNKNOWN_CAPABILITIES };
}

/** Parse a context string like "128000" or "128k" into a token count. */
export function parseContextWindow(raw?: string | number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Suffix forms first — "1M" must not fall through to the bare-number parse
  // and come back as a one-token window.
  const suffixed = /^(\d+(?:\.\d+)?)\s*([km])$/.exec(s);
  if (suffixed) {
    const mult = suffixed[2] === 'm' ? 1_000_000 : 1_000;
    return Math.round(parseFloat(suffixed[1]) * mult);
  }
  const n = /^(\d[\d,_]*)/.exec(s);
  if (!n) return null;
  const v = Number.parseInt(n[1].replace(/[,_]/g, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Anything matching any of these substrings can see images. */
const VISION_PATTERNS = [
  'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-4-turbo', 'gpt-4-vision', 'o3', 'o4',
  'claude-3', 'claude-sonnet', 'claude-opus', 'claude-haiku', 'claude-4',
  'gemini-1.5', 'gemini-2', 'gemini-3', 'gemini-pro-vision',
  'llava', 'bakllava', 'moondream', 'pixtral', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl',
  'internvl', 'minicpm-v', 'phi-3-vision', 'phi-4', 'grok-2-vision', 'grok-vision',
  'deepseek-vl', 'glm-4v', 'ernie', 'kimi-vl', 'mistral-small-3', 'pixtral',
];

/** Accepts audio as input. */
const AUDIO_INPUT_PATTERNS = [
  'gpt-4o-audio', 'gpt-4o-realtime', 'gpt-4o-mini-audio', 'gpt-audio',
  'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash',
  'claude-3-7-sonnet', 'ultravox', 'voxtral', 'qwen2-audio', 'qwen2.5-omni',
  'grok-2-audio', 'grok-4', 'pipecat',
];

/** Accepts video / multi-frame input. */
const VIDEO_INPUT_PATTERNS = [
  'gemini-1.5', 'gemini-2', 'gemini-3',
  'gpt-4o', 'gpt-4.1', 'gpt-5',
  'claude-3-5', 'claude-3-7', 'claude-sonnet-4', 'claude-opus-4', 'claude-4',
  'grok-vision', 'grok-2-vision', 'llava-video', 'qwen2-vl', 'qwen2.5-vl',
];

const IMAGE_GEN_PATTERNS = [
  'dall-e', 'gpt-image', 'imagen', 'stable-diffusion', 'sdxl', 'flux',
  'ideogram', 'recraft', 'midjourney', 'nano-banana', 'seedream', 'qwen-image',
];

const REASONING_PATTERNS = [
  'o1', 'o3', 'o4', 'deepseek-r1', 'qwq', 'reasoner', 'thinking', 'gpt-5',
];

const LOCAL_PREFIXES = ['ollama', 'lmstudio', 'local-llm', 'llama', 'qwen', 'mistral', 'gemma', 'phi-', 'deepseek', 'grok-'];

/**
 * Infer capabilities from a model id.
 *
 * Matches on substrings rather than exact ids because providers ship new
 * variants constantly and an exact table would be wrong within a week.
 */
export function inferCapabilities(modelId: string, fallbackContext?: string | number | null): ModelCapabilities {
  const id = (modelId || '').toLowerCase().trim();
  if (!id) return { ...UNKNOWN_CAPABILITIES };
  const has = (list: string[]) => list.some(p => id.includes(p));

  const vision = has(VISION_PATTERNS);
  // Audio implies it can at least be fed audio; several audio models are also
  // vision-capable, and refusing to claim that would understate them.
  const audioInput = has(AUDIO_INPUT_PATTERNS);
  const videoInput = vision && has(VIDEO_INPUT_PATTERNS);

  return {
    vision,
    audioInput,
    videoInput,
    imageGeneration: has(IMAGE_GEN_PATTERNS),
    // Almost every current chat model does tool calls; the exceptions are old
    // completion-style and embedding models.
    tools: !/(embedding|embed-|whisper|tts|bge-|e5-|rerank)/.test(id),
    reasoning: has(REASONING_PATTERNS),
    contextWindow: parseContextWindow(fallbackContext),
    inferred: true,
  };
}

/** Merge declared metadata over inferred values; declared always wins. */
export function resolveCapabilities(
  modelId: string,
  declared?: Partial<ModelCapabilities> & { context?: string | number | null },
): ModelCapabilities {
  const base = inferCapabilities(modelId, declared?.context);
  if (!declared) return base;

  const pick = <K extends keyof ModelCapabilities>(key: K, fallback: ModelCapabilities[K]) =>
    declared[key] !== undefined ? (declared[key] as ModelCapabilities[K]) : fallback;

  const contextWindow = declared.contextWindow !== undefined
    ? declared.contextWindow
    : parseContextWindow(declared.context) ?? base.contextWindow;

  return {
    vision: pick('vision', base.vision),
    audioInput: pick('audioInput', base.audioInput),
    videoInput: pick('videoInput', base.videoInput),
    imageGeneration: pick('imageGeneration', base.imageGeneration),
    tools: pick('tools', base.tools),
    reasoning: pick('reasoning', base.reasoning),
    contextWindow,
    // If the provider said anything, the result is at least partly declared.
    inferred: base.inferred && declared.vision === undefined && declared.tools === undefined,
  };
}

/** Short human labels for the UI. */
export function capabilityBadges(c: ModelCapabilities): Array<{ key: string; label: string; color: string; title: string }> {
  const out: Array<{ key: string; label: string; color: string; title: string }> = [];
  if (c.vision) out.push({ key: 'vision', label: 'VISION', color: '#ec4899', title: 'Can read images' });
  if (c.videoInput) out.push({ key: 'video', label: 'VIDEO', color: '#f43f5e', title: 'Can accept video or frame sequences' });
  if (c.audioInput) out.push({ key: 'audio', label: 'AUDIO', color: '#06b6d4', title: 'Can accept audio input' });
  if (c.imageGeneration) out.push({ key: 'imagegen', label: 'IMAGE GEN', color: '#8b5cf6', title: 'Can generate images' });
  if (c.tools) out.push({ key: 'tools', label: 'TOOLS', color: '#a855f7', title: 'Supports tool / function calling' });
  if (c.reasoning) out.push({ key: 'reasoning', label: 'REASONING', color: '#f59e0b', title: 'Shows step-by-step reasoning' });
  return out;
}

/**
 * A sentence for the system prompt describing what the active model can do.
 *
 * Phrased as guidance rather than a feature list, because the point is for GIA
 * to act differently — pick a vision model for a screenshot, say so plainly
 * when the current model cannot read images.
 */
export function describeCapabilities(c: ModelCapabilities): string {
  const can: string[] = [];
  const cannot: string[] = [];

  if (c.vision) can.push('read images'); else cannot.push('read images');
  if (c.videoInput) can.push('accept video or frame sequences');
  if (c.audioInput) can.push('accept audio'); else cannot.push('accept audio input');
  if (c.imageGeneration) can.push('generate images');
  if (c.tools) can.push('call tools'); else cannot.push('call tools');
  if (c.reasoning) can.push('show step-by-step reasoning');

  const parts: string[] = [];
  if (can.length) parts.push(`can ${can.join(', ')}`);
  if (cannot.length) parts.push(`cannot ${cannot.join(', ')}`);

  const ctx = c.contextWindow ? ` Its context window is about ${c.contextWindow.toLocaleString()} tokens.` : '';
  const inferred = c.inferred ? ' These details are inferred from the model name, so treat them as a good guide rather than a guarantee.' : '';

  return `The active model ${parts.join('; it ')} it.${ctx}${inferred} When a task needs something it cannot do, say so plainly and offer to switch to a capable model rather than guessing or producing a broken result.`;
}

/** Is this likely a local model, where capability claims are least reliable? */
export function isLikelyLocal(modelId: string, providerId: string): boolean {
  const id = (modelId || '').toLowerCase();
  const p = (providerId || '').toLowerCase();
  if (['ollama', 'lmstudio', 'local-llm'].includes(p)) return true;
  return LOCAL_PREFIXES.some(x => id.startsWith(x));
}