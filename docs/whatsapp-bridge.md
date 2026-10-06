# WhatsApp Bridge

The WhatsApp bridge gives GIA Cowork optional two-way WhatsApp messaging and outbound calling, through an unofficial second WhatsApp account paired as a linked device.

## What it does

- Receive incoming WhatsApp messages
- Answer those messages from GIA
- Call you if an urgent message goes unread

## How it works

The bridge is a sidecar process. The desktop supervises the sidecar. The sidecar itself uses [Baileys](https://github.com/WhiskeySockets/Baileys) for messaging and [baileys-caller](https://github.com/SheIITear/baileys-caller) for calling.

To use it, run `whatsapp_bridge_start`, then scan the QR code from **WhatsApp → Linked Devices**.

The app communicates with the sidecar over the Tauri sidecar mechanism. The sidecar is a separate Node process with its own `package.json` and dependencies, bundled as a sidecar resource in the Tauri build.

## Important warning

This is **not** Meta's official WhatsApp Business API. It authenticates as an unofficial second WhatsApp Web client on whatever account you scan the pairing QR code with.

That means automating a personal account this way carries real risk of that account being restricted or banned. Use a dedicated or secondary number, not your primary one. Pair a spare SIM or a number you are fine losing access to, not the one everyone already has for you.

Call placing via `baileys-caller` is further out on the risk curve than messaging.

## Controlling auto-replies

Auto-replies can be disabled with `whatsapp_auto_respond off`.

## Why this matters

A desktop assistant that can only talk to you through the app is limited to when you are in the app. A desktop assistant that can also receive and reply through WhatsApp can reach you where you already are. That is the purpose of the bridge: optional reach, through an existing messaging surface.

## Notes and limitations

- The bridge is optional.
- It is an unofficial client. WhatsApp's Terms of Service apply.
- Use a secondary number.
- Auto-replies can be turned off.
- Call placement is higher risk than messaging.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Privacy](privacy.md)
