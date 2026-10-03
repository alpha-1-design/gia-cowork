import { describe, it, expect, beforeEach, vi } from 'vitest';

// isTauri() false keeps the desktop-only paths out of these unit tests.
vi.mock('../../platform', () => ({ isTauri: () => false }));

import { skillAuthor } from '../SkillAuthor';
import { useGiaStore } from '../../store/useGiaStore';
import ToolRegistry from '../ToolRegistry';

const draft = {
  name: 'Weekly Report Builder',
  description: 'Use when asked for a recurring weekly summary.',
  systemPrompt: 'Collect this week\'s activity, group by project, then render a markdown summary.',
  tools: ['web_search', 'filesystem_write'],
  category: 'core' as const,
};

describe('SkillAuthor', () => {
  beforeEach(() => {
    skillAuthor.remove('gia-weekly-report-builder');
    // Clear anything a previous test left behind — a test that throws mid-way
    // would otherwise leak a skill into the next one and fail confusingly.
    for (const s of skillAuthor.list()) skillAuthor.remove(s.id);
    useGiaStore.setState({ skills: [] });
  });

  it('edits an authored skill without losing its use history', () => {
  const { skill } = skillAuthor.commit({ ...draft, name: 'Editable Skill' });
  skillAuthor.markUsed(skill.id);
  skillAuthor.markUsed(skill.id);

  const res = skillAuthor.update(skill.id, { description: 'Only for weekly summaries, never ad-hoc.' });
  expect(res.ok).toBe(true);
  expect(res.skill!.description).toBe('Only for weekly summaries, never ad-hoc.');
  // Fixing a skill should not erase the evidence of how often it has fired.
  expect(res.skill!.useCount).toBe(2);
  skillAuthor.remove(skill.id);
  void skill;
});

it('marks a user edit so a later automatic write is distinguishable', () => {
  const { skill } = skillAuthor.commit({ ...draft, name: 'Edited Skill' });
  const res = skillAuthor.update(skill.id, { description: 'changed' });
  expect(res.skill!.editedByUser).toBe(true);
  expect(res.skill!.editedAt).toBeGreaterThan(0);
  skillAuthor.remove(skill.id);
});

it('refuses to edit a skill that does not exist', () => {
  const res = skillAuthor.update('gia-nope-not-real', { description: 'x' });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/No authored skill/);
});

it('refuses to pin a tool that is not registered', () => {
  // The registry must be non-empty for validation to apply at all: with an
  // empty registry every id is passed through on purpose, so that a skill
  // authored during startup does not silently lose its tools.
  ToolRegistry.register({
    id: 'real_tool', name: 'real_tool', description: 'A real tool',
    execute: async () => ({ success: true, content: '' }),
  });
  try {
    const { skill } = skillAuthor.commit({ ...draft, name: 'Tool Guard Skill' });
    const res = skillAuthor.update(skill.id, { tools: ['real_tool', 'definitely_not_a_real_tool'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
    expect(res.error).toMatch(/definitely_not_a_real_tool/);
    skillAuthor.remove(skill.id);
  } finally {
    ToolRegistry.unregister('real_tool');
    skillAuthor.remove('gia-tool-guard-skill');
  }
});

it('accepts an edit that only uses registered tools', () => {
  ToolRegistry.register({
    id: 'real_tool', name: 'real_tool', description: 'A real tool',
    execute: async () => ({ success: true, content: '' }),
  });
  try {
    const { skill } = skillAuthor.commit({ ...draft, name: 'Tool Ok Skill' });
    const res = skillAuthor.update(skill.id, { tools: ['real_tool'] });
    expect(res.ok).toBe(true);
    expect(res.skill!.tools).toEqual(['real_tool']);
    skillAuthor.remove(skill.id);
  } finally {
    ToolRegistry.unregister('real_tool');
    skillAuthor.remove('gia-tool-ok-skill');
  }
});

it('rejects an edit that strips the name', () => {
  const { skill } = skillAuthor.commit({ ...draft, name: 'Named Skill' });
  const res = skillAuthor.update(skill.id, { name: '   ' });
  expect(res.ok).toBe(false);
  skillAuthor.remove(skill.id);
});

it('commits a draft into a real skill with a usable systemPrompt', () => {
    const { skill, replaced } = skillAuthor.commit(draft);
    expect(replaced).toBe(false);
    expect(skill.author).toBe('gia');
    expect(skill.systemPrompt).toContain('Collect');
    expect(skill.name).toBe('Weekly Report Builder');
  });

  it('makes the skill live in the store so it can be activated', () => {
    skillAuthor.commit(draft);
    expect(useGiaStore.getState().skills.some(s => s.id === 'gia-weekly-report-builder')).toBe(true);
  });

  it('drops unknown tool ids rather than storing phantom capabilities', () => {
    // A skill claiming a tool that does not exist would silently never fire.
    // Populate the registry so validation has a known set to check against.
    const real = ToolRegistry.get('web_search') || ({} as { id: string });
    ToolRegistry.register({ ...real, id: 'web_search', name: 'web_search', description: 'Search', execute: async () => ({ success: true, content: '' }) });
    const { skill } = skillAuthor.commit({ ...draft, tools: ['web_search', 'totally_made_up_tool'] });
    expect(skill.tools).toEqual(['web_search']);
    ToolRegistry.unregister('web_search');
  });

  it('keeps tool ids when the registry is not yet populated', () => {
    // registerAllTools() has not run, so getAll() is empty. Stripping tools
    // here would silently gut any skill authored during startup.
    expect(ToolRegistry.getAll().length).toBe(0);
    const { skill } = skillAuthor.commit({ ...draft, tools: ['web_search', 'filesystem_write'] });
    expect(skill.tools).toEqual(['web_search', 'filesystem_write']);
  });

  it('rejects a draft with no name or no systemPrompt', () => {
    expect(() => skillAuthor.commit({ ...draft, name: '  ' })).toThrow(/name/i);
    expect(() => skillAuthor.commit({ ...draft, systemPrompt: '' })).toThrow(/systemPrompt/i);
  });

  it('updates rather than duplicating when the same skill is re-authored', () => {
    skillAuthor.commit(draft);
    const { skill, replaced } = skillAuthor.commit({ ...draft, systemPrompt: 'Improved approach.' });
    expect(replaced).toBe(true);
    expect(skill.systemPrompt).toBe('Improved approach.');
    expect(skillAuthor.list().filter(s => s.id === skill.id)).toHaveLength(1);
  });

  it('preserves usage count across an improvement', () => {
    const first = skillAuthor.commit(draft);
    first.skill.useCount = 7;
    const second = skillAuthor.commit({ ...draft, systemPrompt: 'v2' });
    expect(second.skill.useCount).toBe(7);
  });

  it('removes a skill from both the author store and the live store', () => {
    skillAuthor.commit(draft);
    skillAuthor.remove('gia-weekly-report-builder');
    expect(skillAuthor.list()).toHaveLength(0);
    expect(useGiaStore.getState().skills.some(s => s.id === 'gia-weekly-report-builder')).toBe(false);
  });

  it('produces an empty prompt block when nothing is authored', () => {
    expect(skillAuthor.getPromptBlock('anything')).toBe('');
  });

  it('includes a relevant authored skill in the prompt block', () => {
    skillAuthor.commit(draft);
    // Retrieval is query-driven now: a matching question surfaces the skill.
    const block = skillAuthor.getPromptBlock('build the weekly summary report');
    expect(block).toContain('Weekly Report Builder');
    expect(block).toContain('web_search');
  });

  it('does not dump every skill into an unrelated prompt', () => {
    skillAuthor.commit(draft);
    // The blanket-injection version leaked this skill into every message.
    expect(skillAuthor.getPromptBlock('what should I have for dinner')).toBe('');
  });

  it('slugifies names into stable ids', () => {
    const { skill } = skillAuthor.commit({ ...draft, name: 'My Fancy Skill!! v2' });
    expect(skill.id).toBe('gia-my-fancy-skill-v2');
  });
});