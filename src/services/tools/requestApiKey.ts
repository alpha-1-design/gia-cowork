import { z } from 'zod';
import { useGiaStore } from '../../store/useGiaStore';
import { defineTool } from './defineTool';

const requestApiKeyTool = defineTool({
  id: 'request_api_key',
  name: 'request_api_key',
  description: 'Request the user to provide an API key for a specific service. This will show an input panel at the bottom of the chat where they can enter and save the key securely.',
  input: z.object({
    providerId: z.string().min(1).describe('The provider ID (e.g., "openai", "anthropic", "google") that needs the API key'),
    description: z.string().default('API key required').describe('A brief description of what the API key is for'),
  }),
  execute: async ({ providerId, description }) => {
    useGiaStore.getState().setPendingApiKeyRequest({ providerId, description });
    return {
      success: true,
      content: `I need the ${providerId} API key to proceed. I've opened an input panel at the bottom of the chat. Please enter the key there and click Save, then tell me "done" or "continue" and I'll pick up from where I left off.`,
    };
  },
});

export const requestApiKeyTools = [requestApiKeyTool];
