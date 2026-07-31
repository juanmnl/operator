# Brief — agent↔agent delivery ships ON. Then prove the brakes actually fire.

User: *"why is agent to agent something i need to toggle?"* — then: **"flip it on and test the
brakes."** Two halves, and the second is the real work.

## Part 1 — the default

`DashboardView.tsx:256`:

```ts
return localStorage.getItem('operator.chatterPaused') !== '0'
```

Absent key → **paused**. The key is only ever written by the toggle, so:
`'0'` = the user explicitly turned delivery ON, `'1'` = explicitly OFF, absent = never touched.

Invert the default so absent → **live**, e.g. `=== '1'`. ⚠️ **Preserve both explicit choices** —
someone who deliberately paused must stay paused, and someone who deliberately enabled must stay
enabled. Only the untouched case changes. Add a test per case (absent / `'0'` / `'1'`).

**Also fix the rationale comment** in `ProjectChannel.tsx` (~line 109). It still reads *"two agents
that can each answer the other ping-pong indefinitely at ~1s a hop, so this ships ON (paused) and
the user opts in."* That reasoning is now carried by the brakes, and a comment describing the
opposite of the code is how the default gets "restored" later as a bug fix. State why it flipped:
the brakes bound the runaway, and default-off meant messages piled up as `POSTED` reaching nobody.

**Keep the switch.** A kill switch you can hit when something goes wrong is worth having; a
default-off mode you must discover is not. The label rule stands — it says what IS, not what the
click does.

## Part 2 — prove the brakes fire in the LIVE app

**This is the point of the task. Do not satisfy it with unit tests.**
`agent-delivery.test.ts` already has 18 passing cases covering hop inheritance, the human-message
reset, per-ordered-pair isolation, suspend-then-release, and "a blocked delivery does not extend
its own suspension." **The logic is proven. The integration is not.** Nobody has watched these
brakes fire with real lanes, a real transcript tailer, and real dispatch delivery.

The constants (`agent-delivery.ts:15-20`): `HOP_LIMIT = 6`, `PAIR_WINDOW_MS = 60_000`,
`PAIR_MAX_IN_WINDOW = 4`, `PAIR_SUSPEND_MS = 5 * 60_000`.

Exercise each one end-to-end and report what you actually observed:

1. **Hop limit.** Get a chain running between two lanes with no human in it and confirm it stops
   at hop 6 — and that the 6th message is *in the channel* with `held · chain limit reached`, not
   silently dropped.
2. **Pair brake.** Drive one ordered pair past 4 messages inside a minute; confirm it suspends,
   that the reverse direction and other pairs stay reachable, and that it releases after 5 minutes
   rather than staying stuck.
3. **Human reset.** Confirm a human message genuinely resets the hop budget in the live app, not
   just in the pure function.
4. **The brakes vs. real latency.** The unit tests use injected clocks. Real hops cost seconds of
   model latency, so a natural conversation may never reach 4/minute — say so if that's what you
   find. **"The brake never tripped because real agents are too slow to trip it" is a valid and
   important result** — it would mean the pair brake is dead code in practice and the hop limit is
   the only live guard. Report what you measure, not what you expect.

Prefer real lanes over the mock where you can. If you must use `dev/mock-bridge.ts`, say exactly
which parts were mocked — a brake that fires against a fixture and never against a real pty is the
fixtures-more-generous-than-reality trap this project has been bitten by twice.

⚠️ **Two agents talking unattended is the exact scenario this brief enables.** Watch it while it
runs, and stop it if it misbehaves — do not start a chain and walk away. Do not pattern-kill
anything to stop it; use the toggle you're about to make default-on, or close the sessions by id.

## Also worth checking

Does a blocked message stay legible? Design just retoned `paused`/`hop-limit`/`pair-brake` to
`warn`, and `undelivered` now exists as a separate outcome. Confirm a brake-blocked message reads
as blocked in the feed and isn't confusable with a delivered one.

## Verify

- `npm test`, `npm run build` clean.
- The three default cases (absent / `'0'` / `'1'`) covered by tests.
- A written account of each brake firing (or not) in the live app, with observed timings.

## Where to work

`main` is at `8b40454`. Work in your own worktree (`~/.operator/worktrees/operator-c48bd8`) and
commit there; I'll merge forward. Do not edit `/tmp/claude-501/merge-main`.

## Output

`dev/briefs/chatter-on-by-default-RESULT.md`: the default change and its three cases, then per
brake — what you did, what you observed, timings, and whether it fired at all. Flag anything that
turned out to be unreachable in practice. Then one OPERATOR-REPLY line.
