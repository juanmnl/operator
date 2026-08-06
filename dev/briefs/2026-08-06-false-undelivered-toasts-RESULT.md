# RESULT — False "never started the task it was sent" toasts

**Verdict: 58 of 62 were false. The mechanism could not see the delivery it was looking for.**
Hypothesis 1 is confirmed, but not for the reason the brief guessed: a busy lane does not confirm
*late* — it never confirms *at all*, because a prompt queued mid-turn produces **no `user` turn,
ever**. Hypothesis 2 is also live, at 4 cases, and those toasts were true and must stay.

## 1. Diagnosis — evidence, not inference

Every `outcome: 'undelivered'` record in `~/.operator/projects.json` (62 — one more arrived while
this ran) matched against every transcript under `~/.claude/projects/` (1,700 files, all `type:
"user"` entries and all `queue-operation` entries), windowed to the dispatch's own timestamp.

| what the recipient's transcript shows | count | verdict |
|---|---|---|
| `queue-operation: enqueue` carrying our exact text | **52** | FALSE — accepted and worked on |
| a real `user` turn carrying our text | **6** | FALSE — delivered, confirmation missed |
| nothing at all, in any transcript | **4** | TRUE — genuinely lost |

- **The 52.** Enqueued a **median 0s** after the write (44 within 1s; all 52 within 31s). None of
  them ever became a `user` turn. Split 36 replies / 26 dispatches, spread over 08-01 → 08-06
  (22 on 08-04, 14 on 08-06) — so this predates v0.15.0; v0.15.0 raised the traffic, not the bug.
- **The 6 that did become turns.** Three landed 0.01–0.05s later merged **behind a human's
  composer draft** (`<what they were typing><our text>` as one turn) — `matchSubmission` demands
  equality, so it read a delivered message as none. Three landed at **+11.7s, +30.0s, +36.1s**:
  one past the 34s horizon, two inside it, which means at least one confirmation was lost in
  transit (tailer lag / a missed `session:update`) — the lane was running in all three cases.
- **The 4 real losses.** `2026-08-04T00:21:34` (web27 code→operator), `2026-08-06T06:21:51`
  (el-encanto operator→design), `06:46:18` and `06:56:44` (both el-encanto qa→operator). Each
  appears **only in the SENDER's transcript** — the addressee's records nothing, not even an
  enqueue, which a live TUI always writes. They line up with writes into a lane that was already
  dead while a live sibling lane existed for the same role:
  - operator lane `9d197af5` (worktree `el-encanto-47afe8`) **ended 06:07:41**; the two lost
    qa→operator replies were written at 06:46 and 06:56. The live operator lane (`5a83035c`) took
    the 06:30 and 07:06 replies fine.
  - design lane `9eb2d0f8` (worktree `el-encanto-b1c3b0`) **ended 2026-08-05T04:38**, a day before
    the lost 08-06 06:21 dispatch; the live design lane `93260e29` had been up since 06:14.
  That is the brief's second candidate (write into a closed pty). **Not fixed here** — it is a
  routing bug, not a reporting one, and the report for these four is correct. See "left out".

### Why the loop was blind

Claude Code writes `{"type":"queue-operation","operation":"enqueue","content":"<the text>"}` the
instant the TUI accepts text while it is mid-turn, then `remove` when it consumes it **inside the
running turn**. Worked example (el-encanto Code lane, `2dd23260`):

```
07:06:17.767  Operator writes the message
07:06:17.776  queue-operation enqueue  "[Operator · message from Operator] DROP §5 …"   (+9ms)
07:06:45.242  queue-operation remove   (same text)
07:06:52.201  assistant: "§5 dropped — reverting those two hunks so Design's branch merges clean."
```
No `user` entry is ever written. The old watcher read only `user` turns, so it waited 34s, saw
nothing, and declared a message the lane was already acting on lost.

## 2. The fix

The mechanism now watches the signal the transcript actually carries, and stops guessing while
the lane is demonstrably working. The toast is untouched.

**Backend — the enqueue is recorded** (`src-tauri/src/transcript.rs`, `src-tauri/src/core.rs`)
- `apply_queue_op` folds `queue-operation: enqueue` into a new per-session `queued` list
  (`NarrationEntry { kind: 'queued' }`), capped at 20, truncated at the same 4000 chars as a user
  turn (now the named `PROMPT_TEXT_CAP`, shared by both paths).
- Harness noise is filtered with the existing `is_injected_turn` (`<task-notification>`,
  reminders); `dequeue` (no content) and `remove` (already reported by its enqueue) are ignored.
- Shipped on `AgentSession` as `queued` via a `with_queued` builder — **not** merged into
  `messages`, so the reading surface and chat.db are untouched.

**Frontend — confirmation and verdict** (`delivery-confirm.ts`, `submit-queue.ts`, `DashboardView.tsx`)
- `userTurnsSince` → `promptsSince`, and it now counts `kind: 'queued'` alongside `'user'`. The
  name was going to lie otherwise: a queued prompt is not a turn.
- `matchSubmission` accepts a turn that **ends with** what we sent — the human-draft merge. Still
  anchored at the end, so a turn that merely contains our text with more after it is not a match.
- `submitQueue.busy(id, boolean)`, fed from the session phase by the same watcher that calls
  `confirm`. While a lane is mid-turn the verdict window keeps watching instead of expiring
  (re-checked at 1s, the tailer's cadence); when it goes idle it gets one more `CONFIRM_WINDOW_MS`
  before the report fires. **No retry** — the rule in `reportUndelivered` stands.
- Honest in the other direction: a lane that goes idle without the message still reports, and a
  dead pty is never "busy" — `busy(id, false)` is set on `terminal:exit` **and** in the 5s
  reconciler, because an ended session drops out of `session:update` entirely and would otherwise
  leave the queue waiting on a lane that no longer exists.

## 3. Tests

`submit-queue.test.ts` (+4): a busy lane whose confirmation arrives 8 minutes late → no report;
a lane that goes idle with nothing to show → reported, and **not before it went idle**; a dead
terminal → reported promptly (≤ horizon + window); per-terminal isolation (a working lane must not
silence a dead one).
`delivery-confirm.test.ts` (+2): a `queued` entry confirms delivery; a message submitted behind a
human draft confirms.
`transcript.rs` (+3): an enqueue is recorded (and is not narration); queue noise (task
notifications, `dequeue`, `remove`, blank) is ignored; the cap and the ellipsis truncation.

**Green:** `npm test` 677/677 · `cargo test` 145/145 · `npx tsc --noEmit` clean · `npm run build` ok.

## 4. Deliberately left out

- **The 4 real losses (writes into a dead lane).** The report for them is correct and still fires;
  the cure is on the routing side — `pickLaneTab` chose a tab whose pty had exited while a live
  lane for the same role existed. Evidence above (two lanes per role, the dead one preferred).
  Worth its own brief; `~/.operator/sessions.json` also still lists stale sessions for those roles
  (`t21 → 950269e7`, ended 00:20, while `9d197af5` had replaced it), which is probably the same
  knot.
- **The toast copy and its stickiness** — unchanged, per the brief.
- **Showing queued prompts in chat.** The transcript gap is real (the reading surface renders an
  assistant reply to a prompt it never shows), but that is a chat-rendering change, not this bug.
