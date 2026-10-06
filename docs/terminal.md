# Terminal

GIA Cowork runs a **real** shell on the host — `sh -c` on Linux, `powershell.exe` on Windows — not a simulated one. It has real sessions, real kill, real exit codes, and real timeouts.

## What it does

- Open a terminal inside the app and ask it to run something
- Run commands with sessions, so output is attached to a live process
- Kill a running command
- Read the actual exit code, not a synthetic success/failure flag
- Enforce timeouts so a stalled command cannot hold the session forever

## How it works

The terminal lives in the Rust backend. The desktop app asks Tauri to spawn a host process and streams its output back into the UI. That is the key distinction: this is not a browser function pretending to be a terminal. It is the app asking the operating system to run a command, and then listening to that command.

On Linux, that means `sh -c`. On Windows, `powershell.exe`. The backend does not try to fake shell semantics in JavaScript. It delegates to the host.

A session is more than a one-shot command. It is the running process, its stdout/stderr, and the ability to kill it. The app can stop a command that is taking too long, then report the result.

Exit codes are read from the real process, not inferred. That matters for scripting and for tools that call into the terminal and need to know whether something actually succeeded.

Timeouts bound how long a command can run. Without that, a command that hangs becomes a command that hangs the session and the user's patience.

## Why this matters here

The whole product premise is "real shell, real files, real screen control". A terminal feature that runs fake commands or pretends to be a terminal would undermine that. The terminal is one of the core reasons the app is a desktop application and not a web page.

## Notes and limitations

- The desktop terminal runs on the host Linux system rather than inside a sandbox. Treat the workspace accordingly.
- Mobile-oriented tooling may be desktop-stubbed; not every tool maps cleanly across platforms.
- This is a desktop shell integration. The web preview does not get the same native terminal surface.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Tools](tools.md)
