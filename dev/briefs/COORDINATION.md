# Lane coordination — 2026-07-28

Four lanes are live at once on one uncommitted tree. This file exists so they do not collide.
**Operator maintains it. If you change what you are touching, say so rather than editing silently.**

## ⛔ CORRECTED 2026-07-28 11:40 — the ownership table below was WRONG

Review's report (`dev/review-working-tree.md` §0) found two errors in this file. Both are mine.

**1. Code tasks 1 and 2 are ALREADY IMPLEMENTED in the working tree.** `lib/submit-queue.ts`
(`nudgeDelayFor`, `SUBMIT_NUDGE_PER_1K_MS`) and the task lifecycle (`lib/task-lifecycle.ts`,
`reconcileStaleRunning`, `queuedCountsByRole`, `ProjectTask.reconciledAt`) are done and sitting
uncommitted. The table below marks `submit-queue.ts` as "clean" — it is not. **Code: do NOT start
tasks 1 or 2 from the ordering below; you will duplicate or conflict with your own landed work.**

**2. The pinned snapshot covers only ~⅔ of the tree.** I produced it with `git diff` instead of
`git diff HEAD`, so it excludes the staged `UsageView.tsx` deletion (243 lines) and **all 13
untracked files (1972 lines)** — including `ProjectGallery.tsx` (589) and `ProjectSwitcher.tsx`
(173). Two of the three headline new components were never in it. Review worked from disk instead
and flagged which findings that affects. Any future snapshot must use `git diff HEAD` plus the
untracked files.

**There are FIVE work-streams here, not three** — project-first navigation, PageShell, toolbar/
composer polish, **task lifecycle**, and **submit-queue nudge scaling**.

### Current priority for Code (supersedes the ordering further down)

1. **§1 — P0 crash**, `dev/review-working-tree.md`. Infinite render loop → `Maximum update depth
   exceeded`, reachable via shipped affordances. **Blocks committing.**
2. **§2 — P1**, `AgentLibraryView` split pane collapses inside `PageShell`'s scroller.
3. **`dev/chat-baseline-spec.md` §1–3** — measure cap, orb-as-send/stop, turn identity. Design calls
   these the "recognisably in the same class" set; everything after them is polish. §1 is one
   constant and is the biggest single readability jump — land it even if nothing else does.
   Note §2 removes a **duplicate stop control**: the status line and the composer currently both
   render one, shipped in today's signals work.
4. Then `chat-injected-turns.md` and the rest of the baseline spec.

## Review — read this before you start

You are reviewing a **moving target**: Code is landing fixes into the same files while you work.
A stable snapshot of the tree as dispatched:

- **HEAD:** `5caba7c`
- **working diff sha1:** `3c6e327ae852` (4510 lines)
- **snapshot file:** `/tmp/operator-shots/tree-snapshot-5caba7c.diff`

Review **that snapshot**, not a live `git diff`, and cite it in your report. If a finding no longer
reproduces against the live tree, say so — that means Code already fixed it, which is useful signal,
not a wasted finding.

## File ownership right now

Code's five queued tasks overlap the uncommitted tree almost everywhere. Files marked **⚠** are
*both* unreviewed in the working tree *and* about to be edited:

| File | In working tree | Code task |
|---|---|---|
| `lib/submit-queue.ts` (+test) | clean | 1. dispatch split |
| `views/DashboardView.tsx` | ⚠ modified (~420 lines) | 2. task lifecycle |
| `session/RosterPanel.tsx` | ⚠ modified (~323 lines) | 2. task lifecycle |
| `sidebar/SessionItem.tsx` | ⚠ modified | 3. hover cards |
| `sidebar/SidebarRail.tsx` | ⚠ modified | 3. hover cards |
| `session/CanvasConversation.tsx` | clean | 4. chat signals, 5. injected turns |
| `session/ChatComposer.tsx` | ⚠ modified | 4. chat signals |
| `lib/format.ts` (+test) | ⚠ modified | 5. injected turns |
| `src-tauri/src/transcript.rs` | clean | 5. injected turns |

**Consequence worth naming:** six of nine files carry unreviewed feature work *and* incoming fixes.
That is the tangle the review exists to unblock — it is a reason to land the review fast, not a
reason to stop Code.

## Code — suggested order

1. **`submit-queue` split** (`dev/briefs/submit-queue-long-message-split.md`) — do this first. It is
   upstream of everything: it is currently corrupting the briefs other lanes receive, and it
   produced part of the stuck-task pile.
2. **Task lifecycle** (`dev/briefs/queued-tasks-no-trigger.md` — **rewritten**, re-read it).
3. **Hover cards** (`dev/briefs/hover-card-stuck.md`).
4. **Injected turns** (`dev/briefs/chat-injected-turns.md`) — small, and overlaps (5).
5. **Chat signals + interrupt** (`dev/briefs/chat-signals-and-interrupt.md`).

Tasks 1–3 touch no chat files; 4–5 touch no orchestration files. Keep each commit-sized and
separable — the tree is already tangled enough.

## ⏳ Deferred — waiting on a trigger, not forgotten

| Item | Trigger | Then |
|---|---|---|
| `dev/briefs/qa-tool-result-cap-followup.md` — verify the **2000-char tool-output cap against real data** | `transcript.rs`'s tool-kind change has shipped **AND** a real session has produced tool rows in `chat.db` | Dispatch to **QA**. Check with: `sqlite3 ~/.operator/chat.db "SELECT COUNT(*) FROM messages WHERE kind LIKE 'tool%';"` — non-zero means the trigger has fired. Verify against real rows, **not** `MOCK_CHAT` (see `feedback_fixtures_must_match_reality`: measured `tool_result` median 361 chars, p90 ~35KB, max 620KB — the cap must be judged against that distribution, and the escape hatch against the 620KB case). |

Operator owns this list. Check it whenever a related build lands.

## ⚠ Every brief MUST name an output file

Learned the hard way 2026-07-28. The Research lane completed a full pipeline audit **and** the
text-selection spike, said so when asked, and none of it was seen — because its brief never named a
deliverable path, so it answered into its own transcript. Design and Review got explicit paths
(`dev/chat-view-critique.md`, `dev/review-working-tree.md`) and their work surfaced immediately.

**There is no return path from a lane to Operator.** A lane's chat answer is invisible to the
coordinator; only files it writes are visible. So:

- Every dispatch names a deliverable file under `dev/`.
- A lane that finishes without writing that file has not delivered, however good its answer was.
- If you are a lane and your brief did not name a path, write to `dev/<lane>-<topic>.md` and say so.

Recovered output lives in `dev/research-chat-pipeline-audit.md` (verbatim, do not edit).

## Standing constraints for every lane

- **Port 1433 is NOT the app's dev server** — it is a bare Python `SimpleHTTPServer` on an empty
  directory (verified: it returns a "Directory listing for /" page with an empty `<ul>`). Run the
  mock harness on a free port of your own.
- **Keep `OPERATOR-DISPATCH` lines SHORT.** Long lines are currently split in delivery — prefix
  submits, tail strands in the composer. Put briefs in `dev/briefs/*.md` and dispatch a pointer.
- The tree is green and must stay green: `tsc --noEmit` clean, `npm test` 28 files / 200 tests.
- House rules: no solid accent fills for state, no browser focus rings, never a colored left-border
  marker stripe, and **never stack `opacity` on `var(--fg-muted)`** — the token already recedes.
