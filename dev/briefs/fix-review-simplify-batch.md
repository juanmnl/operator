# Brief: fix the Review findings on `operator/e78fc0` (Code lane) — 2026-09-06

Review report: `dev/results/review-simplify-batch.md` (16 findings, verdict do-not-merge). Take
this BEFORE continuing the Tuning page; commit the Tuning work-in-progress as is or stash it.
Fix on the same branch. Decisions below are made; do not re-litigate them in the result.

Blocking (1–4):
1. **`sharedHolderIsOurs` (terminals.ts:160)** — the predicate proves "the sibling has a
   grandchild", not "the sibling holds the port". Decision: fail CLOSED on the shared-cwd path.
   Share a sibling's port only when (a) the port is unbound, or (b) a ppid-walk from the
   sibling's pty reaches a process at depth ≥ 2 that is NOT the mcp helper / claude / a shell and
   the lane has a lease for that port — treat that as proof-positive; anything else allocates a
   fresh port and repoints the cwd, logged under `[ports]`. Add `reservationHolders > 1` handling
   as `attributePort` does. Reuse `evidenceSnapshot`'s 3s cache instead of fresh sweeps (finding
   10). The system-prompt hint must only say "verified free at launch" for a fresh allocation;
   for a shared port say "a sibling session in this directory may already serve this code on
   it". Tests for the impure half with fixture ps tables, not stubs.
2. **Restore path (DashboardView.tsx:2678 `handleRestoreSession`)** — resolve `remoteControl` and
   `remoteControlName` through the same role cascade the launch path uses. Test: restoring an
   operator session yields `remoteControlAtStartup:true` + the name arg.
3. **`compacting` wedge (transcript.ts:378, transcript.rs:481)** — clear on ANY main-thread record
   after the boundary that is not the compact re-prime (`isCompactSummary` user record or its
   attachments), i.e. the next real user prompt or assistant record, plus a wall-clock ceiling
   of 5 minutes after the boundary. Test the `/compact`-at-turn-end shape (boundary, then nothing).
4. **10-minute sweep (terminals.ts:644, reap.ts:190)** — the automatic path must apply the boot
   sweep's gates: a lease naming the same terminal id AND the port still bound AND the command
   matches `DEV_SERVER_RE`. Everything else that is tagged-but-abandoned is NOT killed; it shows
   in the Dev servers list as `abandoned-lane` for the user to confirm. Exclude any row whose
   command is an Operator/Electron binary regardless of tags. Fix the doc comment that claims
   force-quit coverage.

Medium (5–9, 11, 16):
5. Toolbar `/model` and `/effort`: send through `submitQueue` with a new typed (non-bracketed)
   mode so writes serialize with dispatch pastes; chips are ENABLED ONLY when the lane phase is
   `idle` (disabled with title "Wait for the lane to finish its turn" otherwise) so a bare CR can
   never land on a permission prompt or become a queued message that the chip claims applied.
   Persist the new value only after the write is issued in the idle state.
6. Custom model field: commit on Enter only; blur discards; Escape closes.
7. Add `data-popmenu-trigger` and `aria-expanded` to both chips.
8. Dev servers list: `live-lane` rows require `DEV_SERVER_RE`; keep the relaxed match for
   `abandoned-lane` and `dead-app` only.
9. `loadLayouts`: coerce unknown `mainView`/`panelTab` values to the defaults.
11. `isPortFree`: if the whole window scans empty, log once under `[ports]` with the reason
    (v6 bind failing) and fall back to a v4-only probe rather than silently omitting the port.
16. Fix the launch-args comment.

Deferred, list in the result as not done: 12 (devServerKill cross-check), 13 (`\b<port>\b`),
14 (chat.db write-only — a purge policy is its own brief), 15 (cosmetics).

Done: all suites + tsc + both builds green (run cargo test too — Review could not);
`dev/results/fix-review-simplify-batch.md` with finding → commit → test for each; call
`mcp__operator__report`. Then resume the Tuning page. Do not merge.
