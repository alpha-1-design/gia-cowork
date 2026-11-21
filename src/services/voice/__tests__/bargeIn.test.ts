import { describe, it, expect } from 'vitest';
import { isStopKeyword, normalizeUtterance, routeUtterance } from '../bargeIn';

describe('barge-in keyword gate', () => {
  it('matches bare keywords and keyword+name forms', () => {
    expect(isStopKeyword('Stop')).toBe('stop');
    expect(isStopKeyword('quiet!')).toBe('quiet');
    expect(isStopKeyword('hey gia stop')).toBe(null); // 'gia stop' form is matched, not 'hey gia stop'... see below
    expect(isStopKeyword('gia stop')).toBe('stop');
    expect(isStopKeyword('stop gia')).toBe('stop');
    expect(isStopKeyword('wait, hold on')).toBe(null); // two keywords = not the keyword alone
  });

  it('does not stop on keyword-containing sentences', () => {
    expect(isStopKeyword('stop at the store')).toBeNull();
    expect(isStopKeyword('I want to wait for the bus')).toBeNull();
    expect(isStopKeyword('')).toBeNull();
  });

  it('normalizes punctuation and case', () => {
    expect(normalizeUtterance('  Stop!!! ')).toBe('stop');
    expect(normalizeUtterance("don't stop")).toBe("don't stop");
  });
});

describe('routeUtterance — the escalation ladder', () => {
  it('keywords interrupt in every busy phase', () => {
    for (const phase of ['speaking', 'thinking', 'transcribing'] as const) {
      const r = routeUtterance('stop', phase);
      expect(r).toEqual({ action: 'interrupt', keyword: 'stop' });
    }
  });

  it('keywords with nothing to stop are ignored, not turned into turns', () => {
    expect(routeUtterance('stop', 'listening')).toEqual({ action: 'ignore', reason: 'nothing-to-stop' });
    expect(routeUtterance('stop', 'capturing')).toEqual({ action: 'ignore', reason: 'nothing-to-stop' });
  });

  it('non-keyword speech while she works becomes steering', () => {
    const r = routeUtterance('actually use the cached file', 'thinking');
    expect(r).toEqual({ action: 'steer', text: 'actually use the cached file' });
  });

  it('non-keyword speech while she talks is parked, never trusted mid-speech', () => {
    const r = routeUtterance('and then check the tests', 'speaking');
    expect(r).toEqual({ action: 'park', text: 'and then check the tests' });
  });

  it('empty transcripts are ignored', () => {
    expect(routeUtterance('   ', 'speaking')).toEqual({ action: 'ignore', reason: 'empty' });
    expect(routeUtterance('   ', 'thinking')).toEqual({ action: 'ignore', reason: 'empty' });
  });
});
