import { describe, it, expect } from 'vitest';
import { VoiceAnnouncer, announcementFor } from '../VoiceAnnouncer';

describe('announcementFor — the whitelist', () => {
  it('speaks tool execution as a human phrase', () => {
    const a = announcementFor('⚙️ Executing web_search...');
    expect(a?.phrase).toBe('Searching the web.');
    expect(a?.activity).toBe('Searching the web');
  });

  it('speaks parallel groups and completions', () => {
    expect(announcementFor('⚡ Running 3 tools in parallel...')?.phrase).toBe('Running 3 steps in parallel.');
    expect(announcementFor('✅ Tools completed — generating response...')?.phrase).toBe('Done checking. One moment.');
  });

  it('speaks sub-agent spawns and compliance blocks', () => {
    expect(announcementFor('Spawning 4 sub-agents in parallel...')?.phrase).toBe('Handing this to 4 agents in parallel.');
    expect(announcementFor('🛑 Blocked: filesystem_write breaks strict mode rules')?.phrase).toContain('stopped it');
  });

  it('stays silent on thought prose and observations', () => {
    expect(announcementFor('Let me think about which file handles routing.')).toBeNull();
    expect(announcementFor('I found three references to this function.')).toBeNull();
    expect(announcementFor('')).toBeNull();
  });

  it('unknown tools degrade to a de-underscored id, never raw', () => {
    const a = announcementFor('⚙️ Executing custom_widget_lookup...');
    expect(a?.phrase).toBe('Using custom widget lookup.');
  });
});

describe('VoiceAnnouncer — anti-drowning rules', () => {
  it('rate-limits announcements to the min gap', () => {
    const a = new VoiceAnnouncer();
    expect(a.onThought('⚙️ Executing web_search...')).not.toBeNull();
    // immediately following announcements are swallowed
    expect(a.onThought('⚙️ Executing filesystem_read...')).toBeNull();
  });

  it('caps the number of announcements per turn', () => {
    const a = new VoiceAnnouncer();
    let spoken = 0;
    //advance clock by mocking Date.now
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake;
    try {
      for (let i = 0; i < 15; i++) {
        fake += 7000; // past the min gap every time
        if (a.onThought('⚙️ Executing web_search...')) spoken++;
      }
    } finally {
      Date.now = realNow;
    }
    expect(spoken).toBeLessThanOrEqual(10);
  });

  it('tracks the current activity for the UI strip', () => {
    const a = new VoiceAnnouncer();
    a.onThought('⚙️ Executing filesystem_write...');
    expect(a.activity).toBe('Writing a file');
    a.reset();
    expect(a.activity).toBe('');
  });
});
