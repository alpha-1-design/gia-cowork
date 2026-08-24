import { LoopConfig, SAFE_LOOP } from './types';
import { logger } from '../utils/logger';

// ── Model-agnostic autonomous learning loop ─────────────────────────
//
// This is the "leave GIA running on a task" engine. It is deliberately
// provider-agnostic: it never imports a specific LLM SDK. The caller
// injects a `generate` callback wired to whatever model is active
// (local transformers.js, Ollama, OpenRouter, …). That keeps the loop
// from locking you behind any one model.
//
// It is also bounded: a max iteration count and stall detection stop a
// loop that stops making progress, so a fragile local model can't spin
// forever and burn RAM. Each run accumulates a `trace` — the agent's own
// memory of what it tried — and past traces for the same task are fed
// back in, which is the "self-learning" part.

export interface LoopIteration {
  index: number;
  thought: string;
  action?: string;
  result?: string;
  ts: string;
}

export interface LoopTrace {
  task: string;
  modelRef?: string;
  iterations: LoopIteration[];
  startedAt: string;
  finishedAt?: string;
  haltedReason?: string;
}

export interface LoopContext {
  task: string;
  modelRef?: string;
  /** Model call — injected so the loop stays provider-agnostic. */
  generate: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;
  /** Optional real action step (tool/agent call). Result is recorded into the trace. */
  act?: (thought: string, iteration: number) => Promise<string> | string;
  onIteration?: (info: LoopIteration) => void;
}

const traceMemory = new Map<string, LoopTrace[]>();

function taskKey(task: string): string {
  return task.toLowerCase().replace(/\s+/g, '').slice(0, 64) || 'default';
}

function buildPrompt(task: string, trace: LoopTrace): string {
  const past = traceMemory.get(taskKey(task)) || [];
  const pastLearn = past
    .slice(-3)
    .map((t, i) => `Previous attempt ${i + 1} (${t.iterations.length} steps, ended: ${t.haltedReason || 'complete'}):\n${t.iterations.map((it) => `- ${it.thought.slice(0, 160)}`).join('\n')}`)
    .join('\n\n');

  const history = trace.iterations
    .map((it, i) => {
      let line = `Step ${i + 1}: ${it.thought.slice(0, 400)}`;
      if (it.action) line += `\n  → acted: ${it.action.slice(0, 200)}`;
      if (it.result) line += `\n  → result: ${it.result.slice(0, 200)}`;
      return line;
    })
    .join('\n');

  return [
    `You are an autonomous learning agent. Task: ${task}`,
    pastLearn ? `\nWhat you learned from past attempts on this task:\n${pastLearn}\n` : '',
    `\nSteps you have already taken:\n${history || '(none yet)'}`,
    '\nReflect on progress. Then either (a) take the next concrete action toward the task, or (b) if the task is complete, say "DONE". Be specific and build on prior steps.',
  ].join('\n');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export class LearningLoop {
  private abort: AbortController | null = null;

  get running(): boolean {
    return this.abort !== null && !this.abort.signal.aborted;
  }

  stop(): void {
    this.abort?.abort();
  }

  async run(ctx: LoopContext, cfgInput?: Partial<LoopConfig>): Promise<LoopTrace> {
    const cfg: LoopConfig = { ...SAFE_LOOP, ...cfgInput, enabled: true };
    const trace: LoopTrace = {
      task: ctx.task,
      modelRef: ctx.modelRef,
      iterations: [],
      startedAt: new Date().toISOString(),
    };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let lastSignature = '';

    for (let i = 0; i < cfg.maxIterations; i++) {
      if (signal.aborted) {
        trace.haltedReason = 'aborted';
        break;
      }

      let thought = '';
      try {
        thought = await ctx.generate(buildPrompt(ctx.task, trace), { signal });
      } catch (e) {
        if (signal.aborted) {
          trace.haltedReason = 'aborted';
        } else {
          trace.haltedReason = `error: ${e instanceof Error ? e.message : 'unknown'}`;
          logger.error('[LearningLoop] generate failed', e);
        }
        break;
      }

      if (/^\s*done\b/i.test(thought)) {
        const iter: LoopIteration = { index: i, thought: 'DONE', ts: new Date().toISOString() };
        trace.iterations.push(iter);
        ctx.onIteration?.(iter);
        trace.haltedReason = 'task marked complete';
        break;
      }

      const iter: LoopIteration = { index: i, thought, ts: new Date().toISOString() };

      if (ctx.act) {
        try {
          iter.action = thought.slice(0, 400);
          iter.result = String(await ctx.act(thought, i));
        } catch (e) {
          iter.result = `action error: ${e instanceof Error ? e.message : 'unknown'}`;
        }
      }

      trace.iterations.push(iter);
      ctx.onIteration?.(iter);

      // Stall guard: if the model keeps repeating itself, stop.
      const sig = thought.slice(0, 200);
      if (cfg.haltOnStall && sig === lastSignature) {
        trace.haltedReason = 'stall detected — no new progress';
        break;
      }
      lastSignature = sig;

      if (cfg.intervalMs > 0) {
        try {
          await delay(cfg.intervalMs, signal);
        } catch {
          trace.haltedReason = 'aborted';
          break;
        }
      }
    }

    trace.finishedAt = new Date().toISOString();

    // Persist the trace so future runs on the same task start smarter.
    const key = taskKey(ctx.task);
    const prev = traceMemory.get(key) || [];
    prev.push(trace);
    traceMemory.set(key, prev.slice(-10));

    return trace;
  }
}

export const learningLoop = new LearningLoop();
