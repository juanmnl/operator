# Result — Cut the mailbox, keep the log

Branch `operator/inbox-cut-mailbox` off `origin/main` (`d22538b`), one commit
`0d4dc79`. 22 files, +935 / −725.

---

## 1. What was removed

**The mailbox, at every layer it reached.**

| Removed | Where it lived |
| --- | --- |
| `unreadCount`, `unreadByRole` | `lib/inbox.ts` |
| The tab badge (`INBOX 3`) | `CanvasPanel.tsx` — `unreadCount` prop + the `9+` clamp |
| The whole per-lane panel | `InboxPanel.tsx` (deleted, 172 lines) |
| The `inbox` panel tab | `DashboardView.tsx` — `PanelTab` union + all three tab sets |
| Ack-on-open + `mark unread` | `InboxPanel.tsx`, then `env.d.ts`, `operator-bridge.ts`, `electron/src/shared/operator-api.ts`, `electron/src/main/ipc.ts` |
| The per-row unread dot and the unread/acked weight shift | `InboxPanel.tsx` |
| `ReportState`'s third value (`acked`) | `lib/comms.ts` |

**Only one of the three badges was actually built.** The rail marker and the
coordinator's toolbar chip were written down as "next" in a `DashboardView`
comment and never shipped — the tab badge was the only live consumer of
`unreadByRole`. That comment is gone with the rest.

**The ack cut goes all the way down.** `artifactMarkAcked` / `artifactMarkUnread`
are removed from the renderer contract (`env.d.ts`), the Tauri bridge stub, the
Electron `SPEC` table and the Electron IPC handler map — so no surface can ack
again, and `Record<ApiMethod, MethodSpec>` still typechecks exhaustively in both
directions (verified: the SPEC table compiles clean against the edited
`env.d.ts`, which is the whole reason that table is a `Record`).

**Deliberately left:** the `acked_at` column and `chat-store.ts`'s
`markReportAcked` / `markReportUnread`. Nothing writes them any more, but the
historical values are how ~300 already-opened rows read as `delivered` rather
than as `written` (= "the announcer is broken"). Dropping the column would turn
real history into a false alarm; deleting two tested store methods buys nothing.

---

## 2. What was kept, and why

**`written` vs `delivered`.** Untouched, and now the *only* distinction a report
carries. A `written` row means a report reached the database and reached nobody
— the exact silence-that-looks-like-success this record exists to make
checkable. It is inked as a warning in both surfaces and labelled **"reached
nobody"** rather than "unread", because nothing reads any more.

A legacy row with `ackedAt` but no `deliveredAt` maps to `delivered`, which is
true of every one of them: it was opened, and opening required being shown.

**The `chipForOutcome` discipline, extended.** Every dispatch label still comes
from the shared vocabulary, imported, never rewritten. Two additions in that
spirit:

- `DispatchRow` now carries the **raw `outcome` enum** next to its chip. The
  approve/reject affordance branches on `outcome === 'pending-approval'`, never
  on the label string — my first pass string-matched `held · ` and that is
  precisely how the second, disagreeing vocabulary that `inbox.ts` and
  `dispatch-outcome.ts` both record got born the first time.
- `reportStateLabel()` is now the single source for the report half's two words,
  used by both the timeline and the task card. The report side never gets the
  chance to grow the duplicate the dispatch side once had.

**The record itself.** Sent dispatches with their outcome, received reports, and
blocked replies *with the specific brake that stopped them* — including the
brake's own persisted `note`, rendered as the `ⓘ` line, which had existed since
the brakes shipped and was displayed nowhere until the Inbox rendered it. That
survives intact.

---

## 3. Per-lane vs project-wide — **project-wide**

The brief left this open. My call, with the reasoning:

**1. The failure this repo has actually suffered is a cascade, and a cascade is
only visible side by side.** The hop-limit budget is *one scalar per lane*, so
ordinary hub-and-spoke traffic can trip it and a brake in one lane starves the
coordinator until the whole fleet goes quiet. Read one lane at a time, that is
six unrelated quiet panels; read as one timeline, three `hop-limit` rows in
ninety seconds is the shape of the thing. There is a test for exactly this
(`projectComms` — "a brake cascade is only visible side by side").

**2. Per-lane was the mailbox chore wearing a navigation costume.** Answering
"did anything come back?" meant opening six panels and holding six answers in
your head. Deleting the unread badge while keeping six places you have to visit
in turn would have removed the counter and kept the triage.

**3. A diagnostic is consulted whole.** The record's remaining job is "something
looks wrong — what happened?" That question is asked about a *moment*, not about
a lane. "What happened around 14:32" is answerable on one timeline and is six
lookups on six.

**4. The direction is cheap one way and expensive the other.** A lane filter is
a row of chips on top of a project-wide list; reconstructing project-wide from
per-lane is not something the UI can do at all. I did not build the filter — the
project's own log is short enough that filtering is a solution to a problem
nobody has yet, and it is one afternoon whenever it appears.

**What per-lane loses:** you can no longer read a lane's traffic from inside its
own session panel. In exchange the reports that matter — the results — moved
onto the tasks, which live in the same project view as the timeline. The Board
answers "what came of this work" and the log answers "what moved and what
stalled"; neither of those questions was well served by a per-session tab.

**Project scoping is now real.** `inboxFor` filtered by `toRole` and never by
project, so one app-wide poll fed every lane's panel regardless of which project
a report came from. `reportsOfProject` filters on `projectId` — and *keeps*
rows with no `projectId` rather than dropping them, because an unattributable
row appearing under every project is visible and correctable, while a silently
missing report is neither.

---

## 4. What the record became

`DispatchLog.tsx` → **`CommsLog.tsx`**. Not a new surface beside it: the old
dispatch log was already the project-wide half of this, already on the Team tab,
already collapsed by default, already the only place the agent↔agent brakes are
visible. Adding reports to it was the whole job. Two overlapping project-wide
lists would have been the "two places that can disagree about one fact" the
brief warns against, reintroduced one screen over.

**It is no longer called "Inbox"** — the header reads `COMMS · 42`, and the only
number beside it is `N needs approval`, which is a fact about the world that
stays true until you act on it, not a chore that clears by being looked at.

**It renders its header even at zero.** The old `DispatchLog` returned `null`
with no records, which makes an empty surface indistinguishable from a broken
one — the exact ambiguity this record exists to remove. At zero it now says what
is true and names the call that fills it.

**Row grammar, one for both halves:** `time · from → to · text · state`.

- A dispatch prints its `chipForOutcome` label, with the `held · ` prefix
  dropped (the row's tint already carries it) and the four-branch tone map
  intact.
- A report prints `reported` or `reached nobody`, and is the **only expandable
  row** — that is its kind marker, and it is honest: a report is the only half
  with a body to open. A dispatch's text is already the whole of it.

---

## 5. Where a result surfaces on the task

**On the Done card, beside its diff.** `DoneCard` gains a `Result ▸` toggle
whenever a lane filed a report naming that task; it expands under the card in
the same bordered container `TaskDiffCard` uses, because it is the same gesture
on the same card. What the lane *said* sits next to what it *changed*, prose
first.

**The join is `taskId`, exactly, and nothing else.** The tempting fallback —
"a report from this task's lane, timestamped between `startedAt` and `doneAt`"
— attaches a result to work that never claimed it, and a lane that runs three
tasks in an afternoon gets three wrong answers that look exactly like right
ones. A task with no report shows no Result control at all: absence is a true
statement, and the unattached report is still in the timeline. Tested
(`reportsForTask` — "never guesses").

**Multiple reports are listed, not reconciled.** A lane can file twice against
one task and the second is not a correction of the first — it is the next
instalment. All of them show, oldest first.

**`written` shows up here too.** A result on a card that reached nobody is
marked `reached nobody` in warn ink, with the mechanism in its tooltip.

**One shared `ReportBody`** renders the summary and artifacts (16 KB cap, same
markdown-freeze reason as the chat panel) for *both* the card and the timeline.
Two windows onto one record, never two renderings of it.

**Attachment rate is the open edge.** `taskId` is optional on the MCP tool and
supplied by the lane. The worker charter already asks for it ("the taskId if it
came from one"), so this improves as lanes comply; until then those reports live
in the timeline, which is exactly why the timeline had to stay.

---

## 6. Design details worth naming

- **The Done card's meta row now wraps.** It can carry three verbs (Result,
  Diff, Requeue) and in a four-column board that left the agent chip a few
  pixels wide. Wrapping only changes what happens *at overflow*, where today the
  row silently crushes everything to its left. Scoped to `DoneCard`; the other
  cards' rows are untouched.
- **Both expanded bodies are bounded and self-scrolling** (340px) — the same
  reason `.tb-title` clamps to three lines and `TaskDiffCard` caps its diff at
  300: one expanded report must not push the rest of the Done column off screen.
- **`overflowWrap: anywhere` on report prose.** Reports quote paths, URLs and
  branch names, and `pre-wrap` alone will not break one — in a 330px board
  column that is a card scrolling sideways.
- **Warn ink is the measured `color-mix(--color-warning 50%, --fg)`** in both
  new surfaces, never the raw token (which measures 3.05 / 3.03 / 1.86:1 as
  small text on the three light palettes). No new colour, no hardcoded value, no
  opacity stacked on `--fg-muted`.
- **A designed focus indicator** for the report expand control
  (`.comms-expand:focus-visible`, inset box-shadow) — nine lines of CSS, matching
  `.tb-btn:focus-visible`, inset so a dense row cannot clip it and a shadow so no
  element ever animates a border colour. Plus `aria-expanded`.
- **Tooltip on a report headline is capped at 400 chars** — a native `title` on
  a 4000-word summary renders as a screen-tall tooltip you cannot dismiss.
- **A non-breaking space** binds `Dispatches appear` in the empty state, so
  the sentence after the full stop cannot begin with one stranded word.
- **Themes:** every value is a token or a `color-mix` on one; nothing was
  hardcoded, so light and dark follow the palettes as before. Empty, overflow
  and `written` states are all handled above. **Not GUI-verified — that is the
  user's**, per the brief.

## 7. Copy that changed outside the UI

The coordinator's charter (`roster.ts`, `REPORT_INBOX`) told Operator that
"reports arrive in your Inbox … an unacked one is still waiting". Both facts are
now false. It says instead that a report is announced when the lane goes idle and
its full text stays on the task it names, and in the project's Comms log either
way. `Silence means no report` is unchanged, and its test still passes.

`announcement()` no longer ends `— full text in Inbox`. It points at the task
when the lane named one, and at the Comms log otherwise.

---

## 8. Tests

`inbox.test.ts` → **`comms.test.ts`**, 31 tests (was 24). No coverage of a
delivery state was deleted:

- Every `chipForOutcome` case survives — `undelivered` is still asserted to read
  "sent · never started" and not "held", `rejected`/`unassigned` still muted, the
  four brakes still warn, the brake `note` still carried verbatim.
- `written` / `delivered` keep their tests; the `acked` case became **"reads a
  LEGACY acked row as delivered"**, so the mapping is pinned rather than dropped.
- Legacy `toRole`-less rows still route to the coordinator; artifacts are still
  parsed defensively against three malformed shapes.
- New: project scoping (including the keep-the-unattributed rule), the cascade
  ordering, the report/dispatch key collision, `reportStateLabel`, and four on
  `reportsForTask` — the id join, the refusal to guess, instalment ordering, and
  state carry-through.

```
tsc --noEmit                    clean
vitest run                      962 passed | 33 failed (69 files)
vitest run comms.test.ts        31 passed
vitest run roster.test.ts       43 passed
vitest run task-board.test.ts   11 passed
electron SPEC exhaustiveness    clean
```

**The 33 failures are pre-existing and environmental, not mine.** They are
`localStorage is undefined` in five DOM-dependent files
(`terminal-options`, `rail-foot`, `lane-accents`, `ghost-probe`,
`forgotten-projects`) — none of which import anything I touched. Confirmed by
stashing the whole change and running them against a clean `origin/main` tree in
this worktree: **identical 33 failures**. This worktree had no `node_modules`,
so `npm install` resolved a jsdom that does not expose `localStorage` on the
global; on the user's own checkout these pass.

`electron/` has no `node_modules` here, so its full `npm run typecheck` could not
run. The one thing that mattered — `SPEC` still being an exhaustive
`Record<ApiMethod, MethodSpec>` after two methods left `env.d.ts` — was
typechecked in isolation and is clean. The other edit there is a handler removal
from a `Partial` map, which cannot break.

---

## 9. Deliberately left

- **`acked_at` and its store methods.** §1.
- **No lane filter on the timeline.** §3.4.
- **The Comms log stays on the Team tab.** The Board is where you *act* on work;
  Team is where the incident controls already live (the agent↔agent kill switch
  moved there for the same reason). A diagnostic belongs with the other things
  you reach for when something is wrong.
- **`DashboardView.tsx` edits are deletions plus two lines.** −33/+15: the import,
  the `PanelTab` union, the three tab arrays, the `unreadCounts` memo, the
  `unreadCount`/`inboxTab` props — plus `reports={reports}` on `ProjectView` and
  four comments that named a surface that no longer exists. No logic moved, no
  handler changed, nothing reordered. It should rebase cleanly under the other
  two lanes.
- **Not GUI-verified.** Per the brief.
