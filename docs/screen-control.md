# Screen Control

GIA Cowork can look at the screen and change it: capture, click, drag, type, and scroll.

## What it does

- Capture the current screen
- Click at a point
- Drag between points
- Type text
- Scroll

These are desktop actions on the host, not simulated browser events. The app does them through the Rust backend and the desktop shell, so the control is real operating-system input, not a webpage pretending to have a keyboard.

## How it works

Screen capture goes through the desktop backend's screen capture path. The result is an image the app can inspect, show in the UI, or feed into the vision pipeline.

Input control — click, drag, type, scroll — is performed by the desktop backend controlling the host input surface. That means the app is actually moving the mouse, typing on the keyboard, and scrolling the active view, not sending events into a sandboxed web element.

Because these are real desktop actions, the app is operating on what is actually on screen, not on a synthetic representation. That is the point: the agent can see the machine's current state and act on it.

## Verification

Every desktop-changing tool does not just assume it worked. After it makes a change, the app takes a fresh capture and checks the result. That is "verified rather than assumed": the app does not conclude a click landed because it sent a click event. It looks again afterward.

## Why this matters

A desktop agent that cannot see or touch the screen is a chat agent with extra steps. A desktop agent that can see, act, and verify is a coworker that can do things on the machine. Screen control is what makes the "real screen control" claim in the product line true.

## Notes and limitations

- Screen control is a desktop capability. It does not apply in the same way to the web preview.
- Some actions are context-dependent: what gets clicked or typed depends on what is currently focused or visible.
- Full mouse/keyboard autonomy is gated behind an explicit permission surface and is still being hardened.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Jarvis Eyes](jarvis-eyes.md)
- [Tools](tools.md)
