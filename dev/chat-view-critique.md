# Chat view — a user's critique

**Written 2026-07-28 (Design), from driving the real renderer, not from reading the code.**

> **On the dev server:** port 1433 is not the app. It's a bare Python `SimpleHTTP` server (PID 16897) serving an **empty directory** — it 404s on the app entry and can't transform TS. I did not start anything on it. I drove the real renderer through the project's own mock harness on a free port instead, which is the established way to verify GUI here. Everything below is observed behaviour with a realistic transcript loaded (a multi-turn session about extracting a dispatch router: long prose, fenced code, lists, short back-to-back turns, and thinking blocks).

Two calls are settled and I've designed around them rather than relitigating: the transcript is going **fully structured** (tool calls, file edits, subagent spawns, permission prompts as first-class blocks), and **text selection will be fixed** (so nothing here treats whole-turn-copy as a constraint).

---

## What is already good — don't break it

The reading surface is genuinely nice, and the fix should be additive to it:

- **The document style is right.** Full-width prose, a small role marker per turn, no bubbles. It reads like a transcript, which is what it is. Long answers don't feel like chat detritus.
- **Typography holds up.** 13.5/21 prose, inline code chips, fenced blocks with a language tag, real lists and tables. The code sample was legible at a glance and the list didn't collapse into mush.
- **Search + star/dismiss exist** and are the right *idea* — per-answer reading state is exactly what a long session needs.

The problems are not typographic. They're about **state** and **evidence**.

---

## Ranked by how much it hurts

### 1. Actions — the transcript lies by omission *(worst)*

The agent said *"I'll pull the routing into `lib/dispatch.ts`"*, and the next turn said *"Done."* **Nothing in between.** No file was named as touched, no edit shown, no command, no test run. The chat is a record of what the agent *said*, not of what it *did*.

This is the worst problem because it makes the surface untrustworthy as a record. After a 200-turn session you cannot answer "what did it actually change?" from the chat — you have to go to the Diff panel and reverse-engineer it. The prose and the work have no connection: a turn claiming "Done" looks identical whether it edited twelve files or hallucinated.

It also silently subsumes #2: **a running tool call *is* the "what's it doing right now" signal.** Get the blocks right and most of the signals problem dissolves.

### 2. Signals — you cannot tell it's alive

The lane was `RUNNING` in the sidebar the entire time I was reading. The chat view showed: a finished transcript ending in a completed answer, an idle composer reading "Message the agent…", and no indication whatsoever that anything was happening.

The only liveness signal is the sidebar orb — *outside* the reading surface, in your peripheral vision, and gone entirely when the sidebar is collapsed to the rail. While you're reading the chat, the chat says the agent is idle.

**There is also no way to stop it.** The composer disables on session death only, never on phase — so mid-run you get a normal send box and no interrupt. The one thing you urgently want when an agent goes wrong is absent from the surface you're watching it on.

### 3. ~~Thinking — silently discarded~~ — **RETRACTED 2026-07-28**

**This finding was wrong, and the error was mine.** I observed that the panel filtered `thinking` out and concluded the reasoning was being discarded — but there is no reasoning to discard. Claude Code emits thinking blocks carrying a `signature` and an **empty** text field; the content is redacted at source and never reaches the JSONL. Verified independently: **1091 blocks across 40 real transcripts, every one empty** (Research's wider count: 17,682 across 326). Every one is `{type, thinking: '', signature}`.

Worse, the reason nobody caught it is also mine: the `MOCK_CHAT` fixture I wrote for this critique invented thinking **prose**. The harness then showed a working, populated Thought block, and a collapsible disclosure got built against a body that can never open.

**The durable lesson: a fixture more generous than reality will validate a feature that cannot work.** Fixtures must be derived from, or checked against, real transcript data — that is now the rule for every harness in `dev/`.

Already resolved by Code: `isRenderableTurn` (`lib/chat-turns`) drops signature-only thinking so nothing renders, the parse path stays so it lights up by itself if real text ever arrives, `MOCK_CHAT` is empty/signature-only with a note, and a test asserts it.

**What replaces this finding.** The honest way to show "what the agent was reasoning about" is the action stream, not `thinking` — and unlike thinking, that data is genuinely there. Measured across the same transcripts: **2028 `tool_use` blocks, fully populated** (`id`, `name`, `input`, and `caller` on every single one), with **2028 matching `tool_result`s**. So finding #1 below is not just the worst problem — it is also the *only* real source for agent reasoning in the transcript. It absorbs what this finding was reaching for.

### 4. Scrollback — three separate holes

- **No jump-to-latest.** Scroll up to re-read and there is no way back but flinging. Auto-stick only re-arms if you're within 80px of the bottom.
- **No unread marker.** Come back to a session that ran while you were elsewhere and there's no "you were here" rule — you get the bottom of a wall and have to guess how far up the new work starts.
- **Reading position drifts on resize.** Measured: parked mid-history, narrowing the window kept `scrollTop` at the same absolute pixel (80) while the reflowed content grew 165px taller — position slid from 30% to 19% through the document. On a real session that's a paragraph or three of lost place. Every panel toggle and sidebar collapse reflows this surface.

### 5. Conversation — rhythm is flat, density is uniform

Every turn costs the same chrome regardless of weight. Three consecutive short user turns — "Surface it. Unassigned.", "ok", "and add tests" — each got a full header row (dot + `YOU` + timestamp) and a full turn gap, burning roughly 200px of vertical space on six words. Meanwhile a 300-word answer with a code block gets the same header.

The result is that scanning a long session is slow in the least useful way: you scroll past the cheap turns at the same rate as the expensive ones. There's no visual weight difference between "ok" and a decision.

Two smaller things: the role label is a generic `AGENT`, not the lane ("Code") — in a project with six lanes the transcript never says whose voice it is. And consecutive turns from the same speaker repeat the full header rather than continuing.

### 6. History — resumable, but not re-readable

Durable history works (it survives restart, merged with a live tail). But re-reading old work is weak:

- **Search finds but doesn't navigate.** Typing filters the transcript to matching turns; there's no match count, no next/previous, no way to jump to a hit *in context*. You get a filtered view, then have to clear it and find the spot manually.
- **Star/dismiss have no index.** You can star answers, and there's a `★ 0` counter, but there's no way to see the starred set as an outline of the session.
- **No session-level orientation.** Reopening a 200-turn session drops you at the bottom with no summary of what it did, how long it ran, or what it touched.

---

## The shape of the fix

### A. One block anatomy, three states

Every non-prose event — tool call, file edit, subagent spawn, permission prompt — should wear **the same skeleton**, so the eye learns one shape and then only reads the state:

```
  ▸ marker   one-line summary, as a sentence      ·  state/meta
             └ body, collapsed by default
```

- **The marker carries kind and state**, and is the only thing that ever animates.
- **The summary is a sentence a human would say**: `Edited src/lib/dispatch.ts +42 −8`, `Ran npm test — 200 passed`, `Read 7 files`, `Delegated to Research`. Not `Tool: Edit`. The line should be worth reading on its own, because 90% of the time it's all anyone reads.
- **Tense carries state**: `Editing…` while running, `Edited` at rest. That alone distinguishes live from historical without any colour.

**At rest (the overwhelming majority).** Quiet, one line, muted, collapsed. These should read as *punctuation between prose*, not as cards — a stack of bordered boxes for every `Read` would be worse than the current omission. Subordinate them to the prose: the answer is the content, actions are the apparatus. Indenting blocks into a gutter/rail lets a reader skip them entirely when reading and scan them alone when auditing.

**Running (exactly one, always the last).** The only animated thing in the transcript — this matches the app's existing rule that motion means busy. Present tense, plus elapsed time once it passes a few seconds, because "is it stuck?" is the actual question. This is the answer to signals: the bottom of the transcript always says what is happening right now.

**Needs you (permission) — the loudest thing in the document.** Deliberately breaks the quiet: it is the one block that is *not* subordinate to prose. It should state in plain language what's being asked, show the exact command or path unelided, and present the choices as real targets. Three properties matter more than its looks:
1. **It must be unmissable when off-screen** — a persistent bar that stays until answered, never a toast that expires. Blocking on something the user never saw is the worst failure this surface can have.
2. **It must be answerable from the keyboard**, without hunting for the mouse.
3. **It must never collapse**, even long after the fact. Permission decisions are exactly what you re-read a session for.

**Failures are content, not noise.** An errored tool call never auto-collapses and never wears the quiet treatment.

### B. Collapse, so 200 turns stays readable

Density is the whole game once actions are first-class. The levers, in order of payoff:

1. **Coalesce consecutive same-kind blocks.** Tool use is bursty and homogeneous — `Read` ×7 becomes one line, `Read 7 files`, expandable to the list. This is the single biggest lever; without it a structured transcript is worse than today's.
2. **Fold a finished turn's apparatus.** Once an answer has arrived, its tool blocks become evidence rather than narrative: collapse them to a single strip under the answer (`12 actions · 3 files · 1 test run`) that expands in place. Live turns stay expanded; completed ones fold.
3. **Weight turns by substance.** A one-word turn shouldn't cost the same as a decision. Continuation turns from the same speaker shouldn't repeat the header.
4. **Never collapse:** permission prompts, failures, and anything the user starred.

### C. ~~Thinking gets the third state~~ — **VOID** (see the retraction above)

There is no thinking text to give a state to. Render nothing; keep the parse path so it lights up if that ever changes. The "what was it reasoning about" job belongs to the action blocks in §A, which have real data behind them.

**Two hard constraints that real `tool_result` data imposes on §A**, measured and worth designing to now rather than discovering later:

- **Results are often enormous.** Median content is 361 characters, but **p90 is ~35KB and the largest observed is 620KB**. "Collapsed by default, expandable in place" cannot mean "expand pastes 620KB into the transcript". An expanded result needs its own cap with an explicit escape hatch (open in full, or hand off to the panel that already renders big content), and the collapsed line should say the size so the choice is informed.
- **`caller` is present on every `tool_use`.** That is how a subagent's call is distinguished from the lead agent's — exactly what the subagent block needs, and currently never read. Design the block to carry it from the start.

### D. Signals live at the bottom edge

A status line at the foot of the transcript — where your eye already is while waiting — carrying the current activity, elapsed time, and **stop**. While running, the composer's send action should become stop. Today there is no interrupt anywhere on this surface.

### E. Scrollback

- **Jump-to-latest that doubles as the running indicator.** When you're scrolled away it reads `Editing dispatch.ts · 12s ↓`, so the affordance that takes you back also tells you what you'd be going back to. One control, two jobs.
- **An unread rule** where you left off, surviving session switches.
- **Anchor reading position to a turn, not a pixel.** On reflow, keep the topmost visible turn topmost. This is the fix for the measured drift, and it's also what makes panel toggles safe.

### F. History

Make search **navigable** — match count, next/previous, and jump-to-match *in context* rather than a filtered view. Give the starred set an outline so it works as a session table-of-contents. And on reopening a long session, land at the unread marker rather than the bottom.

---

## Settled: the transcript / panel boundary *(2026-07-28)*

**Yes, an edit block expands to show its own diff — and it does not encroach on the Diff panel, because the two render diffs of different things.**

> **The transcript is the record of events. The panels are the state that resulted.**
> Transcript answers *"what did it change, and when?"* — panels answer *"what is different now?"*

That one rule covers both panels and needs no per-panel special-casing:

| | Transcript block | Diff / Plan panel |
|---|---|---|
| Unit | one event | the whole worktree / the current plan |
| Time | historical, **immutable** — a fact about a moment | live, **always now** |
| Source | `tool_use.input`, already in hand | `worktree_diff` / latest `TodoWrite` |
| Job | evidence, in narrative order | act on it — commit / merge / discard |

### Why this works rather than duplicating

Measured across real transcripts: **`Edit` carries `file_path` + `old_string` + `new_string` on all 915 calls**, median 663 bytes, p90 2.4KB, max 25KB. That is a complete, self-contained delta. The edit block renders **that** — the hunk as it was applied, from data the transcript already holds. It never calls the filesystem, never changes after the fact, and stays small enough to expand inline under the existing cap.

**The failure mode this rules out:** an edit block must *never* show the file's **current** diff. Doing so would make the transcript silently mutate as later edits land — destroying the one property that makes a record worth keeping — cost a filesystem call per block, and give two surfaces different answers to the same question.

### Why the panel is still essential

Expanding edits inline does not make the Diff panel redundant, for three reasons that are properties of the panel, not of its rendering:

1. **It is where you act.** Commit, merge, discard live there. The transcript is read-only by nature.
2. **It aggregates.** Twelve edits across six files is one reviewable change set, not twelve events to reassemble by scrolling.
3. **It knows things the transcript cannot.** The transcript only sees changes made through tools it observed. A `Bash` `sed`, a formatter on save, a `git checkout`, or the user's own editing are all invisible to it. `worktree_diff` sees the truth. **When the two disagree, the panel is right** — and that is precisely why the transcript must not pretend to answer "what is different now".

### The two edges this exposes

- **`Write` is a creation, not a delta.** It has no `old_string` (median 2.9KB, p90 10KB, max 46KB). A Write block reads `Created path (N lines)` and expands to the new content. Where it *overwrites* an existing file, the transcript genuinely does not hold the "before" — that block should say so and hand off to the panel rather than imply a delta it cannot show.
- **The rule generalises to Plan.** A `TodoWrite` is an event ("updated its plan"); `PlanPanel` is the plan as it now stands. Same boundary, no new thinking required.

## Still open

- **Whether subagent work nests inline or collapses to a single delegated block that opens its own transcript.** Nesting is truer; it also risks a transcript inside a transcript. I'd start with the single block and see whether anyone wants to open it.
- **Anything about implementation** — canvas vs DOM, virtualization, where blocks come from in the transcript stream. That's Code's call, and none of the above depends on it.
