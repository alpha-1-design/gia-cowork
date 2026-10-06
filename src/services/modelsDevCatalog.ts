/**
 * models.dev — the provider and model catalog opencode itself is built on.
 *
 * `ProviderRegistry.fetchRemote()` used to fetch `https://opencode.ai/api/providers`,
 * which has returned **404** for a long time. Because the failure was swallowed
 * (`if (!res.ok) return`), every session silently fell back to the 21 static
 * entries, so the "same providers as opencode" behaviour the code appeared to
 * offer never actually happened. This module points at the endpoint that does
 * work and maps its (different) shape.
 *
 * models.dev does **not** publish an API base URL per provider — opencode gets
 * those from each `@ai-sdk/*` package. GIA calls HTTP directly, so it can only
 * enrich providers whose base URL is already known. New provider *models* are
 * therefore merged by id, never invented.
 *
 * Every mapping here is pure so it can be tested against a fixture without a
 * network.
 */

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
  tool_call?: boolean;
  attachment?: boolean;
  open_weights?: boolean;
}

export interface ModelsDevEntry {
  id: string;
  name?: string;
  /** Required API key env vars, e.g. `["OPENAI_API_KEY"]`. */
  env?: string[] | Record<string, string>;
  npm?: string;
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevPayload = Record<string, ModelsDevEntry>;

/** Mirrors the registry's `StaticModelOption` shape. */
export interface ModelOption {
  id: string;
  label: string;
  free: boolean;
  context?: string;
  tools?: boolean;
  vision?: boolean;
}

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Context window rendered the way the picker already displays it. */
export function formatContext(tokens?: number): string | undefined {
  if (!tokens || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** A model is free only when it costs nothing in *and* out. */
export function isFreeModel(cost?: ModelsDevModel['cost']): boolean {
  if (!cost) return false;
  return (cost.input ?? 1) === 0 && (cost.output ?? 1) === 0;
}

export function supportsVision(model: ModelsDevModel): boolean {
  const input = model.modalities?.input ?? [];
  return input.includes('image') || input.includes('video');
}

/** One models.dev model -> the picker's option shape. */
export function mapModelOption(model: ModelsDevModel): ModelOption {
  return {
    id: model.id,
    label: model.name && model.name !== model.id ? model.name : model.id,
    free: isFreeModel(model.cost),
    context: formatContext(model.limit?.context),
    tools: model.tool_call === true,
    vision: supportsVision(model),
  };
}

/** One models.dev provider -> the picker's model options, sorted by id. */
export function mapProviderModels(entry: ModelsDevEntry): ModelOption[] {
  const models = Object.values(entry.models ?? {});
  return models
    .map(mapModelOption)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Required key names for a provider, for the settings UI to surface. */
export function requiredEnvVars(entry: ModelsDevEntry): string[] {
  const env = entry.env;
  if (!env) return [];
  if (Array.isArray(env)) return env;
  return Object.keys(env);
}

/**
 * Merge models.dev data into an existing provider->models map.
 *
 * Only providers we already ship a base URL for are touched: a model catalog
 * for a provider the app cannot call would be a lie in the picker. Existing
 * entries are replaced only when models.dev has a strictly larger set.
 *
 * Returns which ids changed so callers can log it.
 */
export function mergeProviderModels(
  existing: Map<string, ModelOption[]>,
  payload: ModelsDevPayload,
): { updated: string[]; skipped: string[] } {
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const [id, entry] of Object.entries(payload)) {
    const current = existing.get(id);
    if (!current) {
      skipped.push(id);
      continue;
    }
    const incoming = mapProviderModels(entry);
    if (incoming.length <= current.length) continue;
    existing.set(id, incoming);
    updated.push(id);
  }

  return { updated, skipped };
}

/**
 * Fetch the catalog. Hard-bounded: a hanging CorsProxy chain must never stall
 * startup, so the abort signal is raced against a wall-clock timer.
 */
export async function fetchModelsDev(timeoutMs = 8000): Promise<ModelsDevPayload | null> {
  try {
    const { corsProxy } = await import('./CorsProxy');
    const res = await Promise.race([
      corsProxy.fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('models.dev fetch timed out')), timeoutMs),
      ),
    ]);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as ModelsDevPayload;
  } catch {
    return null;
  }
}