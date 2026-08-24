import { logger } from '../utils/logger';

// ── HuggingFace Hub ──────────────────────────────────────────────────

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag?: string;
}

export async function validateHfToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('https://huggingface.co/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch (e) {
    logger.warn('[modelHub] HF token validation failed', e);
    return false;
  }
}

export async function searchHuggingFaceModels(
  query: string,
  token?: string,
  limit = 40,
): Promise<HfModel[]> {
  const params = new URLSearchParams({ limit: String(limit), sort: 'downloads', direction: '-1' });
  if (query) params.set('search', query);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://huggingface.co/api/models?${params.toString()}`, { headers });
  if (!res.ok) throw new Error(`HuggingFace API ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data.map((m) => ({
    id: (m.id as string) || (m.modelId as string) || '',
    downloads: (m.downloads as number) || 0,
    likes: (m.likes as number) || 0,
    pipeline_tag: m.pipeline_tag as string | undefined,
  }));
}

// ── Ollama ───────────────────────────────────────────────────────────

export interface OllamaModel {
  name: string;
  size?: number;
  digest?: string;
}

export async function listOllamaModels(base = 'http://localhost:11434'): Promise<OllamaModel[]> {
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string; size?: number; digest?: string }> };
  return (data.models || []).map((m) => ({ name: m.name, size: m.size, digest: m.digest }));
}

export async function searchOllamaLibrary(query: string): Promise<string[]> {
  const res = await fetch(`https://ollama.com/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Ollama library ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  return (data.models || []).map((m) => m.name);
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
  percent: number;
}

export async function pullOllamaModel(
  name: string,
  onProgress: (p: PullProgress) => void,
  base = 'http://localhost:11434',
): Promise<void> {
  const res = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama pull ${res.status}`);
  if (!res.body) throw new Error('Ollama pull returned no stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { status?: string; completed?: number; total?: number };
        const completed = j.completed || 0;
        const total = j.total || 0;
        onProgress({
          status: j.status || '',
          completed,
          total,
          percent: total ? Math.round((completed / total) * 100) : 0,
        });
      } catch {
        /* ignore malformed keepalive lines */
      }
    }
  }
}
