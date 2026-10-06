# Tray Daemon

GIA Cowork starts as a tray daemon. Close the window, and it keeps running.

## What it does

- Start as a tray daemon
- Keep running after the main window is closed
- Let the user get back to the app after closing the window

## How it works

The desktop app is built so the main window can be closed without stopping the app. The app continues to run as a background/tray process. That is what "tray daemon" means here: the window is a UI surface, not the lifetime of the application.

This matters because a lot of what the app does is background work: waiting for a wake word, running an autonomous task, listening for a relay connection, or doing scheduled work. If closing the window killed all of that, the daemon model would not be very useful.

## Why this matters

A desktop coworker that dies when you close its window is a windowed app, not a daemon. A coworker that keeps running after the window closes is a piece of the machine. That is the intended model for GIA Cowork.

## Notes and limitations

- Tray daemon behavior is a desktop behavior.
- The exact tray interaction is part of the native app shell.
- Closing the window keeps the app running; it does not shut it down.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Presence](presence.md)
- [Autonomous Loop](autonomous-loop.md)
