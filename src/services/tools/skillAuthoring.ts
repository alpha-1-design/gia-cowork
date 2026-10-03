import { z } from 'zod';
import { defineTool } from './defineTool';
import { skillAuthor } from '../SkillAuthor';

/**
 * Skill-authoring tools — this is GIA's learning loop.
 *
 * She can distil a task she just solved into a reusable skill, list the ones
 * she has written, and drop the ones that stopped being useful. Skills she
 * authors are injected into future system prompts, so this is how she
 * actually gets better at the user's recurring work over time.
 */
export const skillAuthoringTools = [
  defineTool({
    id: 'skill_author',
    name: 'skill_author',
    description:
      'Write a reusable skill from a task you just completed, so you can apply the same approach again next time. Use this AFTER solving something non-trivial and repeatable — not for one-off tasks. Re-running with the same name improves that skill rather than duplicating it.',
    input: z.object({
      taskSummary: z.string().min(1).describe('What the task was, in one or two sentences.'),
      whatWorked: z.string().min(1).describe('The approach that worked — the concrete steps, in order, including what to avoid.'),
    }),
    execute: async ({ taskSummary, whatWorked }) => {
      try {
        const skill = await skillAuthor.authorFromExperience(taskSummary, whatWorked);
        const toolLine = skill.tools.length ? skill.tools.join(', ') : 'no specific tools';
        return {
          success: true,
          content: `Authored or improved skill "${skill.name}" (id: ${skill.id}).\nWhen to use: ${skill.description}\nTools: ${toolLine}\n\nIt will be applied automatically in future sessions. Tell the user you learned this.`,
        };
      } catch (e) {
        return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),

  defineTool({
    id: 'skill_author_write',
    name: 'skill_author_write',
    description:
      'Write a skill directly, without the reflection step. Use when you already know exactly what the skill should say. Tool ids are validated — unknown ones are dropped.',
    input: z.object({
      name: z.string().min(1).describe('Short, memorable name (2-4 words).'),
      description: z.string().min(1).describe('One sentence: when to use this skill.'),
      systemPrompt: z.string().min(1).describe('Procedural instructions for applying the skill.'),
      tools: z.array(z.string()).optional().describe('Exact tool ids this skill relies on.'),
      category: z.enum(['core', 'user', 'dev', 'creative']).optional().describe('Skill category.'),
    }),
    execute: async ({ name, description, systemPrompt, tools, category }) => {
      try {
        const { skill, replaced } = skillAuthor.commit({ name, description, systemPrompt, tools, category });
        return {
          success: true,
          content: `${replaced ? 'Updated' : 'Authored'} skill "${skill.name}" (id: ${skill.id}). Tools: ${skill.tools.join(', ') || 'none'}.`,
        };
      } catch (e) {
        return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),

  defineTool({
    id: 'skill_authored_list',
    name: 'skill_authored_list',
    description: 'List the skills you have authored yourself from experience, with their tools and descriptions.',
    execute: async () => {
      const authored = skillAuthor.list();
      if (authored.length === 0) {
        return {
          success: true,
          content: 'You have not authored any skills yet. After completing a non-trivial repeatable task, use skill_author to capture the approach.',
        };
      }
      const lines = authored.map(s =>
        `- ${s.name} (id: ${s.id}) — ${s.description}\n  Tools: ${s.tools.join(', ') || 'none'}\n  Used: ${s.useCount}x${s.origin ? `\n  Learned from: ${s.origin}` : ''}`,
      );
      return { success: true, content: `## Skills you authored\n\n${lines.join('\n')}` };
    },
  }),

  defineTool({
    id: 'skill_authored_edit',
    name: 'skill_authored_edit',
    description:
      'Correct a skill you authored. Use when a skill mis-fires, encodes an approach the user rejected, or is simply wrong — a skill you cannot correct is one that will keep making the same mistake. Only pass the fields you are actually changing.',
    input: z.object({
      skillId: z.string().min(1).describe('The skill id.'),
      name: z.string().optional().describe('New name.'),
      description: z.string().optional().describe('When this skill should apply.'),
      systemPrompt: z.string().optional().describe('The instructions to follow when it applies.'),
      tools: z.array(z.string()).optional().describe('Replacement tool ids — this replaces the whole list, not a merge.'),
    }),
    execute: async ({ skillId, ...patch }) => {
      const existing = skillAuthor.list().find(s => s.id === skillId);
      if (!existing) {
        return { success: false, content: '', error: `No authored skill with id "${skillId}". Use skill_authored_list to see them.` };
      }
      const res = skillAuthor.update(skillId, patch);
      if (!res.ok) return { success: false, content: '', error: res.error ?? 'Could not update the skill.' };
      return { success: true, content: `Updated skill "${res.skill!.name}".` };
    },
  }),

  defineTool({
    id: 'skill_authored_remove',
    name: 'skill_authored_remove',
    description: 'Delete a skill you authored. Use when a skill has stopped being useful or is wrong.',
    input: z.object({
      skillId: z.string().min(1).describe('The skill id to delete.'),
    }),
    execute: async ({ skillId }) => {
      const existing = skillAuthor.list().find(s => s.id === skillId);
      if (!existing) {
        return { success: false, content: '', error: `No authored skill with id "${skillId}". Use skill_authored_list to see them.` };
      }
      skillAuthor.remove(skillId);
      return { success: true, content: `Deleted skill "${existing.name}".` };
    },
  }),
];