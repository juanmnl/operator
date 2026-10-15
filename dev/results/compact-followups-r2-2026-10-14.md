# Compaction follow-ups, round 2 — 2026-10-14

Branch `operator/63300`, based on `operator/b3a2c0` @ d0fe20c, then merged with main a29c015.
Commits: 103db5e (the fix), 43c7fa2 (merge of a29c015). Review this branch instead of
`operator/b3a2c0`: it contains d0fe20c.

Input: `dev/results/compact-followups-review-2026-10-14.md` (Review).

## What changed

All changes are in `electron/src/main/transcript.ts` and `transcript-compact.test.ts`.

1. **Change (2) dropped.** `<bash-input>`, `<bash-stdout>` and `<bash-stderr>` are no longer in
   `isLocalCommandEcho`. A `!` command again sets `lastWasUserPrompt` and clears `turnEnded`, so
   the lane reads `running` until the reply, and a compaction before the reply reads `compacting`.
   - **The caveat case is handled as an echo.** New field `Track.bashUnqueried`: set by a
     `<local-command-caveat>` record. The bash records that follow it are echoes. The bash output
     record clears it, and any other text record clears it too. The caveat in front of a slash
     command (caveat, `<command-name>`, stdout) therefore never carries over to a later `!`
     command.
   - **Evidence that the caveat marks the no-query case:** I re-ran the count on disk. 145
     `<bash-input>` records, 144 not preceded by a caveat, 1 preceded by one:
     `-Users-juanmnl-Developer-mantel/963ff5e9-….jsonl` line 10680 (2.1.272). That command hit its
     120 s timeout and was moved to the background, which is one of the binary's no-query
     conditions (`backgroundTaskId`). No assistant record followed it; the next turn started from a
     `<task-notification>`. This matches Review's reading of the 2.1.300 handler.
   - Every `<bash-stdout>` on disk is its own single record, with stderr inside it (145 of 145).
     `<bash-stderr>` is still matched as a bash record in case it is ever written on its own.
   - The extracted prefix list is now `isBashModeRecord`. The caveat decision is in the private
     `Track.isEcho`.
2. **Tests added** (10 new, 1 removed: the old "`!` bash mode leaves the lane `waiting`"):
   - `turnEnded`: a boundary straight after `turn_duration` reads `waiting`. A real prompt clears
     it. A main-thread assistant record clears it. A sidechain assistant record does not. A
     main-thread enqueue clears it.
   - `!` bash mode: reads `running` from the command until the reply, then `waiting`. A compaction
     before the reply reads `compacting`. After a caveat it reads `waiting`. The caveat covers its
     own command only.
   - The notice race: a prompt written between the compaction and the notice reads `running` after
     the notice, both with and without a `turn_duration` before the boundary.
   - **Mutation check:** I removed each fix in turn and re-ran the file. Each removal failed at
     least one of the new tests: the enqueue clear, the conditional notice clear, the caveat
     rule, the caveat's reset, the prompt's `turnEnded` reset, and the assistant's
     `turnEnded` reset.
3. **Review's lows, both fixed (each is a few lines):**
   - **Enqueue-only turn start (finding 2).** A main-thread `queue-operation enqueue` now clears
     `turnEnded`, so a compaction in that window reads `compacting`, not idle. I did not make the
     enqueue set `lastWasUserPrompt`. If a queued prompt is withdrawn without starting a turn, a
     set flag would leave the lane reading `running` until its next turn. A wrongly cleared
     `turnEnded` costs much less: the next idle boundary reads `compacting` until the notice,
     which is the rule that applied before `turnEnded` existed. So the 1 s `waiting` read in that
     window remains. The pty override covers it.
   - **Microtask race (finding 3).** The idle notice clears `lastWasUserPrompt` only if the track
     was still `compacting` when the notice arrived. A real prompt in between has already ended the
     compaction, so its flag survives. When the boundary followed `turn_duration`, the flag was
     already cleared by `turn_duration`, so the notice has nothing to clear. The existing test
     "the idle notice alone clears a stale prompt flag" still passes.

## Verification (on the merged tree, 43c7fa2)

- `electron/`, `npm run typecheck`: clean, both tsconfigs.
- `electron/`, `npx vitest run`: 51 files, 936 tests passed. Review reported 926 on the earlier
  merge. The difference is the 10 net new tests.
- Repo root, `npx vitest run`: 117 files, 1778 tests passed.
- The merge of a29c015 had no conflicts. The `api-request` skip in `poll()` is kept.

## Not done

- d0fe20c's commit message still says that `!` bash records join the echoes. That commit is
  already on `operator/b3a2c0`, and I did not rewrite it. 103db5e's message records the reversal.
- The lane note `dev/results/compact-followups-2026-10-14.md` from round 1 still describes
  change (2). This file supersedes it.
- Not GUI-verified.
