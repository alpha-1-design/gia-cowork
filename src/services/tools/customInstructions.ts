import { z } from 'zod';
import { useGiaStore } from '../../store/useGiaStore';
import { defineTool } from './defineTool';

export const customInstructionTools = [
  defineTool({
    id: 'custom_instructions_list',
    name: 'custom_instructions_list',
    description: 'List all custom instructions currently configured for GIA.',
    execute: async () => {
      const store = useGiaStore.getState();
      const instructions = store.customInstructions;
      if (!instructions.trim()) {
        return { success: true, content: 'No custom instructions configured yet.' };
      }
      return { success: true, content: `## Custom Instructions\n\n${instructions}` };
    },
  }),
  defineTool({
    id: 'custom_instructions_add',
    name: 'custom_instructions_add',
    description: 'Add or update a custom instruction for GIA. Overwrites existing instructions if they exist.',
    input: z.object({
      instructions: z.string().min(1).describe('The custom instruction text to set.'),
    }),
    execute: async ({ instructions }) => {
      const store = useGiaStore.getState();
      store.setCustomInstructions(instructions);
      return { success: true, content: `Custom instructions updated (${instructions.length} chars).` };
    },
  }),
  defineTool({
    id: 'custom_instructions_update',
    name: 'custom_instructions_update',
    description: 'Append or prepend text to existing custom instructions.',
    input: z.object({
      text: z.string().min(1).describe('The text to add.'),
      mode: z.enum(['append', 'prepend']).default('append').describe('Whether to append or prepend.'),
    }),
    execute: async ({ text, mode }) => {
      const store = useGiaStore.getState();
      const current = store.customInstructions;
      const updated = mode === 'prepend' ? `${text}\n\n${current}` : `${current}\n\n${text}`;
      store.setCustomInstructions(updated);
      return { success: true, content: `Custom instructions ${mode === 'prepend' ? 'prepended' : 'appended'} (${updated.length} chars total).` };
    },
  }),
  defineTool({
    id: 'custom_instructions_clear',
    name: 'custom_instructions_clear',
    description: 'Clear all custom instructions.',
    execute: async () => {
      const store = useGiaStore.getState();
      store.setCustomInstructions('');
      return { success: true, content: 'All custom instructions cleared.' };
    },
  }),
];
