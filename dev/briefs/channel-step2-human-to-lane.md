# Brief — channel step 2: the human can send

Design: `https://claude.ai/code/artifact/03cc9418-5fd3-4cf0-b88a-3c3c6b4c3a99`
Step 1 (read-only feed) is merged: `ProjectChannel.tsx`, composer present and inert.
Audit: `dev/briefs/research-project-chat-return-path-RESULT.md`

**Scope: human → one lane, and human → everyone. NOT lane → lane** (that's
`dev/briefs/agent-to-agent-delivery.md`, still held, and it needs the kill switch).

## Where a human message LIVES — decide this first

The audit's §4 finding: `chat.db` is strictly tailer-write / frontend-read (`lib.rs:1567`), and a
message typed into a lane's pty is **indistinguishable from the human typing directly** in that
lane's transcript. So there is nowhere for a channel message to be recorded today.

**Use `Project.dispatches`, not a new chat.db write path.** Reasons: `Project` is opaque JSON
end-to-end (zero Rust change), `DispatchRecord` already models an addressed message with a delivery
outcome and a stable id, it is already a capped tail log, and `ProjectChannel` already renders it.
A second store for the same concept is how the two drift.

Extend `DispatchRecord` (`src/shared/types.ts`):

```ts
/** Absent = a lane authored it (fromRoleId names which). Present = the human sent it from the
 *  project channel. The wire cannot tell these apart — delivery types into a pty either way —
 *  so provenance has to be recorded here or it is lost. */
fromHuman?: true
/** Set when one send fanned out to several lanes, so the channel can collapse N records into
 *  one row and show "delivered 4/6". */
groupId?: string
```

Do **not** overload `fromRoleId: 'user'` — a roster could legitimately contain a lane called `user`,
and every existing consumer treats `fromRoleId` as a roster id.

## Delivery

Reuse the dispatch path — `submitQueue.submit` via the same handler dispatch delivery uses
(`DashboardView.tsx`, around `:849`). Do not add a second write-to-pty path.

- **Hard cap 2000 chars**, enforced in the composer AND again before submit. The audit is explicit
  (§3): past ~3.5k there is no delivery acknowledgment anywhere in the write path, `nudgeDelayFor`
  is a self-described heuristic stand-in (`submit-queue.ts:59-62`), and the old
  prefix-submits-tail-strands bug lives exactly there. Show the remaining count from 1800 on;
  refuse to send over cap with a clear message. Never silently truncate.
- **Never auto-launch a lane to receive a channel message.** Dispatch does launch an idle lane,
  because a dispatch is work. A message is not work: launching a whole session because someone said
  "nice" is wrong, and it is an unbounded spawn from a text box. An idle target gets outcome
  `queued` and a "will arrive when this lane next runs" affordance. **This differs from dispatch on
  purpose — say so in a comment** so nobody "fixes" it later.
- **Fan-out to everyone** = one `DispatchRecord` per live lane, sharing a `groupId`. Skip idle lanes
  (per above) and say how many were skipped. Cap fan-out at the roster size; no repeats.

## The feed
- A human message renders with the neutral circular avatar from step 1 and `You → Code` /
  `You → everyone`.
- A `groupId` row collapses to one entry showing `delivered 4/6 · 2 queued`, expandable per target.
- Reuse the existing state chips; add none.

## Composer — now live
Target pills become selectable (single lane, or `everyone`). `⌘↵` sends. Keep the honest helper line:
delivery is ~1s at best, and a busy lane reads it when its current task ends. On send, the message
appears immediately with its real state — never optimistically as `delivered`.

## Do NOT build
- Lane → lane delivery, hop budget, pair brake, kill switch. Step 3.
- Threading, message ids, read receipts, presence/typing. Not buildable (audit §6).
- Any new `chat.db` write path.
- Do not touch the v0.11.0 quotation guards in `parse_directives`. A human message is not parsed
  for sentinels — it goes to a pty, it is not read back out of a transcript as a directive.

## Traps
- **A human message must not be parsed as a directive on arrival.** It lands in the target's
  transcript as a `user` turn; confirm nothing re-parses `user` turns for sentinels (the parser runs
  on `apply_assistant` only — verify, don't assume).
- The 2000-char cap must be enforced **before** `submitQueue`, not inside the composer alone — a
  paste + immediate `⌘↵` must not bypass it.
- Never stack opacity on `--fg-muted`; guard test fails the build.
- The channel scrolls: keep the containing-block rule (header inside the scroller, sticky) or the
  3px scrollbar shift returns.

## Verify
- `npm test` + `npm run build` + `cargo test` green.
- Unit tests: a 2001-char message is refused, not truncated; an idle target yields `queued` and no
  spawn; fan-out creates one record per LIVE lane with a shared `groupId`; `fromHuman` survives a
  `projects.json` round-trip; a human record renders as `You →` not as a lane.
- Extend `dev/drive-project-channel.mjs`: send to one lane, send to everyone, assert the composer
  blocks over-cap text and that no session is spawned for an idle target.
- Report what actually happens end-to-end against a real live lane, if one is running.

## Write your result to
`dev/briefs/channel-step2-human-to-lane-RESULT.md` — the provenance decision as built, the cap
enforcement points, and whether an idle-target `queued` message ever actually arrives in practice.
