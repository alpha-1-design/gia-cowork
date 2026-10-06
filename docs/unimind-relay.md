# Unimind Relay

Unimind is an embedded relay for cross-device communication between GIA Cowork on the desktop and GIA on a phone. There is no separate server to install or start.

## What it does

- Connect a desktop and a phone over a shared relay URL
- Pair the devices with a shared pairing id
- Let both devices use the same relay for communication

## How it works

The desktop starts an embedded relay. The phone connects to the same relay URL and pairing id. Both devices must share the same URL and the same pairing id.

For example, the desktop might show a URL like `ws://192.168.1.50:8787/unimind`. The phone is configured with that same URL and pairing id, then connects.

## Configuration

The relay uses two main settings:

- `UNIMIND_RELAY_PORT` — relay port, default `8787`
- `UNIMIND_RELAY_SECRET` — optional shared secret clients must send

The relay runs only inside the native app. For the web preview, the relay can be run separately with `cd relay && npm install && npm start`.

## Why this matters

A desktop agent and a phone agent that cannot talk to each other are two separate assistants. A desktop agent and a phone agent that share a relay can coordinate. That is the point of Unimind: cross-device continuity without a server you have to install and maintain.

## Notes and limitations

- The relay is embedded in the native app.
- Both devices must share the same URL and pairing id.
- LAN exposure requires explicitly enabling LAN mode and providing a shared secret of at least 32 characters.
- Relay messages are routed in memory and are not intentionally persisted.
- LAN traffic is not a substitute for encrypted transport. Do not expose the relay to untrusted networks.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Privacy](privacy.md)
