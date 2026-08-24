import { z } from 'zod';
import adaptiveScheduler from '../AdaptiveScheduler';
import { contextFusionEngine } from '../ContextFusionEngine';
import SmartNotificationEngine from '../SmartNotificationEngine';
import { defineTool } from './defineTool';

// ── Desktop intelligence tools ──────────────────────────────────────────
//
// Surfaces the three "always-on desktop agent" services that were built but
// never wired up: the activity-pattern scheduler, the context-fusion engine
// (proactive suggestions), and the smart-notification triage engine. These
// let GIA tell you when to schedule work, what it thinks deserves your
// attention, and how it currently decides what to notify about.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const activityPatternsTool = defineTool({
  id: 'activity_patterns',
  name: 'activity_patterns',
  description:
    'Show GIA\'s learned activity patterns: when you are most active, your top activity types, and the best time to schedule a task ("report" or "predict <activity>").',
  input: z.object({
    action: z.string().default('report').describe('"report" (default) for the full pattern report, or "predict <activity>" for the optimal time slot for that activity'),
  }),
  execute: async ({ action }) => {
    try {
      if (action.startsWith('predict')) {
        const activity = action.replace(/^predict\s*/i, '').trim();
        const suggestion = adaptiveScheduler.getSuggestedTimeSlot(activity || 'general');
        return { success: true, content: `## Best Time\n\n${suggestion}` };
      }
      const report = adaptiveScheduler.getPatternReport();
      const top = report.topActivityTypes.length > 0
        ? report.topActivityTypes.map(t => `- **${t.type}** — ${t.totalFrequency}×`).join('\n')
        : '- None yet — use GIA for tasks and I will learn your rhythm.';
      return {
        success: true,
        content: [
          '## Activity Patterns',
          '',
          `**Most active hour:** ${report.mostActiveHour != null ? `${report.mostActiveHour}:00` : 'n/a'}`,
          `**Most active day:** ${report.mostActiveDay != null ? DAY_NAMES[report.mostActiveDay] : 'n/a'}`,
          `**Patterns tracked:** ${report.totalPatterns}`,
          '',
          '**Top activities:**',
          top,
          '',
          report.summary || '',
        ].join('\n'),
      };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const proactiveSuggestionsTool = defineTool({
  id: 'proactive_suggestions',
  name: 'proactive_suggestions',
  description:
    'Get context-aware suggestions from GIA\'s fusion engine (time of day, pending goals, memories, activity): morning prep, follow-ups, memory cleanup, end-of-day wrap-up.',
  execute: async () => {
    try {
      const suggestions = await contextFusionEngine.getSuggestions(5);
      if (suggestions.length === 0) return { success: true, content: 'No proactive suggestions right now.' };
      const lines = suggestions.map(s => `- **${s.type.replace(/_/g, ' ')}** — ${s.message}`);
      return { success: true, content: `## Proactive Suggestions\n\n${lines.join('\n')}` };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const notificationPolicyTool = defineTool({
  id: 'notification_policy',
  name: 'notification_policy',
  description:
    'Show how GIA currently triages notifications (immediate / batched / silent), per-source preferences, and smart-notification engine accuracy.',
  execute: async () => {
    try {
      const stats = SmartNotificationEngine.getStats();
      const prefs = Object.entries(stats.sourcePreferences)
        .map(([source, p]) => `- **${source}** — ${p.immediateCount} immediate / ${p.dismissedCount} dismissed (${p.totalCount} total)`)
        .join('\n');
      return {
        success: true,
        content: [
          '## Notification Policy',
          '',
          `**Decisions made:** ${stats.totalDecisions}`,
          `**Accuracy:** ${stats.accuracy > 0 ? `${(stats.accuracy * 100).toFixed(0)}%` : 'n/a (no feedback yet)'}`,
          `**Pending digest batches:** ${stats.pendingBatchCount} (${stats.pendingNotificationCount} notifications)`,
          '',
          '**Per-source preference:**',
          prefs || '- None learned yet',
        ].join('\n'),
      };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const intelligenceTools = [
  activityPatternsTool,
  proactiveSuggestionsTool,
  notificationPolicyTool,
];
