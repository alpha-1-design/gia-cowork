import { describe, it, expect } from 'vitest';
import { resolveSkillIcon } from '../skillIcons';

describe('resolveSkillIcon', () => {
  it('uses an explicit icon when provided', () => {
    expect(resolveSkillIcon({ id: 'a', name: 'Anything', icon: '🚀' })).toBe('🚀');
  });

  it('matches on name keywords so a skills list is scannable', () => {
    expect(resolveSkillIcon({ id: '1', name: 'Weekly Report Builder' })).toBe('📊');
    expect(resolveSkillIcon({ id: '2', name: 'Email Triage' })).toBe('📧');
    expect(resolveSkillIcon({ id: '3', name: 'Debug this crash' })).toBe('💻');
    expect(resolveSkillIcon({ id: '4', name: 'Ship the release' })).toBe('🚀');
  });

  it('prefers a keyword match over the category default', () => {
    // "design" should win over the creative category glyph.
    expect(resolveSkillIcon({ id: '1', name: 'Landing page design', category: 'creative' })).toBe('🎨');
    expect(resolveSkillIcon({ id: '2', name: 'Unrelated thing', category: 'creative' })).toBe('🎨');
  });

  it('falls back to the category icon when no keyword matches', () => {
    expect(resolveSkillIcon({ id: '1', name: 'Zzz', category: 'dev' })).toBe('🛠️');
    expect(resolveSkillIcon({ id: '2', name: 'Zzz', category: 'user' })).toBe('👤');
  });

  it('is deterministic — the same skill always gets the same icon', () => {
    const skill = { id: 'stable-skill-id', name: 'Quantum Zebra Protocol' };
    const first = resolveSkillIcon(skill);
    for (let i = 0; i < 20; i++) {
      expect(resolveSkillIcon(skill)).toBe(first);
    }
  });

  it('gives different skills different icons rather than one generic glyph', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const icons = new Set(ids.map(id => resolveSkillIcon({ id, name: 'Something' })));
    expect(icons.size).toBeGreaterThan(1);
  });

  it('never returns an empty string', () => {
    expect(resolveSkillIcon({})).toBeTruthy();
    expect(resolveSkillIcon({ id: '', name: '' })).toBeTruthy();
  });
});