# RESULT — channel step 2: the human can send

Human → one lane, and human → everyone. **No lane → lane.** The composer is live; the cap is
enforced twice; an idle lane is never launched.

---

## The trap, verified before anything was built

**A human message is not parsed as a directive.** `parse_dispatches` / `parse_replies` have exactly
two call sites in the parsing path — `transcript.rs:414` and `:427`, both inside
**`apply_assistant`**. `apply_user` (`:270`) never calls either. So a channel message landing as a
`user` turn in the target's transcript cannot be read back out as a sentinel. Checked, not assumed,
and the v0.11.0 quotation guards were not touched.

## Provenance, as built

`Project.dispatches`, with two additive fields on `DispatchRecord`:

```ts
fromHuman?: true     // absent = a lane authored it (fromRoleId names which)
groupId?: string     // shared by the N records of one fan-out send
```

`fromHuman` is a **separate flag, not `fromRoleId: 'user'`** — a roster could legitimately hold a
lane with that id, and every existing consumer reads `fromRoleId` as a roster id. `Project` is
opaque JSON end-to-end, so zero Rust change; a round-trip through `JSON.stringify` is unit-tested
because our own serialization was the only thing that could lose it.

No new `chat.db` write path. It stays tailer-write / frontend-read.

## Cap enforcement — two points, and the second is the one that matters

`CHANNEL_MAX_CHARS = 2000`, `validateChannelMessage` called:

1. **In the composer** (`ProjectChannel.tsx`) — disables Send, turns the counter red from 1800, and
   replaces the helper line with the exact overrun (`"2007 characters — 7 over the 2000 limit…"`).
2. **In `sendChannelMessage`** (`DashboardView.tsx`) **before `submitQueue`** — because a paste
   followed immediately by ⌘↵ can outrun a React state update, so the composer's own check cannot
   be the only one.

**It never truncates.** Driver-asserted: after ⌘↵ on an over-cap draft, zero writes occurred and
the draft is still 2007 characters — refused, not shortened. The reasoning is in the constant's
doc comment: there is no delivery acknowledgment anywhere in the write path, `nudgeDelayFor` is a
self-described heuristic stand-in capped at 6s, and the prefix-submits-tail-strands bug lived
exactly there.

## Delivery

One pty path, reused: `submitQueue.submit`. No second writer.

**An idle lane is never launched, and this deliberately differs from dispatch.** A dispatch is
work, so spawning a session to do it is proportionate. A message is not work — starting a whole
Claude session because someone typed "nice" is wrong, and it turns a text box into an unbounded
spawn button. An idle target gets outcome `queued` and the composer says who will get it later
(`"Sent to 0 lanes. Queued for Design — it will read it when next running."`). The reasoning sits
in `planChannelSend`'s doc comment so nobody "fixes" it.

**Fan-out** = one record per addressed lane sharing a `groupId`, bounded by the roster, no repeats.
The feed collapses them into **one row** whose chip is the group's own state — `delivered 3/4 ·
1 queued` — sorted by its earliest member so it sits where the send happened. Nothing renders
optimistically: a queued message looks queued from the first frame, because the row is built from
the record the handler actually wrote.

## Verification

- `npm test` — **336 passed / 38 files**. `cargo test` — 102 passed. `npm run build` — clean.
- **New unit tests** (`channel-send.test.ts`, plus 5 added to `project-channel.test.ts`): 2001
  chars refused with the overrun named; exactly 2000 accepted; trailing whitespace can't tip it;
  empty refused; one live lane → `sent` with a terminalId; an idle target → `queued`, **no
  terminalId and nothing launched**; fan-out one-per-lane with a shared groupId and each lane
  addressed at most once; an all-idle roster still records and still launches nothing; unknown
  target plans nothing; `summariseGroup` honest at 0 delivered; a human row renders `You →` with no
  borrowed accent; `fromHuman` wins over a stray `fromRoleId`; the `projects.json` round-trip; the
  fan-out collapse and its time ordering.
- **`dev/drive-project-channel.mjs` extended** — 12 groups, all green:

```
 9 delivered to the live lane: 1 · renders "You→ Code … delivered" · composer cleared
10 NOTHING spawned for the idle lane (spawns 0 → 0) · 0 writes · "You→ Design … queued · behind current task"
10 note: "Sent to 0 lanes. Queued for Design — it will read it when next running."
11 send disabled over cap · counter -7 · ⌘↵ did NOT send · draft still 2007 chars (not truncated)
12 written once per LIVE lane (3) · collapsed to exactly ONE row "You→ everyone … delivered 3/4 · 1 queued"
12 idle lanes skipped, not started
```

- `drive-theme-pass` — 6 palettes, **0 below floor** (author 6.48–7.99, avatar initials 4.87–7.20,
  body 12.99–17.15, chips 5.46–13.40, composer note 4.16–7.03).
- `drive-layout-shift` — **NO LAYOUT SHIFT**; the sticky-header-inside-scroller structure is intact.
- `drive-dispatch-authority`, `drive-navigation` — pass, so neither the gate nor navigation moved.

## One driver bug worth recording

My first pass asserted the new message was the **last** row and it wasn't — the seeded fixture is
timestamped later in the day than the actual clock, so a real send sorts *before* it. That was the
feed being correct, not broken. Rows are now found by text. Worth knowing because it will bite
anyone writing a channel fixture: **seed relative timestamps, not absolute ones.**

## Does an idle-target `queued` message ever actually arrive?

**Not yet — and I want to be exact, because the UI currently promises more than the code does.**

The record is written with outcome `queued`, and the composer says it "will read it when next
running". Nothing today makes that true. There is no code path that drains queued channel messages
into a lane when it starts: `handleLaunchRole` sends a lane its queued **tasks** (`ProjectTask`
with `status: 'queued'`), and a channel message is a `DispatchRecord`, which the launch path never
reads. So a queued message sits in the log indefinitely.

That's a promise gap, not a crash, and it is arguably step 3's territory (delivery). But the
honest options are:

1. **Deliver on launch** — have `handleLaunchRole` also drain `dispatches` with
   `fromHuman && outcome === 'queued'` for that lane, flipping them to `sent`. Small, and it makes
   the existing copy true.
2. **Soften the copy** to "it'll be here when you next open that lane" and treat the record as a
   note-to-self rather than a pending delivery.

I did **not** do (1): it is delivery, and delivery is explicitly held for step 3 with the kill
switch. So the gap stands, deliberately, and the wording is the thing to fix first if you'd rather
not carry it. Flagging rather than quietly leaving the UI overstating itself.

## End-to-end against a real live lane

Not run. Your dev server was down and the only live lane is this session — sending a channel
message to my own pty mid-task would inject text into the conversation executing the brief. The
mock exercises the whole path to the `submitQueue` boundary (real records, real queue calls, real
feed), and `submitQueue` itself is separately covered by `drive-dispatch.mjs` up to 4000 chars.
The first real send is still worth doing by hand.

## Not built, per scope

Lane → lane, hop budget, pair brake, kill switch. Threading, message ids, read receipts, presence.
No new `chat.db` write path. No change to `parse_directives`.
