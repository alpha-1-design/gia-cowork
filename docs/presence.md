# Presence Awareness

GIA Cowork detects screen lock state, pauses background work when you are away, and resumes when you return.

## What it does

- Detect when the screen is locked
- Pause background work when the screen is locked
- Resume background work when the screen is unlocked

## How it works

On Linux, presence detection uses systemd-logind's DBus interface. That is the standard mechanism major desktop environments use to report session lock state.

The app does not try to homebrew a per-desktop-environment detector. Linux has no single "is the user active" API in the way some other platforms do. X11 and Wayland expose idle and lock state differently, and each desktop environment has its own quirks. The one thing that is standard across virtually all modern Linux desktops is systemd-logind's DBus interface, which is what the app uses.

## What presence knows today

Today, presence gives real screen lock/unlock state.

It does not, by itself, distinguish "present but not touching anything for 10 minutes" from "away". Keyboard and mouse idle detection on Linux is a separate, harder problem. X11's XScreenSaver extension covers X11 sessions but not Wayland, and there is no portable Wayland equivalent yet. That is deliberately out of scope for this pass rather than faked with a fixed timeout that would just be guessing.

## Why this matters

Background work is useful only when it is useful at the right time. If the user is away, background work can wait. If the user returns, background work can resume. Presence awareness keeps the app from doing interesting things while nobody is there to see them, and lets it pick back up when someone is.

## Notes and limitations

- Lock detection relies on systemd-logind.
- X11/Wayland idle detection is not implemented.
- Presence is a desktop capability.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Tray Daemon](tray-daemon.md)
