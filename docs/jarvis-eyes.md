# Jarvis Eyes

Jarvis Eyes is an optional floating orb that watches the desktop and doubles as a state indicator.

## What it does

- Show a floating orb on the desktop
- Use the orb to indicate app state
- Optionally watch the desktop through screen capture and vision analysis
- Pause watching when the screen is locked

## State indications

The orb reflects state:

- **Listening** — wake word heard you
- **Thinking** — reasoning, ring spins
- **Acting** — a desktop-changing tool is running
- **Idle / Seeing** — ambient watch, breathing
- **Speaking** — talking back
- **Off** — dim, eyes closed

## How the orb works

The orb is both a decorative presence element and a functional state indicator. It reflects what the app is doing so the user can tell, at a glance, whether GIA is listening, thinking, acting, speaking, or idle.

## Optional desktop watching

Jarvis Eyes is off by default. It only starts working when you explicitly enable it, from **Settings → Developer → Jarvis Eyes** or by tapping the orb.

When enabled, it captures the screen at a slow ambient cadence and analyzes each capture using the vision pipeline.

## Local vs provider vision

When the local on-device vision models are loaded, analysis happens entirely locally. Screenshots are used transiently and are never uploaded, stored, or sent to any provider.

If the local models are not loaded, GIA falls back to the vision capability of the AI provider you have active in chat, such as GPT-4o, Gemini, or Claude. In that case, the screen capture is sent to that provider in the same way your chat messages are. Only a short distilled text description enters the brain's context.

## Verification of desktop changes

Every desktop-changing tool flips the orb to "acting", then takes a fresh capture afterwards. That is so the result is verified rather than assumed. The app does not conclude a desktop action worked because it sent the action. It looks again.

## Screen lock awareness

Screen watching automatically pauses while the screen is locked.

## Why this matters

Jarvis Eyes turns the agent's internal state into something visible on the desktop, and optionally gives it a way to see the desktop back. That is a different kind of presence than a chat bubble. It is a visible coworker on the screen, with a clear indication of what it is doing and whether it is watching.

## Notes and limitations

- Jarvis Eyes is optional and off by default.
- Local vision runs entirely locally. Provider vision sends captures to the active chat provider.
- Only distilled text reaches the brain.
- Watching pauses when the screen is locked.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Screen Control](screen-control.md)
- [Privacy](privacy.md)
- [Vision](privacy.md)
