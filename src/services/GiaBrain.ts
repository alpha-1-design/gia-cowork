import { logger } from '../utils/logger';
import { useProviderStore } from '../store/useProviderStore';
import { useGiaStore } from '../store/useGiaStore';
import { BrainRequest, BrainResponse } from './providers/types';
import { setSystemContext } from './buildGiaSystem';
import { selectBestModel } from './brain/modelUtils';
import { extractMemories } from './brain/memoryExtractor';
import PluginManager from './PluginManager';
import ResponseCache from './ResponseCache';
import AnalyticsTracker from './AnalyticsTracker';
import { costTracker } from './CostTracker';
import ProviderService from './ProviderService';
import ToolExecutionService from './ToolExecutionService';
import { extractToolCalls } from '../utils/jsonRepair';
import ErrorHandlingService from './ErrorHandlingService';
import CollaborativeGenerationService from './CollaborativeGenerationService';
import {
  compactIfNeeded,
  resolveActiveContextWindow,
  COMPACTION_SUMMARY_PROMPT,
  renderEvictedForSummary,
  type CompactionMessage,
} from './brain/compaction';

/**
 * Default compaction summarizer — the brain summarizes with itself: a bare
 * same-provider/same-model call, NOT GiaBrain.generate, on purpose. A
 * summary must not run the tool loop (no tools inside a summary) and must
 * not recurse into the very loop that is overflowing. compactIfNeeded has
 * already elided UNTRUSTED-CONTENT payloads from the slice before this sees
 * it (see brain/compaction.ts) — that is the safety-critical step, so this
 * rendering must never bypass it.
 */
function makeCompactionSummarizer(providerId: string, model: string, signal?: AbortSignal) {
  return async (evicted: CompactionMessage[]): Promise<string> => {
    const res = await ProviderService.callProvider(
      {
        prompt: `${COMPACTION_SUMMARY_PROMPT}\n\n${renderEvictedForSummary(evicted)}`,
        // A focused system prompt, NOT the full buildGiaSystem persona: a
        // summary needs neither the 90KB tool catalog nor the persona voice,
        // and the governor's budget belongs to real work, not bookkeeping.
        // 'replace' is required — the default 'append' mode still builds the
        // full persona and merely appends to it.
        systemPrompt:
          'You are the context-compaction summarizer inside the GIA agent. Produce only the summary requested; no tool calls, no questions to the user.',
        systemPromptMode: 'replace',
        modelOverride: model,
        temperature: 0.3,
        maxTokens: 1024,
        signal,
      },
      providerId,
    );
    // REVIEW-2 S3-19: compaction spend must be visible. The summarizer goes
    // around GiaBrain's accounting choke point (it calls ProviderService
    // directly), so it records its own usage here — tagged to the session
    // with a compaction marker so per-lane cost reads stay honest.
    if (res.tokenUsage) {
      costTracker.record(
        providerId,
        model,
        res.tokenUsage.input || 0,
        res.tokenUsage.output || 0,
        `compaction:${useGiaStore.getState().activeSessionId || 'unknown'}`,
      );
    }
    return res.text;
  };
}

export { setSystemContext };
export type { BrainRequest, BrainResponse } from './providers/types';

class GiaBrain {
  private static instance: GiaBrain;
  static getInstance() { if (!this.instance) this.instance = new GiaBrain(); return this.instance; }

  async generate(req: BrainRequest): Promise<BrainResponse> {
    const { activeProvider, providers } = useProviderStore.getState();
    const state = useGiaStore.getState();
    const effectiveProvider = req.providerId || activeProvider;
    const config = providers[effectiveProvider];

    if (state.responseCache && !req.onStream) {
      const cached = ResponseCache.get({ prompt: req.prompt, model: config.model, provider: effectiveProvider, systemPrompt: req.systemPrompt });
      if (cached) {
        logger.log('[GiaBrain] Cache hit');
        return { text: cached, provider: effectiveProvider, model: config.model };
      }
    }

    const needsVision = !!(req.images && req.images.length > 0);
    const selection = selectBestModel(effectiveProvider, req.modelOverride || config.model, needsVision);
    const finalModel = selection.model;

    if (selection.switched && !req.modelOverride) {
      useProviderStore.getState().setProviderModel(effectiveProvider, finalModel);
      useGiaStore.getState().addNotification(selection.reason || `Switched to ${finalModel}`);
    }

    let currentPrompt = await PluginManager.runBeforeGenerate(req.prompt);
    const history = req.history ? [...req.history] : [];
    let iterations = 0;
    const maxIterations = 10;
    let clarificationAttempts = 0;
    const sourcesAcc: string[] = [];
    const genStartTime = performance.now();
    let carryOverText = '';

    while (iterations < maxIterations) {
      iterations++;

      // ── Context compaction (W11) — measured against the ACTIVE model's
      //    real window (resolveCapabilities), not a settings slider. The
      //    loop below grows `history` with tool output without bound, and
      //    the chat path's autoSummarizeIfNeeded only runs once per user
      //    turn, before this loop — so a long agentic task overflowed the
      //    window mid-loop with nothing to catch it. Compacting here covers
      //    every seam that runs through generate(): chat AND every
      //    SwarmCoordinator lane (the swarm executor delegates to this call).
      //    In-place splice: toolRunner's ExecutionState holds the same array
      //    reference, so both stay in step.
      // S3-20: measure the window of the model ACTUALLY selected (finalModel
      // may differ from the store's when selectBestModel auto-switched).
      const compaction = await compactIfNeeded(history, resolveActiveContextWindow(effectiveProvider, finalModel), {
        summarize: makeCompactionSummarizer(effectiveProvider, finalModel, req.signal),
        onNotice: (notice) => req.onThought?.(notice),
      });
      if (compaction.compacted) {
        history.length = 0;
        // compactIfNeeded only reinserts roles that came from the request
        // history (user/assistant) plus its own 'user' summary marker; a
        // leading system message is preserved verbatim only if the caller
        // supplied one, which BrainRequest.history never does.
        for (const m of compaction.history) history.push(m as (typeof history)[number]);
      }

      const loopReq: BrainRequest = { ...req, prompt: currentPrompt, history };
      let res: BrainResponse | undefined;
      const callStart = performance.now();

      try {
        res = await ProviderService.callProvider(loopReq, effectiveProvider);
      } catch (e: unknown) {
        const errorResult = await ErrorHandlingService.handleErrors(e, loopReq, effectiveProvider, finalModel, callStart, carryOverText, iterations, history);
        res = errorResult.res;
        carryOverText = errorResult.carryOverText;
        if (!res) continue;
      }

      const text = res!.text;
      if (req.onThought) {
        // Feed only the PRE-TOOL prefix as a thought trail. For a plain answer
        // (no tool call) the same text already streamed via onStream — sending
        // the whole answer through onThought too created a 'thinking' segment
        // duplicating the visible reply.
        const toolCallRegex = /(<tool_code>|<tool-code>|<function_call>|<function-call>)/;
        const match = text.match(toolCallRegex);
        const thought = match ? text.substring(0, match.index).trim() : '';
        if (thought) {
          req.onThought(thought);
        }
      }

      // Emit tool execution status so the user sees what GIA is doing.
      // Single-sourced from the parser (utils/jsonRepair.ts): the executor
      // (toolRunner.ts) runs extractToolCalls, so the announce must cover
      // exactly the same formats — quoted AND unquoted ids inside ```tool
      // fences, ```json fences, and the XML tag variants — or a call in an
      // unannounced format would execute unenforced (SwarmCoordinator's
      // allow-list enforcement listens for this announce). Deduped by id:
      // the same tool announced once is still a policy trip if disallowed.
      if (req.onThought) {
        const announced = new Set<string>();
        for (const tc of extractToolCalls(text)) {
          if (announced.has(tc.id)) continue;
          announced.add(tc.id);
          req.onThought(`⚙️ Executing ${tc.id}...`);
        }
      }

      const toolState = { history, currentPrompt, clarificationAttempts };
      const toolResult = await ToolExecutionService.execute(text, toolState, req.onThought, req.signal, sourcesAcc, req.messageId);

      currentPrompt = toolState.currentPrompt;
      clarificationAttempts = toolState.clarificationAttempts;

      // Emit tool completion status
      if (req.onThought && toolResult.didExecute) {
        req.onThought(`✅ Tools completed — generating response...`);
      }

      if (!toolResult.didExecute) {
        extractMemories(req.prompt, text).catch((e) => logger.error('[GiaBrain] Memory extraction failed:', e));
        AnalyticsTracker.trackGenerationComplete(finalModel, res.tokenUsage?.output || 0, Math.round(performance.now() - genStartTime), !!toolResult.didExecute, true);
        if (state.responseCache && !req.onStream) {
          ResponseCache.set({ prompt: req.prompt, model: finalModel, provider: effectiveProvider, systemPrompt: req.systemPrompt }, text);
        }
        if (res.tokenUsage?.total) {
          useProviderStore.getState().deductTokens(effectiveProvider, res.tokenUsage.total);
        }
        // Single accounting choke point: every completed generation lands
        // here, so no provider path can bypass spend tracking.
        if (res.tokenUsage) {
          costTracker.record(
            effectiveProvider,
            finalModel,
            res.tokenUsage.input || 0,
            res.tokenUsage.output || 0,
            req.costTag ?? (useGiaStore.getState().activeSessionId || 'unknown'),
          );
        }
        const finalResponse = await PluginManager.runAfterGenerate({ text, provider: effectiveProvider, model: finalModel });
        return { ...finalResponse, provider: effectiveProvider, sources: sourcesAcc.length > 0 ? sourcesAcc : undefined, finishReason: res.finishReason, wasTruncated: res.wasTruncated, tokenUsage: res.tokenUsage };
      }

      if (toolResult.result === '__CLARIFICATION__') {
        return { text: '__CLARIFICATION__', provider: effectiveProvider, model: finalModel };
      }

      if (toolResult.result === 'malformed_json') {
        currentPrompt = `Your previous response had invalid JSON in a tool block. Fix the syntax and try again.`;
        continue;
      }

      if (toolResult.result === 'truncated_tool_call') {
        // currentPrompt was already set specifically by toolRunner above via
        // toolState.currentPrompt -> currentPrompt at line 83; don't clobber it.
        continue;
      }
    }
    throw new Error('Max agentic iterations reached.');
  }

  async generateCollaborative(req: BrainRequest, onProviderStatus?: (status: { provider: string; model: string; status: 'thinking' | 'responding' | 'done' | 'error' }) => void): Promise<BrainResponse> {
    return CollaborativeGenerationService.generate(req, onProviderStatus);
  }
}

export default GiaBrain.getInstance();
