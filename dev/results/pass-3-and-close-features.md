# Result — pass 3, auto-close, close from the rail (Code lane), 2026-09-06

Brief: `dev/briefs/pass-3-and-close-features.md`. Branch: `operator/e78fc0`, rebased onto
`d21fbf2`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1072 pass / 0 fail** |
| `cd electron && npm test` | **498 pass / 0 fail** |
| `cargo test` | **188 pass / 0 fail**, 3 ignored |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |
| `cargo build` | clean, zero warnings |

---

## Review-2 blockers

### A — the chip gate was dead, and a permission prompt was never the risk

`tunable = live && phase === 'idle'` is unreachable: grepping both tailers for `'idle'` returns
nothing, and `derive_phase` returns only running / compacting / waiting. The chips were disabled on
every tracked lane.

**The brief's open question — can either tailer tell a permission prompt from an ordinary "your
turn"? Yes, and it already does.** A lane awaiting approval has an assistant `tool_use` block with
no `tool_result`, so `openTools` is non-empty and `derivePhase` returns `running` on its second
branch. The chips are disabled throughout a permission prompt, so enabling on `waiting` does not
reopen the bare-CR risk. No CR risk is left undocumented, because there is none on this path.

**Change.** `isBetweenTurns(phase)` in `comms.ts`, used by both `canAnnounceTo` and the chips —
one definition, since two surfaces now ask the same question. `idle` stays in the set because
`SessionPhase` still declares it and a session with no transcript legitimately has no turn in
flight.

**Fixture.** `dev/qa-real-bridge.ts` hardcoded `phase: 'idle'` in three places — a fixture more
permissive than reality, which is what validated a gate that could never fire (the failure
`feedback_fixtures_must_match_reality` names). Now `waiting`. `drive-tuning-chips.mjs` gains a
check 0 that asserts the chips are **enabled** on a `waiting` lane and names the pre-fix build by
its symptom, so the old build fails loudly rather than through a mystery locator miss.

### B — "latest session wins" sorted by tokens

`bySession` arrives sorted by tokens, so last-writer-wins described the **biggest** session. A lane
long since moved from Opus/xhigh to Sonnet/medium was still reported — and argued about by the
card — at its old settings. Now keyed on `lastTsMs`, carried on `LaneRow`.

**Tests:** the newest session's model and effort win over a 900× bigger older one, while tokens
stay the sum; and it is order-independent, so the engine's sort cannot change the answer.

---

## Review-2 residuals

**#1** — `provesOwnServer`'s deep-process gate now requires a **positive** `DEV_SERVER_RE` match.
The exclusion list alone let a build step or a language server stand in as proof the sibling was
serving the port, which is the same shape as the bug it replaced, one filter narrower. The
duplicate definition in `dev-servers.ts` is deleted and imported instead — the two had **already
drifted** (different alternations), and `port-alloc`'s carried a bare `\bserve\b` that matches
`--mcp-serve`, so Operator's own helper read as a dev server. Only test ordering kept that from
mattering, and ordering is not a guard. `serve` is dropped; `http-server` stays, being a real
package name that cannot collide.

**#11** — `retryScanWithoutV6` now takes the same exclusions the scan applied (leases and this
process's own reservations) and returns a fresh port, so `shared` stays false. Without the lease
check the fallback would hand out a port another instance holds — the original failure with the
bind-check bypassed. The v6 tally is **per scan** (`beginPortScan`), not per process: a
process-lifetime counter accumulates ordinary orphan refusals across hours of launches and would
eventually declare a healthy host v6-less.

**C** — the cwd match now takes the role from whichever saved session claimed the row. Reading it
from the uuid match alone threw away the `roleId` the cwd match had already found, so a resumed
lane — the entire reason the weak pass exists — fell through to "Not attributed" while its own
saved session sat there naming the role. The cwd match is weaker about *which* lane, not about
what that lane is. And the unattributed row no longer borrows a project name from the slug: it
renders `—`, because a real project name on that row reads as "this project's lane", which is the
one thing the row exists not to say. Two tests.

**D** — `getTuning` computes one `sinceMs` and hands it to both halves. They each derived their
own from `Date.now()`, milliseconds apart — seconds apart on a 30-day scan over every project
directory — so a tool row could belong to a session the lane table had already excluded.

**E** — `AgentSession.effort` is now read: the toolbar's effort chip shows the **live** transcript
value with the launch pin as fallback, so a mid-session `/effort` (including one typed straight
into the terminal) is visible where the pin cannot see it. `AgentSession.compactions` is
**dropped** from both shells — nothing read it, and the count the Tuning page actually uses comes
from the usage engine, which spans the whole window rather than one live session. That is a
deliberate narrowing of the earlier brief's "compaction counts in both tailers": the counting
capability is intact and has a consumer; the tailer's duplicate had neither.

---

## Auto-close: a report counts as done

`reportedDoneAt` was fed only by `task_status(id,'done')`, and the measurement decides it — over a
month the fleet called `report` 643 times and `task_status` 5. The lifecycle was keyed on the call
nobody makes, so in practice no lane was ever closable by having **finished**; only the went-quiet
timer ever closed anything.

**Change.** `doneStampsFrom(signals, lanes, now)` in `lane-lifecycle.ts` folds both sources into
`terminalId → newest ISO`, applying the scoping rules: the lane must be open here, a signal
carrying a project must agree with the lane's (absent is fine — a lane that reported before
`sessions.json` caught up still has a matchable terminal id), and anything older than an hour is
ignored because `terminalId` is a per-run counter that collides across runs. `DashboardView` feeds
it from the reports poll.

**It weakens no guard it sits behind.** `laneCloseDecision` still refuses a lane with open work, a
busy phase, or focus.

**Tests (10)** including the two the brief asked for: a report-only lane becomes closable once the
keep-warm window passes, and the same lane does **not** close while it still has open work — a
report is a statement about a message, not a promise the queue is empty.

---

## Close from the rail

1. **`closing` on the tile.** The rail said nothing at all: you pressed Close and the project sat
   there looking untouched until the last pty died. It now shows the gallery card's own
   `closing…` in the same muted register with no fill, so the row does not reflow, and the answer
   to "did my click land" is on screen before the first pty dies. Expanded only, for the same
   reason `previous` is.

2. **The `⋯` trigger on the group header**, per `project_close_project_affordance`: revealed on
   hover or focus, absolutely positioned so it costs no layout at rest (the name's ellipsis point
   never moves), painting the row's own background so it composites onto the hovered row. Both
   widths — 18×16 at the expanded width, 14×14 collapsed. Opens the existing menu at the existing
   right-click coordinates, so the two routes cannot drift.

   **Both of the design's traps are handled.** Hover state and the `hoverCard` ref moved to the
   ROW wrapper — with them on the name button, moving the cursor toward the `⋯` leaves the button,
   clears `hover`, and the trigger vanishes from under the pointer reaching for it. And it carries
   `data-popmenu-trigger` plus `aria-expanded`, without which `useDismiss` closes-then-reopens.

3. **The confirm is keyed on action identity.** `Close project · end N agents` carries a live
   count, so with the label as the key, one agent exiting between the two clicks changed the key
   and the second click **re-armed instead of firing** — two clicks on a confirm and nothing
   happens, which reads as the app ignoring you. `confirmKeyOf` is exported and guarded by four
   tests, one of which pins the label instability that caused it.

4. **`drive-close-project.mjs` rewritten against the rail** rather than retired. It drove the
   gallery card's `⋯` — the one surface that already had the verb — so it could not have covered
   the affordance that was missing. It now drives the rail row, and asserts the three new
   properties: the trigger takes no space at rest, is revealed on hover, and carries the
   dismissal hooks; the first click arms and the second fires; and `closing…` is on the rail
   before the ptys die.

---

## Not done

- Nothing merged.
- **No GUI verification.** The rail affordance is the part that most wants it — hover reveal,
  absolute positioning at two widths, and the composite against the row background are all
  visual, and `drive-close-project.mjs` needs a mock server running to exercise them. Everything
  with pure logic behind it is covered by the suites.
- The Tuning page's own result file and report are still outstanding, along with its visual
  harness, which times out.
