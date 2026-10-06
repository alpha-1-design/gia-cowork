# Tools

GIA Cowork ships with 292 registered tools. They cover files, code execution, web search, email, calendar, notes, tasks, reminders, smart home, messaging, and more.

## What it does

- Expose a large set of capabilities to the agent
- Let the agent call tools during a conversation
- Let the app run tools from the UI, not only from the agent
- Keep each tool's contract in one place

## How a tool is defined

A tool is defined with `defineTool()`. That helper turns one Zod schema into both the model-facing JSON schema and the runtime validation. The point is that a tool's contract lives in exactly one place.

That single schema is used for:

- telling the model what the tool looks like
- validating the tool call at runtime

Without that, you would have one description for the model and a separate implementation path for execution, and those two would eventually disagree.

## How tools are organized

Tools are exported as arrays from files under `src/services/tools/*.ts`. They are registered in `src/services/tools/index.ts`.

That registration point is the wiring layer. Each tool file owns its own tools. The index file brings them together so the rest of the app can see the full tool set without every file importing every other file.

## Tool execution

When a tool is called, the app validates the call through the same schema the model saw, then runs the tool's implementation. The implementation can do anything the app is allowed to do: read files, run commands, send messages, capture the screen, and so on.

Some tools change the desktop. Those are the ones that flip the Jarvis orb to "acting" and then verify the result with a fresh screen capture.

## Tool categories

Tools are not all the same. Some are file tools, some are code tools, some are messaging tools, some are smart-home tools. The tool taxonomy in the app is what groups them for the user and for the slash command catalog.

## Why this matters

Tools are how the agent does things instead of only saying things. A chat model that can only talk is a chatbot. A model that can call tools — read a file, run a command, look at the screen, send a message — is an agent that can work.

## Notes and limitations

- Some mobile-oriented tools are desktop-stubbed. Not every tool maps cleanly across platforms.
- Tool authoring is meant to be straightfoward: define the schema once, export the array, register it.
- Tool execution is bounded. Long-running or autonomous tool work is limited so it cannot spin forever.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Terminal](terminal.md)
- [Screen Control](screen-control.md)
- [Autonomous Loop](autonomous-loop.md)
