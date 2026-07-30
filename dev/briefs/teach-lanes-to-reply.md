# Brief — teach lanes the return path (make the channel come alive)

`OPERATOR-REPLY` parses (`transcript.rs`), persists (`chat.db` → `replies`), and renders
(`ProjectChannel.tsx`). The table has **0 rows** and always will: nothing in
`src/renderer/lib/roster.ts` ever tells a lane the sentinel exists. The orchestration note teaches
only `OPERATOR-DISPATCH` (`:205`, `:221`).

So the return path is built and undiscovered. This is the prompt-side half — small, no delivery.

## Change

In `orchestrationNote()` (`lib/roster.ts`), add the reply sentinel beside the dispatch one, for the
coordinator AND the lanes. Same shape, so it inherits the tolerant parser and the existing stripper:

```
OPERATOR-REPLY [<lane-id or "project">] <one line>
```

State what it does honestly — a lane must not believe it is having a conversation:

- It **posts to the project channel**, where the user and every lane can read it.
- It is **not delivered to anyone's session.** Nobody is interrupted; nobody is guaranteed to read it
  at any particular moment. (Delivery is `dev/briefs/agent-to-agent-delivery.md`, unbuilt.)
- It does **not** replace the result file. A brief that names an output path still needs that file
  written — the channel is a headline, the file is the work.

## The thing to get right: when to reply, not just how

An instruction to "post progress" will flood the channel with narration, and a flooded channel is a
channel nobody reads. Scope it to moments that carry information the room needs:

- when a dispatched task is **finished** (one line: what landed, where the detail is)
- when **blocked** and the blocker belongs to someone else
- when something is discovered that **changes another lane's work** (Review finding a live defect is
  the archetype — that is exactly the message that had no channel today)

And explicitly not: step-by-step narration, "starting now", thinking aloud, or restating the task.

Keep it to one line. The channel is a headline feed; `stripDispatchLines` already removes the
directive from displayed prose, so a lane's own transcript reads normally either way.

## Do NOT

- No delivery, no pty writes, no guardrails (they belong with delivery — a hop budget with nothing
  to hop is dead code).
- Do not touch the parser, the store, or `ProjectChannel.tsx`. Prompt text only, plus tests.
- Do not add the reply instruction to the **non-coordinator** charters as a *commissioning* route:
  `NO_COMMISSIONING` stands. A reply reports; it does not ask for work. If a lane wants work done it
  recommends, and the coordinator dispatches.

## Verify

- `npm test` + `npm run build` green.
- `roster.test.ts`: the note contains both sentinels; the coordinator's and the lanes' notes each
  carry the reply form; `NO_COMMISSIONING` is still appended to every non-coordinator charter.
- Confirm `stripDispatchLines` still removes an authored reply line from displayed prose, and still
  **keeps** a quoted one (the quotation guards from v0.11.0 must not regress).
- Sanity-check the note's total length — it is appended to every lane's system prompt at launch, so
  report the before/after character count.

## Write your result to

`dev/briefs/teach-lanes-to-reply-RESULT.md` — the exact wording added, the note's size delta, and
your judgement on whether the "when to reply" scoping is tight enough to avoid flooding.
