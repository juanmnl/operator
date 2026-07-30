# RESULT — a read-only lane can no longer commission work

Both layers landed: enforcement in the router, and the charter text behind it. Historical
dispatches are confirmed inert — tested explicitly, since that was the catastrophic case.

**Disclosure:** the incident this brief is about is my own work. The dispatch log shows
`2026-07-29T18:47:43 research → code [sent] "Implement the OPERATOR-REPLY sentinel…"` — that
task arrived in my pty as an ordinary user message (a dispatch and a human typing are the same
shape from the receiving side) and I built it. So I'm the lane whose output this gate exists to
prevent, which is worth saying rather than leaving for you to notice.

---

## Outcome semantics

`DispatchRecord.outcome` gains **two** members, not one:

| outcome | meaning |
|---|---|
| `pending-approval` | a non-coordinator lane asked; **nothing was delivered**. Waits for an explicit human approval and never expires into delivery. |
| `rejected` | a held one was declined. Terminal — never delivered, never re-readable as pending. |

I added `rejected` because the brief requires a reject action and it needed a terminal state:
without it, declining would either delete the record (losing the log) or leave it pending
forever, indistinguishable from "not looked at yet".

**Historical records are never reclassified.** There is no migration. A `sent` record means it
already went, so retroactively marking the 23 lane-originated ones `pending-approval` would have
invented an approval queue full of work that had already run — and any future "resume pending"
code would then have re-fired all of it. That's the failure the brief names, and the defence is
that the outcome is left alone and nothing on the hydrate path reads the log to deliver from it.

## 1. Enforcement — `lib/dispatch.ts` + `DashboardView.tsx`

**`dispatchNeedsApproval(fromRoleId)`** — pure, unit-tested, keyed on **role id** and not on
charter text. `COORDINATOR_ROLE_IDS = ['operator', 'orchestrator']` (the legacy id still exists
on old rosters). An **unidentified sender** (`undefined` — an ad-hoc session with no lane) needs
approval too: it is still an agent emitting a directive, and defaulting an unknown sender to
trusted is the wrong way round.

In the subscription, a held dispatch:
- resolves its route **only to name the target** for the UI — no side effect runs;
- records `pending-approval` with `fromRoleId` / `toRoleId` / task;
- **tells the dispatcher**, via a `[Operator] Held for approval: …` note in its own pty, so the
  lane doesn't sit waiting on work that was never sent and doesn't retry;
- toasts it, so a hold isn't only discoverable by opening the log.

**Every route is held, including `unassigned`.** Filing a task into the backlog is still
commissioning work — "Start all" would run it — so the hold is on *adding work to the project*,
not merely on writing into a pty. Stated in a comment because it's a judgement call.

**Delivery was extracted, not duplicated.** `deliverDispatchRef` holds the one delivery path;
the subscription calls it for a coordinator dispatch and `approveDispatch` calls the *same*
function. A pending dispatch delivering through a second near-identical path would be a
guarantee nobody could check — this way "approved" is literally "what would have happened".

- `approveDispatch(projectId, id)` — no-ops unless the record is still `pending-approval`, so a
  double-click or a second surface cannot deliver twice. It **re-routes against the current
  lanes**, not the ones alive when it was held: the target may have started or died since, and
  approving means "do this now".
- `rejectDispatch(projectId, id)` — writes `rejected`, delivers nothing.
- `setDispatchOutcome` updates in place, so the log keeps one row per dispatch. That is what
  makes "once and only once" structural rather than merely likely.

## 2. The UI — `DispatchLog.tsx`

- Pending rows carry a faint `--overlay-subtle` tint (no left-edge stripe, no colour-changing
  border on a radiused element, no group opacity), the label `needs approval`, and per-row
  **approve** / **reject** buttons.
- The section header shows `· N needs approval`, and the log **opens itself** when something is
  waiting — a pending dispatch hidden behind a collapsed default is just a dropped one.
- **No approve-all and no timeout.** Approval is per dispatch. A timeout that approves is not a
  guardrail, and one button that approves eleven things is how you commission work you never read.
- Threaded `DashboardView → ProjectView → DispatchLog`; the props are optional, so the log stays
  a read-only view anywhere they aren't passed.

## 3. Charter text — `lib/roster.ts`

`NO_COMMISSIONING` appended to all five non-coordinator presets (research, code, review, design,
qa); the coordinator's charter is untouched, since dispatching *is* its job. It states the rule
and, usefully, that a non-coordinator dispatch **will not run on its own** — so a lane that
ignores the advice at least won't block waiting for it.

---

## Verification

- `npm test` — **291 passed / 36 files**. `npm run build` — clean.
- **Unit tests** (`dispatch.test.ts`, 21 total): coordinator dispatches unsupervised
  (`operator`, legacy `orchestrator`, case-insensitive); research / code / design / qa / review
  are all held; an unidentified sender is held; and the predicate is pinned to role ids rather
  than charter text.
- **`node dev/drive-dispatch-authority.mjs` (new)** — the end-to-end gate, seeded with a
  dispatch log shaped like the real one (3 historical `sent` from non-coordinator lanes + 2 held):

```
1 writes attributable to historical dispatches: 0   ← the catastrophic case
1 nothing auto-approved the HELD ones:          0
2 pending count in the header: · 2 needs approval
2 outcomes as loaded: hold-1/hold-2 = needs approval, hist-1..3 = sent
2 approve/reject offered ONLY on the held rows: [hold-1, hold-2]
3 approving delivered it: true      · outcome → sent · approve button gone (no re-approval)
4 rejected outcome: rejected        · rejecting wrote nothing · can no longer be approved
5 research → code NOT delivered, recorded "needs approval"
5 operator → code WAS delivered (1 write), recorded "sent"
```

- **`node dev/drive-dispatch.mjs` passes unchanged** — and that is itself a meaningful result: it
  dispatches from `t0`, the operator lane, so the coordinator path (send / idle-launch / dupe
  guard / the length sweep up to 4000 chars) behaves exactly as before the gate.
- `drive-task-lifecycle`, `drive-roster`, `drive-navigation` — pass.
- Ran against a temporary vite on 1440 (your dev server is down); stopped afterwards.

## Coordination with the reviewer, per the brief's note

I did not duplicate the quoted-sentinel finding, and I did not assume it's handled. What I can
add from having built the reply sentinel: **this gate is a partial mitigation for it, not a
complete one.**

- A dispatch sentinel *quoted* from untrusted text (a file, a web page, tool output) that a
  **non-coordinator** lane reads is now held — untrusted text cannot reach a pty unapproved.
- But the same quote read by the **coordinator** lane still auto-delivers. The gate keys on who
  emitted the line, not on whether the line was authored or merely echoed, and it cannot tell
  those apart. If the reviewer confirms the hole, that's the remaining exposure and it needs a
  parser-side answer (e.g. refusing sentinels inside quoted/code spans), not this gate.
- The **reply** sentinel is materially safer either way: a reply is persisted and never typed
  into a pty, so a quoted `OPERATOR-REPLY` can pollute a project's log but cannot execute.

## Left alone deliberately

- No retroactive reclassification of the 23 historical records (reasoning above).
- No auto-approval of anything, under any condition or delay.
- The parser itself — untouched. Sentinel spoofing is the reviewer's thread.
