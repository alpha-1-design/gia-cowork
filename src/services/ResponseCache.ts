interface CacheEntry {
  response: string;
  model: string;
  provider: string;
  timestamp: number;
  ttl: number;
}

interface CacheKey {
  prompt: string;
  model: string;
  provider: string;
  systemPrompt?: string;
}

/**
 * Collision-free cache key. The old implementation folded the key down to a
 * 32-bit rolling hash, which meant two different prompts could map to the
 * same slot and one could be served for the other — and slicing the prompt
 * to 500 chars made any two long prompts sharing a prefix collide even when
 * the hash itself hadn't. JSON.stringify of the full field tuple is injective
 * (JSON escaping is deterministic), so distinct keys can never collide.
 */
function keyOf(key: CacheKey): string {
  return JSON.stringify([key.prompt, key.model, key.provider, key.systemPrompt ?? null]);
}

class ResponseCache {
  private static instance: ResponseCache;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private _maxEntries = 200;
  private _defaultTTL = 30 * 60 * 1000;

  static getInstance() {
    if (!this.instance) this.instance = new ResponseCache();
    return this.instance;
  }

  get maxEntries() { return this._maxEntries; }
  set maxEntries(n: number) { this._maxEntries = n; }

  get defaultTTL() { return this._defaultTTL; }
  set defaultTTL(ms: number) { this._defaultTTL = ms; }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  get(key: CacheKey): string | null {
    const k = keyOf(key);
    const entry = this.memoryCache.get(k);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.memoryCache.delete(k);
      return null;
    }
    return entry.response;
  }

  set(key: CacheKey, response: string, ttl?: number): void {
    if (this.memoryCache.size >= this._maxEntries) {
      // Evict the oldest entry (earliest timestamp; ties resolved by
      // insertion order, so the first-inserted entry goes first). Never
      // evict the slot we're about to write.
      const incoming = keyOf(key);
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, entry] of this.memoryCache) {
        if (k !== incoming && entry.timestamp < oldestTs) {
          oldestTs = entry.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) this.memoryCache.delete(oldestKey);
    }
    this.memoryCache.set(keyOf(key), {
      response,
      model: key.model,
      provider: key.provider,
      timestamp: Date.now(),
      ttl: ttl ?? this._defaultTTL,
    });
  }

  invalidate(provider?: string, model?: string): void {
    if (!provider && !model) {
      this.memoryCache.clear();
      return;
    }
    for (const [k, entry] of this.memoryCache) {
      if (provider && entry.provider === provider) this.memoryCache.delete(k);
      else if (model && entry.model === model) this.memoryCache.delete(k);
    }
  }

  size(): number {
    return this.memoryCache.size;
  }

  stats(): { size: number; oldest: number | null; newest: number | null } {
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const entry of this.memoryCache.values()) {
      if (oldest === null || entry.timestamp < oldest) oldest = entry.timestamp;
      if (newest === null || entry.timestamp > newest) newest = entry.timestamp;
    }
    return { size: this.memoryCache.size, oldest, newest };
  }
}

export default ResponseCache.getInstance();
