# Brief — the dispatch split is STILL happening. Length scaling was the wrong model.

**Escalation of `dev/briefs/submit-queue-long-message-split.md`.** That brief offered three fixes
in preference order; option 2 (scale the nudge with length) shipped, and it is not enough.
Read that brief first for the mechanism, then this for why it must now be option 3.

Screenshot: `/tmp/operator-shots/` (user, 2026-07-30, live). A dispatch to the Code lane arrived
as a truncated turn plus a stranded tail sitting in the composer — the exact original artifact.

## The new evidence, and why it falsifies the current model

The message that split:

```
Third: read dev/briefs/plan-usage-stale.md and do it. Usage meter fetches once at mount and
never refetches, so it shows a session % from an expired window. Result → dev/briefs/plan-usage-stale-RESULT.md
```

- **203 characters** (205 bytes).
- `nudgeDelayFor` → `800 + round(203/1000 × 1500)` = **1104 ms**.
- `SUBMIT_NUDGE_MAX_MS` is 6000. This message was **nowhere near the cap** — it used 18% of the
  available budget. The cap is not the problem.
- Machine state at the time: **25 `claude` processes**, load average **4.01**. Three Operator
  lanes live, each running subagents.

So a 203-char paste took **longer than 1.1 s** for the TUI to commit. The shipped model
(`SUBMIT_NUDGE_PER_1K_MS = 1500`) predicts ~300 ms of TUI work for this message. It was out by at
least 4×, and the direction of the error is the one that splits messages.

**The conclusion: commit time is dominated by system load, not message length.** The comment at
`submit-queue.ts:39-56` reasons carefully about *delivery* cost (correctly measured at ≤0.3 ms
through a real pty, load-independent) and then attributes the remaining time to paste parsing and
composer re-wrap — which scales with length. That's true but it is not the dominant term. A TUI
competing with 25 Claude processes for CPU commits slowly regardless of how short the paste is.

**No open-loop timer can be correct here.** Any constant we pick is a guess about a machine whose
load we do not control and which *this app itself* drives up by launching lanes. The file already
says as much: `SUBMIT_NUDGE_MAX_MS` is described as "a stand-in for" the closed-loop confirmation.
Time to build the thing it stands in for.

## The job — closed-loop delivery confirmation

Option 3 from the original brief. **Do not ship another tuned constant.**

The shape, to argue with rather than follow blindly:

- After writing the submit sequence, **watch for the turn actually starting** instead of sleeping
  a guessed interval. The transcript tailer already knows when a turn begins — it polls the JSONL
  at 1 s (`transcript.rs`, `start_tailer` ~`:825`) and already parses assistant turns
  (`apply_assistant`, `:394-424`). That is the natural confirmation signal.
- **Only re-nudge if no turn started**, and then re-check rather than firing blind.
- Keep the nudge **cancellable** — `cancelNudge` exists precisely because a nudge landing after an
  interrupt re-submits Claude Code's restored draft and silently restarts the same work. A
  confirmation loop must not widen that window; if anything it should narrow it.
- 1 s tailer latency is the floor on confirmation. That is fine — the nudge is a *rescue*, and
  being late costs nothing when the message already went through. Being early is what corrupts.

**If you conclude a different closed-loop signal is better** (pty echo, composer state, anything
observable), argue for it. The requirement is that the decision to re-nudge is made from an
observation, not a timer.

## Regression bar — both failure modes, and the new one

`submit-queue.test.ts` must keep covering all three:

1. **The merge bug** (3 short bursts must not coalesce into one draft) — the original failure the
   queue was built for. A fix for the split can silently reintroduce it.
2. **The split bug** at length — already modelled in the test suite.
3. **NEW: the split under slow commit.** Add a test where commit time is long and
   *independent of message length* — a short message with a slow TUI. That is today's failure and
   the current suite cannot express it, which is why the shipped fix looked correct.

Also extend the `dev/drive-dispatch.mjs` sweep: hold length constant and vary simulated commit
latency, rather than the reverse.

## Why this is now the priority

This bug corrupts **the mechanism every other task is delivered through.** Its known downstream
consequence is a pile of tasks that were dispatched, half-delivered, and never run
(the task-lifecycle leak). Today it truncated a live dispatch at 203 characters — which means the
documented mitigation ("keep OPERATOR-DISPATCH lines short, put briefs in files") **no longer
provides real protection.** The file pointer is what saved this one: the truncated prefix still
contained `read dev/briefs/plan-usage-stale.md and do it`, so the lane could recover. That is luck,
not a safety property.

## Verify

- `npm test` — all three cases above green, including the pre-existing merge test.
- `npm run build` clean.
- **Acceptance is a live repro**: with all lanes running (load ≥ 4), dispatch a ~200-char message
  and confirm it arrives as exactly one turn with an empty composer. Do it several times — this is
  a race, so a single pass proves nothing. Report how many trials you ran.
- Confirm interrupt still cancels cleanly and does not re-submit a restored draft.

## Scope

Keep it surgical and confined to the submit path so it can be committed on its own. You are also
holding `plan-usage-stale.md`; **do this one first** — it protects every dispatch that follows.

## Output

Write `dev/briefs/dispatch-split-closed-loop-RESULT.md`: the confirmation signal you chose and why,
what you did with the open-loop constants (removed? kept as a backstop?), the three test cases,
your live-repro trial count and results, and anything still unprotected. Then one OPERATOR-REPLY line.
