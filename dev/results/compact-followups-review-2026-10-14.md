# Review: compaction follow-ups — 2026-10-14

Branch `operator/b3a2c0`, commit d0fe20c, compared with main 3c46abc; merge target a29c015.
Reviewed: the `transcript.ts` diff (`applySystem`, `applyUser`, `applyAssistant`,
`resetForReread`, `isLocalCommandEcho`), the test changes, the new fixture, and the lane's note.
No fixes made.

**Verdict: changes (1) and (3) are correct. Change (2), the `!` bash-mode exclusion, is wrong
about how Claude Code behaves, and I recommend dropping it before the merge.** That change came
from finding 3 of my earlier review (`compact-working-status-review-2026-10-14.md`), which claimed
that no assistant record follows a bash-mode command. That claim was wrong. Details are in
finding 1.

## How I checked

- I replayed every main transcript on this machine under the branch's `turnEnded` rules and
  recorded every compaction boundary, plus every main-thread assistant record that arrives while
  `turnEnded` would still be set.
- I read the 2.1.300 bash-mode code path in the binary.
- I built the merge of the branch onto a29c015 and ran tests and typecheck on it.
- I ran 5 probe cases against the merged `transcript.ts`.

## Findings by severity

### Medium

**1. A `!` bash-mode command usually starts a model turn, and the branch treats it as a local echo.**
`transcript.ts:120-126` (the `<bash-input>`, `<bash-stdout>` and `<bash-stderr>` entries).
- **Data:** 145 bash-mode commands are on disk. 144 were followed by a main-thread assistant
  record before any other prompt: the median gap is 4.2 s, p90 14.7 s, max 66 s, in versions
  2.1.270 through 2.1.296. The one exception was followed by a user prompt.
  Example: `-Users-juanmnl-Developer-operator/ff0a3ede-…jsonl` lines 942–946: `turn_duration`, then
  `<bash-input> git merge …`, `<bash-stdout>…`, then the assistant "The usage meter merged
  cleanly…".
- **Binary, 2.1.300:** the bash-mode handler returns
  `{messages:[...g?[]:[rbe()],d,<bash-stdout…>],shouldQuery:g}`, where
  `g = l && !o.interrupted && !o.backgroundTaskId && !aborted`. So the model is queried unless a
  setting (`l`) turns it off, or the command was interrupted, backgrounded or aborted. When it is
  not queried, a `<local-command-caveat>` record (`rbe()`) comes before the echo. That caveat is the
  record-level marker that tells the two cases apart.
- **Effect on the branch:** after `!cmd`, `lastWasUserPrompt` stays false and `turnEnded` stays
  true until the first assistant record, which is up to 66 s on disk.
  - Probe P1 (bash, before the reply, pty quiet): the branch reads `waiting`; main read `running`.
  - Probe P2 (bash, then a compaction before the reply): the branch never reads `compacting`.
  - The tick's pty override (`isActive` within 1.5 s) usually hides P1, because Claude Code's
    spinner keeps the pty active, so the visible effect is small. The derived state is still
    wrong, and this is the only change in the branch that moves the derived state away from
    what Claude Code does.
- **Fix direction, for Code:** remove the three bash prefixes from `isLocalCommandEcho`. For the
  no-query case, the narrower rule is "a bash record that follows a `<local-command-caveat>`
  record". That case is rare enough that dropping the entries is acceptable.

### Low

**2. A turn can start with no user record, and `turnEnded` stays set until its first assistant
record.**
Real case: `-Users-juanmnl-Developer-umbra/9f33185b-…jsonl` lines 1701–1707 (2.1.296):
`turn_duration`, `/login` as `system/local_command`, a `queue-operation enqueue "keep going"`,
then the assistant 1 s later. No `user` record was written.
- Probe P3: the branch reads `waiting` in that window. Main was the same, since the enqueue never
  set `lastWasUserPrompt`.
- Risk: a compaction written in that window would be read as idle and never show `compacting`.
  On disk that never happened (see "Questions from the brief").
- Clearing `turnEnded` on a main-thread `queue-operation enqueue` would close the gap, but an
  enqueue while idle is followed by a turn, so it would mean "a turn is about to start", which
  the `dequeue` → `user` path already covers in the normal case. Not worth adding unless it shows
  up.

**3. The idle notice clears `lastWasUserPrompt` unconditionally.** `transcript.ts:573-576`.
In the binary, `compactConversation`'s `finally` releases the turn guard before the `.then` that
appends the notice. So in principle, a queued prompt could start a turn, and write its `user`
record, between the two.
- If that happens, the notice clears the flag of a turn that is really starting. Probe P5: the
  lane reads `waiting` until the first assistant record, and the pty override hides it.
- The window is one microtask. I found no instance on disk: all 56 notices come straight after the
  compaction's own records.
- Theoretical. Only `endCompaction` really needs to run there. Clearing the flag only when
  `turnEnded` is set would remove the window, and with change (3) in place the notice's clear is
  redundant anyway.

**4. Untested: a real prompt resets `turnEnded`.**
No test covers "prompt after `turn_duration`, then a pre-turn compaction" (probe P4 shows it
correctly reads `compacting`), or the reset by a main-thread assistant record. If either reset
were dropped, every pre-turn compaction would be read as idle. One test each would pin that down.

## Questions from the brief

- **Can `turnEnded` be stale?** I replayed all main transcripts under the branch's rules:
  - All 56 boundaries reached with `turnEnded` set were followed by the idle notice.
  - All 48 boundaries reached with it clear were mid-turn and followed by an assistant record.
  - So no boundary on disk is misclassified.
  - Main-thread assistant records arriving while `turnEnded` is set: about 170. All but one are
    the bash-mode turns in finding 1. The remaining one is the enqueue-only turn start in
    finding 2.
  - Hook continuations: the continuation's `isMeta` text record ("Stop hook feedback", the
    `/goal` expansion) is a non-echo user text record, so it clears `turnEnded`.
  - Background tasks and finished subagents: these arrive as a `<task-notification>` user text
    record, which clears `turnEnded` and `lastWasUserPrompt` before the `isInjectedTurn` check.
  - Queued prompts at idle: `enqueue` → `dequeue` → `user` clears it. The enqueue-only case is
    finding 2.
- **Resumed session, or the tailer starting mid-file?** `Track.offset` starts at 0 and the tailer
  replays the whole file (`transcript.ts:180`, `poll`). A truncated or rotated file resets to 0
  through `resetForReread`, which now also resets `turnEnded`. There is no mid-file start.
  - A resumed session (Operator's crash relaunch uses `--resume`) appends to the same file, so the
    replay ends in the correct state. A session killed mid-turn has no closing `turn_duration`,
    so `turnEnded` stays false, which falls back to the notice rule.
- **Does replacing the old "compacting between re-prime and notice" test lose coverage?** No.
  That case is still covered by "without a `turn_duration` before it, reads `compacting` until
  the notice", which strips `turn_duration` from the same fixture and checks `compacting`, then
  `waiting` after the notice. "The idle notice alone clears a stale prompt flag" covers the
  notice path on the hook fixture. The missing tests are listed in finding 4.
- **Should a `!` bash command calling `notePrompt` (and cancelling a released lane's release)
  block the merge?** No. Bash mode starts a model turn in 144 of 145 cases, so a release cancelled
  by it is correct: the lane is doing new work. In the no-query case (the setting is off) it errs
  toward keeping the lane, which `prompt-kind.ts` names as the intended direction. It also
  supports finding 1: bash records are prompts, not echoes.
- **Does the branch merge cleanly onto a29c015?** Yes. `git merge-tree --write-tree a29c015
  operator/b3a2c0` reports no conflicts (it auto-merges `transcript.ts`). The `api-request` skip
  in `poll()` and the `isApiRequestLine` import are kept. On the merged tree, built in the
  scratchpad: electron `npx vitest run`, 51 files, 926 tests, all pass, and `npm run typecheck`
  is clean.

## Checked and clean

- `turn_duration` is guarded on `isSidechain !== true`. `resetForReread` resets `turnEnded`. A
  main-thread assistant record clears it, and a sidechain assistant record does not.
- **The new fixture** `compact-idle-after-hook.jsonl` matches the shape of the real 2.1.296 case
  I cited in the first review: an `isMeta` Stop hook feedback record, `stop_hook_summary`, the
  informational notices, `turn_duration`, then the idle compaction. I did not compare it record
  by record with its source.
- **Escape-interrupt test:** it matches the real 2.1.274 shape (tool_result error, then
  `[Request interrupted by user for tool use]`, then `turn_duration`).

## Recommendations for the coordinator

- **Before merging:** Code removes the three bash prefixes from `isLocalCommandEcho` and its
  test, or limits the rule to the caveat case.
- **Optional:** the two `turnEnded` reset tests (finding 4), and limiting the notice's clear to
  when `turnEnded` is set (finding 3).
- **Then merge.** The `turn_duration` and `turnEnded` changes are sound against everything on disk.

Probe file (not in the repo): `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/05545980-1a16-4848-a3e7-91b41b141178/scratchpad/tree3/electron/src/main/zz-probe2.test.ts`.
