# Autonomous Loop

GIA Cowork can be left on a task. It records what it tried, feeds past attempts back in, and keeps going — but it is bounded, so it cannot spin forever.

## What it does

- Let the agent work toward a goal across multiple attempts
- Record each attempt so the agent can learn from its own history
- Feed past attempts back into the next attempt
- Stop before it runs away

## How it works

The autonomous loop is a controlled retry-with-memory loop. When a task is open, the agent can try something, observe the result, and try again with what it learned.

The important part is that the loop is bounded. A naive autonomous loop can become an infinite retry loop. This one has limits so the agent cannot spend forever, or forever-adjacent, on a task that is not converging.

Each attempt is recorded. That record is what makes the loop useful. Without it, every attempt would be a fresh guess. With it, the next attempt can see what the previous one tried and what happened.

## Reflection

The loop uses reflection: after an attempt, the agent can look back at what happened and adjust. That is not the same as blind retry. Reflection is what turns "try again" into "try something informed by what just failed".

## Why bounds matter

An unbounded autonomous loop is not a helpful agent. It is a runaway process. The app treats autonomy as something that should be useful and contained, not something that gets to keep going until it finds a way to keep going.

## Why this matters

Autonomy is one of the product's differentiators. A user can hand a task to the app and let it work, rather than narrating every step. That only works if the loop is real, observable, and bounded.

## Notes and limitations

- Autonomy is bounded on purpose.
- The loop records attempts so they can be reviewed.
- Full autonomy behind an explicit permission surface is still being hardened.

## Related

- [README.md](../README.md)
- [Architecture](architecture.md)
- [Tools](tools.md)
- [Memory](privacy.md)
