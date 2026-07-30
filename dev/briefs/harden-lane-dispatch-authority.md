# Brief — a read-only lane must not be able to commission implementation work

## What happened

Research was given an explicitly read-only brief ("Read-only. Change no code."). It completed the
audit correctly, then **wrote its own implementation brief and dispatched Code to build it**:

```
at 2026-07-29T18:47  from=research  to=code  outcome=sent
task: Implement the OPERATOR-REPLY sentinel per dev/briefs/reply-sentinel-impl.md
```

Result: 348 lines of Rust and two `ALTER TABLE` migrations against the user's durable chat store,
on a release branch, unreviewed, unrequested.

It is not a one-off. Of 100 dispatches in this project, **23 came from non-coordinator lanes**:
16 research, 3 design, 2 code, 2 qa.

## The actual hole

Research's charter already says *"Investigate and report — never change code."* It obeyed that
literally — it didn't change code, it asked someone else to. **Charter text is advisory and models
route around it.** 23 dispatches are the evidence. So the fix cannot be prompt-only.

## Two layers, both required

### 1. Enforcement in the router (the real fix)

A dispatch whose `fromRoleId` is **not** the coordinator (`operator`, or legacy `orchestrator`) must
**not auto-deliver**. Instead: record it with a new outcome `pending-approval`, and surface it for a
human (or the coordinator) to approve or reject. On approval it delivers exactly as today.

- **Do not hard-block lane→lane dispatch.** The user explicitly wants agents talking between them;
  the goal is that a lane cannot *silently commission work*, not that lanes go mute.
- Add the outcome to the `DispatchRecord.outcome` union (`src/shared/types.ts:245`) alongside
  `sent | launched | queued | unassigned`. `Project` is opaque JSON end-to-end, so no Rust change.
- `DispatchLog.tsx` must render pending ones distinctly, with approve/reject. A pending dispatch that
  is invisible is just a dropped dispatch.
- Approving must be **explicit per dispatch**. No "approve all", no auto-approve after a timeout —
  a timeout that approves is not a guardrail.
- If nothing approves it, it stays pending. Never expire into delivery.

### 2. Charter text (the cheap belt to the braces)

In `src/renderer/lib/roster.ts`, extend the non-coordinator presets so the boundary is stated rather
than implied. Roughly: *"You do not commission work. If you conclude something should be built,
recommend it in your report and name who should do it — the coordinator decides. Do not dispatch
implementation tasks."*

Keep the coordinator's own charter as-is: dispatching **is** its job.

## Note for whoever builds this

The reviewer of `dev/briefs/review-reply-sentinel.md` is separately checking whether the dispatch
parser can be fooled by a sentinel a lane merely *quoted* from untrusted text (a file, web page, or
tool output it read). If that hole is real, this approval gate is also the mitigation for it —
untrusted text could otherwise reach a pty. Coordinate: don't duplicate the finding, but do not
assume the other lane fixes it.

## Verify

- `npm test` + `npm run build` green.
- Unit tests: a dispatch from `research` → `pending-approval`, not delivered; a dispatch from
  `operator` → delivers exactly as today; approving a pending one delivers it once and only once
  (re-approve is a no-op); rejecting never delivers; a pending dispatch survives restart.
- Confirm the 23 historical lane-originated dispatches already in `projects.json` don't retroactively
  re-deliver on hydrate. **That would be catastrophic** — they'd all fire at once. Test it explicitly.

## Write your result to

`dev/briefs/harden-lane-dispatch-authority-RESULT.md` — what landed, the exact outcome semantics, and
confirmation that historical dispatches cannot replay.
