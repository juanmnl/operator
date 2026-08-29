# Brief — Cut the mailbox, keep the log

## The decision (user, 2026-08-29)
The user said plainly: "i don't like the concept of the inbox, why is it
needed?" After walking the code with them, the settled call is:

**Keep the durable per-lane comms record. Delete the email client built on top
of it.**

## Why the record stays — do NOT delete this part
`src/renderer/lib/inbox.ts`'s own header records why it exists, from the comms
audit:

  > a report that reached the database was exactly as invisible as one that was
  > never sent. `artifactReports` was wired at the IPC layer and called from
  > NOWHERE in the renderer.

This repo has been bitten TWICE by silence that was indistinguishable from
success: reports never reaching Operator, and the hop-limit delivery brake
eating replies with a 3.5s toast and no board entry. The durable list — sent
dispatches + their outcome, received reports, blocked replies WITH the specific
brake that stopped them — is the only thing that turns "no report arrived" from
a guess into a checkable claim. That value is real. It survives.

## What goes — the mailbox metaphor
All of it, in `inbox.ts` and `InboxPanel.tsx`:

- `unreadCount` and `unreadByRole`, and the THREE badges they feed: the rail
  marker, the tab badge, and the coordinator's toolbar.
- Ack-on-open (`artifactMarkAcked` on expand) and `mark unread`.
- The per-row unread dot and the unread/acked weight shift.
- The `ReportState` third value if `acked` becomes meaningless once nothing
  acks. `written` vs `delivered` MUST stay — `written` sitting there means the
  reader is broken, and the surface saying so is the whole point of an audit
  trail rather than a list.

Three reasons this half fails, for your judgement while cutting:
1. The reader is usually an AGENT, not the user. "Acked" records that an
   automated read happened — it measures the wrong thing while looking
   authoritative.
2. It is a chore whose only reward is clearing itself. Precedent: undelivered
   dispatches piled up seven deep and needed a Dismiss bolted on.
3. It duplicates task state. The settled direction is that the WORK is the
   primary object (Backlog·Running·Waiting·Done). "Lane finished, here is the
   result" is a task moving to Done carrying its output. Recording it a second
   time as mail gives two places that can disagree about one fact.

## What replaces it — your call to make well
The result belongs ON THE TASK. A finished task should carry its report, so the
user reads the outcome where they were already looking. Decide and justify:
- how a report attaches to its task in the Done state
- what the lane-level record becomes once it is no longer a mailbox (it should
  read as a diagnostic you consult when something looks wrong, not a pile that
  demands triage) — including whether it keeps the name "Inbox", which it
  probably should not
- OPEN QUESTION the user has not answered, so make the call and state your
  reasoning: does the record stay PER-LANE (as built, answering "what happened
  with this lane") or become ONE PROJECT-WIDE TIMELINE? Project-wide is better
  for spotting a brake cascade ACROSS lanes, which is the failure this repo has
  actually suffered. Per-lane matches the current code.

## Constraints
- Branch off `origin/main`, NOT local main (it has diverged: 11 unpushed
  commits, and a merge conflicts in 4 files).
- **Keep `DashboardView.tsx` edits minimal and tightly localized.** Two other
  lanes and a pending main reconciliation all touch that file right now.
- Every outcome label keeps coming from `chipForOutcome`, imported, never
  rewritten — `inbox.ts` and `dispatch-outcome.ts` both record a past bug where
  a local copy disagreed with the shared one.
- `inbox.test.ts` exists. Update it; do not delete coverage of the delivery
  states you keep.
- Do not GUI-verify — that is the user's.

## Deliverable
`dev/results/inbox-cut-the-mailbox.md`: what you removed, what you kept and why,
the per-lane-vs-project-wide decision with its reasoning, where a result now
surfaces on the task, test results, and anything you deliberately left.
