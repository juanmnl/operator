# Review round 5: suspend idle lanes (operator/80eb00, cd5df8b..7f103f8), with a merge verdict

Reviewer: Review lane, 2026-10-16. Scope: `git diff cd5df8b..7f103f8` (16 files, +563/−34), read against:
- the transcript tailer's `findTranscript`;
- the per-project env policy (which names a project may set);
- `closePlan` and the rail's sessions;
- the exit handler that runs after `exitCompleteRef`;
- the real transcripts on this machine (record shapes and lookup cost);
- the installed Claude Code 2.1.301 binary (where `--resume` decides "No conversation found").

QA's input: `dev/results/suspend-idle-lanes-qa-final-2026-10-16.md`.

7f103f8 descends directly from cd5df8b, and main is still 68fb94d. I extracted 7f103f8 with `git archive` and ran:
- the root suite: 122 files, 1895 tests passed, matching Code;
- electron `transcript-turn`, `transcript-background` and `last-run` tests: 53 passed.

I did not run the full electron suite. Nothing was run in the app. Only Medium and above are detailed.

## QA's findings: status

| Finding | Status | Checked |
|---|---|---|
| D2 lane suspended before its first turn could not be resumed | **Fixed** | The suspend decision now needs `conversation === true`. It reads the transcript only for lanes that pass every earlier rule, and caches positives only. An unknown result keeps the lane up. `resumeSuspended` checks before it spawns, and refuses with a toast for a lane that has no conversation. The failed-resume watch now reads `lastRecordAt`, which stays absent until a record is read, so a `--resume` that wrote nothing is no longer taken as a lane that came back. `backToSuspended` puts the tab back as suspended, with its session id and quiet time, adds it to `wakeFailedRef` and re-reports main's list. The exit handler's later `{ ended: true, selfExited }` update keeps `idleSuspendedAt` and `resumeSessionId`. It sets `selfExited` back to true, which nothing reads for a suspended tab. The resume card, ⌘K "Resume project" and the per-row ⌘K items leave out known no-turn rows. A restore with `--resume` of such a row refuses, and one that does spawn is watched. |
| O2 card-resumed lanes re-suspended after 26 s | **Fixed** | The only `window.operator.terminalSpawn` call in the renderer is now inside `spawnLanePty`, which stamps `spawnedAtRef`. Launch, restore and resume in place all call it (`DashboardView.tsx:1145`, 3273, 3716, 4020). `git grep` finds no other spawn call in `src/renderer`. |
| O1 roster showed suspended lanes as live | **Fixed** | `suspendedRoles` is derived from the same tab `live` picked per role, the pill reads "suspended", and the heading counts suspended lanes apart from live ones. |
| O4 close count left out suspended lanes, and the close skipped them | **Fixed** | The label is `lanesToEnd = live + suspended`, and confirms when that is non-zero. `closeProject` now plans from `sidebarSessionsRef`, the rail's sessions. Round 2's M1 fix had changed `closePlan` but fed it the observer's sessions, so it never ran in the app. Code found this; my round-2 review missed it. |

## Requested checks

- **`spawnLanePty` covers every spawn path.** Yes; see O2 above.
- **`closeProject` on `sidebarSessionsRef`, and its new effect of ending untracked tabs.** The rail's sessions are
  built from `terminals`, one per tab. `closePlan` keeps the project's sessions that are not ended (plus suspended
  ones) and have a `terminalId`.
  - **The new effect.** A tab with no observed session is now ended too: for example, a lane launched with no
    prompt, which has no transcript yet. Before, `closeProject` left that process running and the project on the
    rail, which is the "closing left it there" bug the function's own comment describes. Ending it is what "Close
    project" promises, so I count this as a fix.
  - **What can be affected.** Nothing else in that list belongs to another project, or is a scratch shell: shells
    are not tabs, and the list is filtered by `projectId`.
  - **What closing does.** The user close path takes a WIP snapshot before removing the worktree, so no unsaved
    work is lost.
- **`sessionsWithTurn` cost.** Each id is looked up with a `stat` in every project directory until the file is
  found, the same approach as the existing `findTranscript`. Measured on this machine: 389 project directories and 47
  saved rows, of which 12 have no transcript. One cold pass is 13,566 stats (75 ms synchronously in Python). In
  main's async `fs/promises` this does not block the event loop, and is probably under a second of thread-pool time.
  - Only negatives are read again: the 12 missing rows, about 4,700 stats, each time the saved ids or the tab count
    change.
  - The suspend tick reads only lanes that passed every other rule, plus already-cached positives.
  - `hasUserTurn` stops at the first non-meta `user` record, which is near the top of a prompted transcript.
  - Acceptable. Low: no cache for negatives.
- **The "user turn" rule.** For prompted lanes it is correct.
  - **Command-only transcripts.** Whether a transcript holding only slash-command records can be resumed is not
    verified. Such records are written as non-meta `user` records with `<command-name>`. In 500 recent transcripts
    here, 415 consist of a single `/usage` record. They are Operator's own `claude -p "/usage"` plan-limit probes
    (cwd `/`), not lanes. A lane can reach this state: for example, the toolbar typed `/model` into a lane before its
    first prompt. I traced the binary to `NRe` → `fxe(id)` returning null, but could not settle from the minified
    code whether a command-only session loads.
  - **If it does not load.** The lane is suspended, the resume fails, and `backToSuspended` keeps it suspended with
    a toast. It is not lost, but it cannot be resumed, and each click spawns a CLI that fails. Low, and worth one QA
    check: give a fresh lane only a `/model`, let it suspend, then click it.
- **`backToSuspended`.** Correct, as above. One Low: a resumed lane that the user ends with `/exit` within 60 s
  reads as a failed resume. It gets the "conversation was not found" toast and is put back to suspended. That is
  harmless but says the wrong thing.

## New defect, Medium

### R5-1 (Medium). In a project that sets `CLAUDE_CONFIG_DIR`, every restore with `--resume` is now refused and its rows are hidden from the resume card

`electron/src/main/transcript.ts` `sessionsWithTurn` (looks only in `~/.claude/projects`); `DashboardView.tsx`
`handleRestoreSession` (`if (resume && saved.claudeSessionId && await hasConversation(…) === false) { toast; return 'failed' }`),
`offeredForResume`/`noTurnIds`, `resumeSuspended`.

A project may set `CLAUDE_CONFIG_DIR` in its env vars. The env policy keeps it on purpose: `denyReason('CLAUDE_CONFIG_DIR')`
is null, with a test saying that taking it "breaks the lane's auth", and `stripNestedSessionEnv` preserves it. A lane in
such a project writes its transcript under `$CLAUDE_CONFIG_DIR/projects`. `sessionsWithTurn` never looks there, so it
returns no turn for every lane of that project. On main, and up to cd5df8b, restoring such a lane with `--resume`
worked, because the CLI finds its own transcript. As of 7f103f8:
1. "Resume N agents" and ⌘K "Resume project" leave out every row of that project.
2. A restore that still asks for `--resume` (crash auto-resume, the per-row action) refuses with "It never took a
   turn, so there is no conversation to resume", which is false, and spawns nothing.
3. An idle-suspended lane in that project: the tracker cannot see these lanes either, so they have no phase and
   are never suspended. That part is safe.

This is a regression in restore for a configuration the codebase explicitly supports. The tailer has the same blind
spot (`findTranscript`), so these lanes already showed no phase. The difference is that restore used to work and is
now blocked.

Fixes, either works:
- Look up transcripts under the lane's effective config dir. Main already resolves the project's env in
  `projectConfig`.
- Treat "no file found" as unknown when the project sets `CLAUDE_CONFIG_DIR`. D2 needs "missing means none" only
  for the default directory.

## Lows (one line each)

- **R5-L1.** A resumed lane ended with `/exit` within 60 s is treated as a failed resume: wrong toast, back to
  suspended.
- **R5-L2.** No negative cache in `sessionsWithTurn`: missing transcripts are re-scanned across all project
  directories on every saved-id or tab-count change. Measured cost is small.
- **R5-L3.** Whether a command-only transcript can be resumed is unverified (above). If not, such a lane is suspended
  but cannot be resumed.
- **R5-L4.** The restore refusal says "It never took a turn" also for a transcript deleted by Claude Code's
  `cleanupPeriodDays`.
- **R5-L5.** The cold path (`handleLaunchRole` resuming a lifecycle-closed row) does not check for a conversation.
  Code noted this.

Earlier Lows still open, all errring toward keeping a lane up or ending in a visible report: L1, L2, L3, L6, L7, N4,
N5, the R3-4 notes, R4-L1 to R4-L4. L8 is now fixed as O1.

## Merge verdict for the whole branch (376b23b..7f103f8)

**From Review: approve after R5-1 is fixed, then a short QA pass, not a full one.**

- **R5-1 is the only open finding at Medium or above.** It is a small change in main's lookup, or one condition in
  the renderer. It is a regression only for projects that set `CLAUDE_CONFIG_DIR`. If the coordinator and the user
  know that no project here uses it, R5-1 can be a follow-up instead, and the branch is approvable as is.
- **The rest of the branch is covered.** QA's final pass ran the merge-gate list in the app and passed everything it
  could reach. The two defects it found (D2, O2) and both observations (O1, O4) are fixed here, each with a test that
  exercises the real component or the wiring.
- **The short QA pass on 7f103f8.** These are the paths this round changed, which have not run in the app:
  - a lane started and never prompted stays running past the idle limit;
  - lanes resumed from the project card are not re-suspended inside the window;
  - the Team tab shows "suspended";
  - "Close project · end N agents" counts suspended lanes, and closing ends them: rows gone, no `claude` left in
    `ps`. Clicked by a person; QA's automation could not confirm the click.
- **Optional check:** a lane given only `/model` before its first prompt (R5-L3).
