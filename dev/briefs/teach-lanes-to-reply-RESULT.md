# RESULT — teach lanes the return path

Prompt text only. No parser, store, or view touched; nothing delivers.

---

## The exact wording added

One shared `REPLY_PROTOCOL` constant in `lib/roster.ts`, appended to **both** branches of
`orchestrationNote()` — the coordinator's and the lanes':

```
To post to the project channel, output a line EXACTLY in this form, alone on its own line:
OPERATOR-REPLY [<lane-id or "project">] <one line>
It appears in the project's channel, where the user and every lane can read it. It is NOT
delivered into anyone's session — nobody is interrupted, and nobody is guaranteed to read it at
any given moment. It does NOT replace a result file: if your brief names an output path, write
that file. The channel is the headline; the file is the work.
Post only when the room needs to know something: a task you were given is FINISHED (one line —
what landed, and where the detail is), you are BLOCKED on something that belongs to another
lane, or you found something that CHANGES another lane's work. Do not narrate: no "starting
now", no step-by-step, no thinking aloud, no restating the task. One line, and only when it
earns one.
```

Structure is deliberate: **what it does → what it is not → when to use it → when not to.**
The two negatives come before the trigger because both are things a lane will otherwise assume —
that someone is listening, and that posting counts as delivering.

## Size delta

| | before | after | Δ |
|---|---|---|---|
| coordinator note | 1354 | **2221** | +867 |
| lane note (code) | 1284 | **2136** | +852 |

It rides on every launch, so that's real. For scale, the lane's own charter is ~700 chars, so the
note now runs about 3× the charter it accompanies. A test guards `< 2600` — aimed at a slow slide
rather than at today's value; a note that dwarfs the charter has stopped being a note.

Roughly 300 of the 850 are the "when" scoping and its anti-cases. I'd defend that as the highest-
value third: without it the sentinel gets used constantly or not at all.

## One thing I fixed that the brief didn't ask for

**The lane note was lying about dispatch.** It said *"Operator routes it to that lane — typed into
it if it's running, otherwise the lane is launched with the task"* — which stopped being true for a
non-coordinator lane when the authority gate shipped. Worse, the same prompt already carried
`NO_COMMISSIONING` saying a lane's dispatch is held, so a lane was reading a direct contradiction
and could plan around delivery that never happens.

The lane branch now reads: *"but a dispatch from your lane is HELD for the user to approve —
Operator does not deliver it on its own. So don't plan around it: recommend the work to the
coordinator instead…"* The **coordinator's** branch keeps the delivery promise, because for it that
is still exactly what happens. Tested both ways round.

This is prompt text in the function the brief scoped me to, and it's the same class of defect the
brief exists to fix (a lane believing something false about the protocol) — but it is a change you
didn't ask for, so it's flagged rather than buried.

## `NO_COMMISSIONING` stands

Untouched, and asserted: it's still appended to all five non-coordinator charters and still absent
from the coordinator's. A reply **reports**; the note never presents it as a way to get work done.
The lane branch now points explicitly the other way — *recommend to the coordinator* — so the two
halves of the prompt agree instead of competing.

## Verification

- `npm test` — **316 passed / 37 files**. `npm run build` — clean.
- New `roster.test.ts` cases (34 in the file now):
  - both sentinels present, for coordinator **and** lane;
  - the two honesty clauses present (`NOT delivered into anyone`, `does NOT replace a result file`);
  - the three triggers (`FINISHED` / `BLOCKED` / `CHANGES another lane's work`) **and** the
    anti-cases (`Do not narrate`, `starting now`);
  - a lane is told `HELD for the user to approve`, while the coordinator's note is asserted **not**
    to contain it and to keep `either way the work starts`;
  - `NO_COMMISSIONING` on every non-coordinator charter, absent from the coordinator's;
  - the size guard.
- **Quotation guards, checked as the brief asked and NOT regressed:** `stripDispatchLines` removes
  an authored `OPERATOR-REPLY` line from displayed prose, and **keeps** a mid-line mention —
  including a line naming both sentinels at once (`'Use OPERATOR-DISPATCH [code] to delegate and
  OPERATOR-REPLY [project] to report.'` survives verbatim). That matters here more than usual,
  because this brief's own wording is full of quoted sentinels: the note itself would be stripped
  if the guard were positional rather than line-anchored.

## Is the "when to reply" scoping tight enough?

**Tight enough to try, and I'd expect one round of tuning rather than none.** My honest read:

- **The three triggers are well chosen** — each names a moment where information exists that the
  room does not already have. "Finished" is the one that makes the channel legible at a glance;
  "changes another lane's work" is the Review-finds-a-defect case that had no channel at all.
- **The anti-cases are what will actually do the work.** Models announce themselves by default;
  "no 'starting now'" is worth more than any positive instruction here.
- **Where I'd expect leakage:** `FINISHED` is the loosest word in there. A lane that treats every
  sub-step as a finished task will post several times per brief — the "one line, and only when it
  earns one" tail is the only thing pushing back, and tone is weaker than a rule. If the channel
  does flood, the fix I'd reach for is narrowing `FINISHED` to *"a task that was dispatched to you"*
  (already implied by "a task you were given", but not enforced) rather than adding more prose.
- **The real test is unrunnable here.** The table has 0 rows and this change alters no code path a
  harness can exercise — flooding is a behavioural property of live lanes reading the prompt. The
  first project to run a few dispatches after this lands is the measurement, and the channel makes
  it self-evident: if the feed reads as headlines, the scoping held; if it reads as a monologue,
  narrow `FINISHED`.

## Not done, per scope

No delivery, no pty writes, no guardrails (hop budget / pair brake — dead code with nothing to
hop). Parser, `chat.db`, and `ProjectChannel.tsx` untouched.
