# GIA Cowork WhatsApp bridge

Real, two-way WhatsApp messaging and outbound calling for GIA Cowork, via
[Baileys](https://github.com/WhiskeySockets/Baileys) (messaging) and
[baileys-caller](https://github.com/SheIITear/baileys-caller) (calling).

## Read this before you pair anything

This is **not** Meta's official WhatsApp Business API. It authenticates as
an unofficial second WhatsApp Web client on whatever account you scan the
pairing QR code with — the same way opening web.whatsapp.com in a browser
does, just automated. Straight from Baileys' own README:

> The maintainers of Baileys do not in any way condone the use of this
> application in practices that violate the Terms of Service of WhatsApp.

Automating a personal account this way carries real risk of that account
being restricted or banned. **Use a dedicated/secondary number, not your
primary one** — pair a spare SIM or a number you're fine losing access to,
not the one everyone already has for you.

Call placing specifically (`baileys-caller`) is further out on the risk
curve than messaging: it has no tagged release, wraps WhatsApp Web's VoIP
stack directly, and will need maintenance as WhatsApp's protocol changes
underneath it. Messaging (`send`, `send-voice`) is comparatively mature —
hundreds of projects run on mainline Baileys. Calling is the newest,
least-proven piece here.

## Setup

```bash
cd src-tauri/sidecars/whatsapp-bridge
npm install
npm run pair
```

Scan the QR code that prints in the terminal with the WhatsApp account you
want to dedicate to this (WhatsApp app → Linked Devices → Link a Device).
Session credentials get written to `./auth/` — that directory is a live
session, equivalent to a password. It's gitignored; never commit it, never
copy it anywhere you wouldn't put a password.

GIA Cowork's Rust backend starts this sidecar itself on demand
(`whatsapp_bridge_start`) once you're ready to use it — you don't need to
run it manually except for the first-time pairing above.

## What it actually does

- `POST /send` — plain text message.
- `POST /send-voice` — WhatsApp voice note (mature, stable, uses the same
  mechanism as sending any voice message).
- `POST /call` — places a real WhatsApp voice call, plays an audio file as
  the outbound call audio (experimental — see above).
- `POST /notify` — the "text me, call me if I don't reply in time"
  behavior: sends text immediately; if unread after `escalateAfterMs`,
  places a call with `escalateAudioPath` (a pre-synthesized TTS clip of
  the message). Cancelled automatically the instant the text is read.

All endpoints require an `X-GIA-Token` header — the token is generated
fresh each time the Rust side spawns this process and isn't persisted, so
nothing else on your machine can call this API.
