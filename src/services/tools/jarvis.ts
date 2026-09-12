import { z } from 'zod';
import { defineTool } from './defineTool';
import type { Tool } from './types';
import { jarvisOrbService } from '../JarvisOrbService';
import { useJarvisStore } from '../../store/useJarvisStore';
import { isTauri } from '../../platform';

/**
 * jarvis_look — the model's access to the floating orb's eyes.
 *
 * The Jarvis orb (jarvisEyes feature flag) continuously captures the desktop
 * and distills it with on-device vision models into a compact text
 * observation. Screenshots never leave the machine — the brain only ever sees
 * this text. This tool reads the latest observation, or forces a fresh capture
 * ("look now") when refresh:true. Call it BEFORE acting to know what GIA is
 * about to interact with, and AFTER acting to confirm the result landed.
 */
const jarvisLookTool: Tool = defineTool({
  id: 'jarvis_look',
  name: 'jarvis_look',
  description:
    'Read what GIA is currently seeing on the desktop through the floating Jarvis orb: the on-screen caption, visible text, and detected objects distilled by the LOCAL vision models (nothing leaves the device). Set refresh:true to capture and analyze the screen right now (recommended right before you act on the desktop, and again after, to verify the result). On non-desktop it reports that screen vision is unavailable.',
  category: 'device',
  input: z.object({
    refresh: z
      .boolean()
      .optional()
      .describe('Capture and analyze the screen NOW instead of returning the latest observation (default: false)'),
  }),
  execute: async ({ refresh }) => {
    if (!isTauri()) {
      return {
        success: false,
        content: '',
        error: 'Screen vision (Jarvis eyes) is a desktop feature — not available in the browser or on Android yet.',
      };
    }
    try {
      if (refresh) {
        await jarvisOrbService.lookNow();
      }
      const { text, at } = jarvisOrbService.getLatestObservation();
      const s = useJarvisStore.getState();
      const age = at ? `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago` : 'never';

      const ready = [
        s.visionReady.caption ? 'caption ✓' : 'caption ✗',
        s.visionReady.ocr ? 'OCR ✓' : 'OCR ✗',
        s.visionReady.detection ? 'objects ✓' : 'objects ✗',
        s.visionReady.classification ? 'classify ✓' : 'classify ✗',
      ].join(', ');

      const feedLines = s.feed
        .slice(0, 6)
        .map((f) => `- [${new Date(f.at).toLocaleTimeString()}] ${f.text}`)
        .join('\n');

      return {
        success: true,
        content: `## Jarvis eyes (screen awareness)
${s.enabled ? 'Active — the floating orb is continuously watching on-device.' : 'Inactive — capture happens only when asked (orb is in the eyes-off state). Turn on the jarvisEyes flag to enable ambient watching.'}
State: ${s.state} · last seen: ${age} · models: ${ready}
Latest observation: ${text || '(none yet — try refresh:true)'}
${feedLines ? `\nRecent feed:\n${feedLines}` : ''}
Privacy: screenshots are processed on-device; only this condensed text is ever made available to the brain. No screenshot leaves the machine.`,
      };
    } catch (e) {
      return {
        success: false,
        content: '',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const jarvisTools: Tool[] = [jarvisLookTool];