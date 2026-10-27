# Floating HUD

The floating HUD is an optional compact chat surface for desktop work. It is not
an always-on orb and it has no ambient screen awareness; you turn it on when you
want a conversation that stays visible while you move between modules.

## Turning it on

- Click the HUD button in the header, or
- Run **Toggle Floating HUD** from the command palette, or
- Set `gia-floating-hud` to `true` in local storage.

The setting persists across restarts. Use the minimize button to collapse the
panel into a small GIA tab; use the power button to turn the HUD off entirely.

## What it does

- Writes into the active chat session, using the same history and generation
  path as the full Chat screen.
- Shows the last few messages and the current streaming reply.
- Keeps the desktop shell intact: the menu bar, module rail, keyboard shortcuts,
  terminal, task board, notes, and command palette are unchanged.
- Hides itself in presenter mode, along with the other floating chrome.

## What it does not do

- It does not replace the Chat screen or desktop navigation.
- It does not capture the screen, watch the desktop, or run a background vision
  loop.
- It does not start a second agent. It uses the active session and the same
  provider configuration as the rest of the app.
