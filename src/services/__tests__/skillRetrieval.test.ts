import { describe, it, expect, beforeEach } from 'vitest';
import { skillAuthor, rankSkills } from '../SkillAuthor';
import { useGiaStore } from '../../store/useGiaStore';
import type { AuthoredSkill } from '../SkillAuthor';

const mk = (name: string, description: string, systemPrompt: string): AuthoredSkill => ({
  id: `gia-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  name,
  description,
  systemPrompt,
  tools: [],
  category: 'user',
  author: 'gia',
  useCount: 0,
});

describe('skill retrieval ranking', () => {
  const weekly = mk('Weekly Report', 'Build the recurring weekly summary', 'Pull activity, group by project, render markdown.');
  const email = mk('Email Triage', 'Sort and draft replies in the inbox', 'Read unread mail, categorise by urgency, draft replies.');
  const deploy = mk('Deploy Checklist', 'Ship a release safely', 'Verify tests, tag version, publish, smoke test.');

  it('ranks the on-topic skill first', () => {
    const ranked = rankSkills([weekly, email, deploy], 'draft replies to my unread inbox');
    expect(ranked[0].skill.name).toBe('Email Triage');
  });

  it('matches on the skill name over incidental body mentions', () => {
    const ranked = rankSkills([weekly, email], 'I need a weekly summary of everything');
    expect(ranked[0].skill.name).toBe('Weekly Report');
  });

  it('returns nothing when no skill is relevant', () => {
    // The old blanket injection would have dumped all three here.
    const ranked = rankSkills([weekly, email, deploy], 'what is the weather in Kumasi today');
    expect(ranked).toHaveLength(0);
  });

  it('returns nothing for an empty query or empty corpus', () => {
    expect(rankSkills([weekly], '')).toHaveLength(0);
    expect(rankSkills([], 'anything')).toHaveLength(0);
  });

  it('is stable across ranking order', () => {
    const q = 'summarise the week';
    const a = rankSkills([weekly, email, deploy], q).map(r => r.skill.id);
    const b = rankSkills([deploy, weekly, email], q).map(r => r.skill.id);
    expect(a).toEqual(b);
  });

  it('handles inflected forms of the same term', () => {
    const ranked = rankSkills([weekly], 'summarizing weekly activity');
    expect(ranked.length).toBeGreaterThan(0);
  });
});

describe('skillAuthor prompt block', () => {
  beforeEach(() => {
    useGiaStore.setState({ skills: [] });
    for (const s of ['weekly-report', 'email-triage']) skillAuthor.remove(`gia-${s}`);
  });

  it('surfaces only relevant skills for a query', () => {
    skillAuthor.commit({
      name: 'Weekly Report',
      description: 'Build the recurring weekly summary',
      systemPrompt: 'Pull activity, group by project, render markdown.',
      category: 'user',
    });

    const block = skillAuthor.getPromptBlock('build my weekly report');
    expect(block).toContain('Weekly Report');
  });

  it('stays empty when nothing matches', () => {
    skillAuthor.commit({
      name: 'Weekly Report',
      description: 'Build the recurring weekly summary',
      systemPrompt: 'Pull activity, group by project, render markdown.',
      category: 'user',
    });
    expect(skillAuthor.getPromptBlock('what is for dinner')).toBe('');
  });

  it('stays empty with no query rather than dumping everything', () => {
    skillAuthor.commit({
      name: 'Weekly Report',
      description: 'Build the recurring weekly summary',
      systemPrompt: 'Pull activity.',
      category: 'user',
    });
    expect(skillAuthor.getPromptBlock()).toBe('');
    expect(skillAuthor.getPromptBlock('')).toBe('');
  });

  it('tracks usage when a skill is marked used', () => {
    const { skill } = skillAuthor.commit({
      name: 'Weekly Report',
      description: 'Build the recurring weekly summary',
      systemPrompt: 'Pull activity.',
      category: 'user',
    });
    skillAuthor.markUsed(skill.id);
    skillAuthor.markUsed(skill.id);
    const found = skillAuthor.list().find(s => s.id === skill.id);
    expect(found?.useCount).toBe(2);
    expect(found?.lastUsedAt).toBeGreaterThan(0);
  });
});