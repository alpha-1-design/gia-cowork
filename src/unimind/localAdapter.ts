import LocalLLMService, { LOCAL_LLM_MODELS, type LocalModelId } from '../services/LocalLLMService';
import { learningLoop, type LoopContext, type LoopTrace } from './learningLoop';
import type { LoopConfig } from './types';

// Builds a model-agnostic `generate` callback backed by the loaded LOCAL model.
// The loop core never imports a provider — this adapter is the only place
// that knows about LocalLLMService, so the "self-learning loop" stays bound
// to on-device models as required, without leaking that coupling into core.
export function localModelGenerate(): (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string> {
  return async (prompt, opts) => {
    const res = await LocalLLMService.generate({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      signal: opts?.signal,
    });
    return res.text;
  };
}

export interface RunLocalLoopOpts {
  modelRef?: LocalModelId;
  cfg?: Partial<LoopConfig>;
  act?: LoopContext['act'];
  onIteration?: LoopContext['onIteration'];
}

/**
 * Run the autonomous learning loop on the local model.
 * Auto-loads the requested (or currently loaded, or recommended) model first.
 */
export async function runLocalLearningLoop(task: string, opts?: RunLocalLoopOpts): Promise<LoopTrace> {
  const model = opts?.modelRef || LocalLLMService.getLoadedModel() || LOCAL_LLM_MODELS[1].id;
  if (!LocalLLMService.isLoaded() || LocalLLMService.getLoadedModel() !== model) {
    await LocalLLMService.loadModel(model);
  }
  return learningLoop.run(
    {
      task,
      modelRef: model,
      generate: localModelGenerate(),
      act: opts?.act,
      onIteration: opts?.onIteration,
    },
    opts?.cfg,
  );
}
