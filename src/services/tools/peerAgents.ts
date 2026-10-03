import { z } from 'zod';
import type { Tool, ToolContext } from './types';
import {
  PEER_AGENTS,
  detectPeerAgents,
  delegateToAgent,
  installedAgents,
  MAX_DELEGATE_OUTPUT,
} from '../agents/peerAgents';

/**
 * Delegating to the agent tools the user already has.
 *
 * The alternative — reimplementing inside GIA whatever Claude Code or Copilot
 * already do — wastes the user's time and produces worse results, because
 * those tools have been tuned against their own harnesses and this one has
 * not.
 *
 * Two tools rather than one, because the model's first question is always "is
 * this even available". `list_peer_agents` answers that with what is really on
 * the machine, not a guess from a hardcoded list.
 */

function fail(message: string) {
  return { success: false, content: '', error: message };
}

const listPeerAgentsTool: Tool = {
  id: 'list_peer_agents',
  name: 'list_peer_agents',
  description:
    'List the AI agents and editors actually installed on this machine (Claude Code, OpenCode, ' +
    'Copilot CLI, Hermes, Pi, VS Code). Call this before claiming a task cannot be done, and ' +
    'before reimplementing something one of these already does well. Each entry gives an id for ' +
    'delegate_to_agent and what that agent is good at.',
  schema: { type: 'object', properties: {}, required: [] },
  execute: async (_args, ctx?: ToolContext) => {
    try {
      ctx?.onThought?.('🔎 Checking which agents are installed…');
      const results = await detectPeerAgents();
      const present = installedAgents(results);
      if (present.length === 0) {
        return {
          success: true,
          content:
            'No peer agents are installed on this machine. Available ids were checked: ' +
            PEER_AGENTS.map(a => a.bin).join(', ') +
            '. Do the work yourself.',
        };
      }
      const lines = present.map(a =>
        `- \`${a.id}\` — ${a.name}: ${a.strength} Use: ${a.usage}`,
      );
      return {
        success: true,
        content: `${present.length} installed:\n${lines.join('\n')}`,
      };
    } catch (e: unknown) {
      return fail(`Could not detect agents: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  },
};

const delegateToAgentTool: Tool = {
  id: 'delegate_to_agent',
  name: 'delegate_to_agent',
  description:
    'Hand a scoped task to another AI agent installed on this machine and return its output. ' +
    'Use this instead of reimplementing work that agent is better at. ' +
    'The prompt must be SELF-CONTAINED — the peer agent cannot see this conversation, so include ' +
    'every file path, constraint and piece of context it needs. ' +
    'Returns the agent\'s output, truncated past ' + MAX_DELEGATE_OUTPUT + ' characters.',
  schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Agent id from list_peer_agents: claude, opencode, copilot, hermes, pi, or vscode',
      },
      prompt: {
        type: 'string',
        description: 'Complete, self-contained instructions for the other agent',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory for the delegated task',
      },
    },
    required: ['agent', 'prompt'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({
      agent: z.string().min(1).max(40),
      prompt: z.string().min(1).max(20000),
      cwd: z.string().max(2000).optional(),
    });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('delegate_to_agent needs an agent and a prompt.');
    const { agent: agentId, prompt, cwd } = parsed.data;

    const agent = PEER_AGENTS.find(a => a.id === agentId);
    if (!agent) {
      return fail(`Unknown agent "${agentId}". Known ids: ${PEER_AGENTS.map(a => a.id).join(', ')}.`);
    }

    // Check before running. Detecting first means an unavailable agent returns
    // "not installed" instead of a confusing shell exit code from the tool call.
    const detection = await detectPeerAgents(cwd);
    const found = detection.find(d => d.agent.id === agentId);
    if (!found?.installed) {
      return fail(
        `${agent.name} is not installed (or not on PATH) on this machine. ` +
        `Check with list_peer_agents, or do the work yourself.`,
      );
    }

    try {
      ctx?.onThought?.(`🤝 Delegating to ${agent.name}…`);
      const res = await delegateToAgent(agent, prompt, cwd, 300_000);
      if (!res.ok) {
        return {
          success: false,
          content: res.output,
          error: `${agent.name} exited ${res.exitCode}.`,
        };
      }
      ctx?.onThought?.(`✅ ${agent.name} finished`);
      return {
        success: true,
        content: `${agent.name} output:\n${res.output}`,
      };
    } catch (e: unknown) {
      return fail(`Delegation failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  },
};

export const peerAgentTools: Tool[] = [listPeerAgentsTool, delegateToAgentTool];