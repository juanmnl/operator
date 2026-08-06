# `sent · never started` needs a RETRY, and `Open lane →` must actually move you

User, 2026-08-06, with a screenshot of **Waiting 9**: *"there's a lot of sent never started issues,
and open lane doesn't do anything, we need a fix for that."* Cards ranged from 7h to 2d old, every
one reading `sent · never started` / *"Sitting in the lane's composer"*.

## Bug 1 — the missing verb: there is no Retry

`dispatch-outcome.ts:81` defines the state precisely, and its own comment states the gap:

> *"Not 'held': this one was SENT and then observed not to arrive… **the recovery is manual either
> way** and a user who reads 'delivered' while the lane sits idle has no way to find out otherwise."*

So the closed-loop delivery-confirm **correctly detects** non-arrival, and then the card offers only
`Open lane →` and `Dismiss`. Dismiss abandons the work; Open lane (bug 2) is broken. **Detection
without recovery is why nine of these accumulated over two days.**

The physical situation is trivial to repair: the text is already sitting in the target lane's
composer. What's missing is the submit. Build the recovery:

- **`Retry` on any `undelivered` card**, as the leading action (it is what moves the work forward;
  `Dismiss` stays last — the existing footer order is deliberate, keep it).
- Decide and document which of these it does, and why: **submit what's already in the composer**
  (send the CR — cheapest, but wrong if the composer was since edited or cleared), or **re-deliver
  the whole message** (idempotent-ish but risks a double-paste if the first one is still sitting
  there). Handle the composer-not-empty case explicitly either way; do not assume the composer still
  holds exactly what was pasted 2 days ago.
- **Retry must re-enter the same closed loop** that produced `undelivered`, so a failed retry is
  visible as another failure rather than silently flipping the card to delivered.
- If several cards target the same lane, ordering matters — say what happens (queue them, or refuse
  to retry more than one at a time).

**Why now, and why it will keep happening:** `dev/mcp-control-plane-spike.md` established this is
**load-dependent, not length-dependent** — `submitQueue.submit` racing `SUBMIT_NUDGE_MS` /
`nudgeDelayFor` against a TUI slowed by system load, measured at 25 concurrent `claude` processes.
There are **27 lanes live right now** and the renderer is at 944MB. So do not "fix" this by tuning
the timing constants — the race is environmental. **Make the failure recoverable in one click.**
Tuning is a separate, optional follow-up.

## Bug 2 — `Open lane →` dies on the live branch

`ProjectView.tsx:188-198` handles it:

```ts
const tid = liveRoles?.[roleId]
if (tid) onFocusTerminal?.(tid)   // ← live lane: focuses, but you never leave the board
else onSelectTab('team')          // ← already-fixed path for a lane that isn't running
```

The `else` was fixed once already (the comment records it: the button "silently did nothing" for a
lane that never started). **The `if` branch is the remaining dead path.** `focusTerminal`
(`DashboardView.tsx:2191-2200`) sets `activeTerminalId`, `activeSessionId` and `activeProjectId` —
and **nothing else**. It selects a session *behind* the board you are currently looking at. No
navigation, so from the Waiting column the click has no visible effect whatsoever.

Fix: opening a lane must **take you to that lane** — select it *and* switch the surface to it
(Console/Chat), the same way clicking the lane in the rail does. Check every other caller of
`focusTerminal` before changing it: if some callers rely on focus-without-navigation, add the
navigation at this call site rather than changing shared behaviour underneath them.

## Verify

- A card reading `sent · never started` has a `Retry` that delivers, and the card moves out of
  Waiting on success.
- A retry that fails again shows as failed — it must not report success it didn't observe.
- `Open lane →` on a **live** lane lands you in that lane's session, visibly, in one click.
- `Open lane →` on a **dead** lane still lands on the roster (don't regress the earlier fix).
- The nine currently stranded dispatches can be cleared through the UI without hand-editing
  `projects.json` — that file has been clobbered before and must not be touched.
- `npm test` green (637 on `main` = `c06fa61`), build clean.

## Out of scope

- Retuning `SUBMIT_NUDGE_MS` / `nudgeDelayFor` — environmental, separate decision.
- The artifact plane (`operator__report` / `operator__task_status`) is being built in parallel and
  may eventually replace this delivery path entirely; **do not** entangle the two. This is a repair
  to the path that exists today.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-undelivered-retry-and-open-lane-RESULT.md`
(absolute path, main repo). State which retry semantics you chose and what happens when the target
lane's composer is no longer in the state that was left there.
