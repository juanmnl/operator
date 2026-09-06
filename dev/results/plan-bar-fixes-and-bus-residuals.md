# plan-bar Review fixes + the last two bus findings

Brief: `dev/briefs/plan-bar-fixes-and-bus-residuals.md` (main `13c5785`). Two independent pieces of
work: three Review findings on `operator/plan-bar`, and findings 4 and 7 from my own
`dev/results/dispatch-over-bus.md` on main.

---

# Part 1 — `operator/plan-bar`, ready and NOT merged

Rebased onto main (`687ed06`) cleanly, two commits replayed with no conflicts, then one commit on
top: `acaffce`.

## A (HIGH) — `contextTokens` outside the sidechain guard, in both tailers

Confirmed in both files. The assignment sat inside the `usage` / message-id block, which is outside
the sidechain guard directly above it — the guard whose own comment states the principle being
violated ("A SUBAGENT'S model is not the lane's model").

A subagent's first assistant record carries its own message id and its own `usage`: a fresh context
of maybe 15k. That overwrote the main thread's 780k reading, so for the whole life of any subagent
the cell flipped between near-full and near-empty — and read "fresh" at exactly the moment the lane
was closest to compacting, which is the only moment the reading is load-bearing.

Guarded in both tailers. **The cumulative totals above it are deliberately left unguarded**: a
subagent's tokens really were spent, so they belong in the lane's cost. "How full is the context
right now" is a single-thread quantity and mixing threads has no defensible reading. The Rust test
asserts both halves of that distinction in one place — the reading holds at 780k while
`usage.cache_read` reaches 795k.

**Verified as a real guard**, not just a passing test: with the guard removed the new test fails on
each side (Electron 1 of 24 failed; Rust `a_sidechain_turn_does_not_overwrite_the_main_threads_context`
FAILED), and passes with it restored.

**One structural change came with it.** Electron's `Track` and its `apply()` are now exported, so
that tailer can be driven from a test the way the Rust one already could. The asymmetry was doing
real harm rather than being untidy: this defect existed identically in both halves, and only one of
them had a seam to catch it through. The two tailers are maintained in lockstep by hand, so they
need equal test surfaces or the hand-maintenance is unverifiable on one side.

## B (MEDIUM) — the 1M window cannot be read off a transcript model

Review's evidence stands: no `message.model` value on this machine carries `[1m]`. So the marker can
only arrive from a roster pin or a hand-typed id, and a lane switched to long context inside Claude
Code (`/model sonnet[1m]`) keeps its old pin and gets a 200k denominator — 400k then reads as 200%
full, pinned red with the bar clamped.

`inferContextWindow(pinned, used, previous)` decides in the brief's order:

1. the pin carries `[1m]` → 1M;
2. `previous` was already 1M → 1M (sticky);
3. observed context **strictly above** 200k → 1M, because a 200k lane cannot hold more than 200k;
4. otherwise 200k.

Strictly above, not at: a lane exactly at its window is full, not over it.

**The stickiness is the part that is easy to miss.** Without it the window narrows again at the next
compaction, and a 1M lane sitting at 150k would read 75% full and "about to compact" when it is in
fact 15% full — a new wrong answer replacing the old one. The state is one `Map<sessionId, number>`
in `ContextCell`, keyed per session so one lane's answer never carries to another; the decision
itself stays pure and tested.

`pct` is also capped at 100. With the window inferred that should never bind, but a percentage over
100 is not a thing to render, and the cap makes it unrepresentable rather than merely unlikely.

## C (LOW-MED) — no plan reading outside a session

`railFootPlanText` puts the binding limit and its percentage back into the rail foot as **text** —
`Week 42%`, or `42%` when the rail is collapsed to 70px and the label will not fit.

- **Not a foot item.** `lib/rail-foot` and `dev/drive-rail-invariant.mjs` assert which items are
  present at rest, and the fold's cut depends on that count staying at four. This sits between the
  rows as type, so the resting tier is untouched.
- **Hidden while a session is open**, expressed at the source: `DashboardView` passes `null` for the
  limits when there is an active session. Two readings of the same three limits on screen at once
  would invite the reader to look for a difference between them.
- **Null when unknown, never 0%.** `no-reading`, `window-closed` and `loading` all yield no rows,
  and a reading that quietly renders 0% while the data is missing says "plenty left" on no evidence.
- It opens Tuning, which restores the "What's driving this" entry point Review noted had gone with
  the popover — the one the usage-view design argued was the highest-value one, because it sits
  where the question actually gets asked.

Labels are shortened for the rail (`Current week` → `Week`): alone in the foot, that first word
carries nothing and costs a third of the line. The per-model row keeps the CLI's own label, which is
not ours to trim.

## Gates (plan-bar)

Renderer 1141, electron 525, cargo 197 passed / 3 ignored, tsc clean in both projects, both builds
clean.

`dev/drive-rail-invariant.mjs` needs a dev server, so I ran one on this session's reserved port
(1427) and drove it. It reports **5 failures — and reported the same 5 on the branch tip before my
changes**, with `|Δfoot y|` 0.00 either way and glyph spread 130.00 vs 130.50. They are pre-existing
on this branch and none of them is the foot reading. I did not chase them: they are outside this
brief, and they are named here rather than left for someone to rediscover.

**Not merged**, per the brief. Ready when Juan says so.

---

# Part 2 — the last two bus findings, on main

## 4 — unanswered requests now expire

`openDispatches` selected `WHERE answered_at IS NULL` with no age cutoff, and `pruneDispatches` only
ever deleted *answered* rows. The failure is the app being closed while lanes keep running — they
are ptys, and `--mcp-serve` is spawned by `claude`, not by Operator. Each dispatch inserted a row,
blocked 15s, timed out, and correctly told its caller that nothing was sent and no task was created.
The next morning's first poll read every one of those rows and acted on all of them, making that
message retroactively false.

`expireDispatches(ttl)` answers each too-old row `refused` with a reason saying so, and
`openDispatches` calls it first — in the same method, so no caller can read a stale row by
forgetting to sweep.

**Answered, not deleted.** The row is the only record the request ever existed, and `refused` with a
reason is a true statement about what became of it.

**TTL is 30s against the server's 15s timeout.** Past 15s the answer can no longer reach anyone, so
the row is dead either way — but the two are different processes reading different clocks, and
expiring a request a lane is still waiting on is the worse mistake of the two. The test pins the
relationship (`DISPATCH_TTL_MS > 15_000`) rather than the number, so the reason survives a change to
either value.

## 7 — registry liveness and the duplicate tie-break

`readBusSessions` now drops a descriptor whose process is gone (`pidAlive`) or whose socket file is
missing, and resolves a duplicate `sessionId` deterministically (`preferSession`: newest `startedAt`,
higher pid breaking an exact tie, a stamped descriptor beating an unstamped one) with a `console.warn`
naming both pids and the winner.

`pidAlive` uses `kill(pid, 0)` and treats **EPERM as alive** — the process exists and belongs to
someone else. Getting that backwards would drop a real lane from the registry. It is deliberately
not `lsof`: a per-pid `lsof` fires a macOS TCC prompt per process, which this repo learned the
expensive way.

**Measured before building it**, so the claim is sized honestly: of 20 live descriptors on this
machine right now, 20 have live pids, 20 have existing sockets, and there are 0 duplicate session
ids. Claude Code cleans up after itself in the ordinary case. This is the SIGKILL path — a process
killed outright never gets to clean up — not routine hygiene, and it is worth saying so rather than
implying the registry was full of corpses.

### One thing this turned up that was worse than the finding

The existing `session-bus.test.ts` fixture was transcribed from a real machine: pid `19287`, socket
`/tmp/cc-socks/19287.sock`. Adding the liveness check should have failed those tests. It did not —
because **that pid really is alive on this machine**, and so is `2004`. The suite was passing on a
property of the developer's laptop, and would have failed on anyone else's machine and in CI, in a
way that looks like the new code breaking rather than the fixture never having been hermetic.

Rewritten to be self-contained: `process.pid` for the live case, real socket files inside the
sandbox, and PID 0 for the dead case. This is worth flagging beyond this brief — it is the same
class as `feedback_fixtures_must_match_reality`, one step further along: a fixture that matched
reality *too literally*, and silently depended on it.

## Gates (main)

Renderer 1106, electron 530, cargo 192 passed / 3 ignored, tsc clean in both projects, both builds
clean.

---

## Not done

- **Nothing is GUI-verified.** The rail foot's text reading, the context cell's inferred window and
  the hide-while-a-session-is-open rule have not been seen in a real window; the rail driver
  measures geometry, not this.
- **The 5 pre-existing `drive-rail-invariant` failures on `plan-bar` are untouched** — accent
  fixture, axis paint at 41.75, glyph spread, and both rhythm checks.
- **Finding 4's expiry has never fired in anger.** It is unit-tested with backdated rows; the real
  scenario needs the app closed overnight with lanes running.
- `pruneDispatches` still has no caller. Expired rows are answered, so they are now inside its
  remit, but nothing sweeps the table on a schedule yet.
