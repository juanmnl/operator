# Brief: plan-bar Review fixes + the last two bus findings (Code lane) — 2026-09-06

Inputs: dev/results/review-plan-bar-and-bus.md (Review), dev/results/qa-plan-bar-and-bus.md (QA),
dev/results/dispatch-over-bus.md (your own open items 4 and 7). main = 687ed06 (bus merged).

On `operator/plan-bar` (rebase onto main first; the branch predates the bus merge):
A. HIGH — `contextTokens` must sit inside the `isSidechain` guard in BOTH tailers
   (transcript.ts:480, transcript.rs:580); a subagent's record must never overwrite the main
   thread's reading. Test with a synthetic jsonl: main at 780k, sidechain at 15k, reading stays 780k.
B. MEDIUM — the 1M window cannot be read from `message.model` (no transcript carries `[1m]`).
   Decision: infer the window from evidence, in this order: roster/launch pin containing `[1m]`
   → 1M; observed context > 200k on the main thread → 1M from then on for that session (a
   200k-window lane cannot exceed 200k); else 200k. Never clamp to 200% red.
C. LOW-MED — no plan reading outside a session (gallery, first launch). Decision: the rail foot
   keeps a text-only reading (`Week 42%` style, binding limit named, no ring) when NO session is
   active, hidden when one is; the bottom bar owns it otherwise. Keep lib/rail-foot's invariants.
Then merge `operator/plan-bar` into main only when Juan says so — report it ready.

On main (bus residuals, from your result file):
4. Unanswered dispatch requests must expire: a request older than the 15s lane timeout is
   answered `refused: expired` by the app (or ignored with a log line), so app downtime does not
   replay as a burst of launches.
7. session-bus.ts: liveness check on the registry (descriptor pid alive, socket exists) and a
   deterministic choice when two descriptors share a sessionId (newest `startedAt`, and log it).
Tests for each. Gates as usual. `dev/results/plan-bar-fixes-and-bus-residuals.md`;
`mcp__operator__report`. Explicit-path commits.
