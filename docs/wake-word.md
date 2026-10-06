# Wake Word

GIA Cowork supports a local wake word so the app can be invoked by voice without sending audio anywhere.

## What it does

- Detect a wake word on-device
- Run entirely locally, with no cloud key and no transcription service
- Work in both the desktop app and the browser build
- Let the user tune sensitivity in Settings → Voice

## How it works

Wake word detection uses [openWakeWord](https://github.com/dscripka/openWakeWord), a small ONNX keyword model that runs locally, in-process.

The wake word model is an ONNX file. The project stages those ONNX files into `public/openwakeword/models` at dev and build time using `scripts/copy-wakeword-assets.mjs`. That keeps ~5.5MB of binaries out of git while still shipping them self-hosted. The engine loads its models from the app's own origin, so there is no third-party CDN at runtime.

The current head is `hey_jarvis`. There is no bespoke "GIA" model yet.

## Sensitivity

The 0–1 sensitivity setting maps inversely onto the model's acceptance threshold. Higher sensitivity means easier to trigger. That is the practical knob the user touches; the underlying model threshold is what changes behind it.

## Why this replaced the previous implementation

The previous implementation had three problems:

- **Desktop** ran continuous `SpeechRecognition` and substring-matched the transcript for `"gia"`. That meant a permanent speech recogniser firing whenever the word appeared anywhere in any sentence, and raw microphone audio sent to a speech service. That is at odds with the project's local-first premise.
- **Web** was a stub that only logged a warning, so the toggle did nothing.
- **Reachability**: the plugin was never even consulted on desktop, because `isNative` is only ever true on Capacitor.

The new implementation uses openWakeWord on both desktop and web, runs locally, and does not send audio to a cloud service.

## Notes and limitations

- The shipped head is `hey_jarvis`. A bespoke "GIA" model is not present yet.
- Wake word models are staged at build time and gitignored, not committed.
- Wake word is optional. The app does not require it to function.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Privacy](privacy.md)
