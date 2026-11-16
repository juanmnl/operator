# Review round 6 (narrow): suspend idle lanes (operator/87c980, 7f103f8..43ead1a), with a merge verdict

Reviewer: Review lane, 2026-10-16. Scope: `git diff 7f103f8..43ead1a` (7 files, +257/−73). 43ead1a descends
directly from 7f103f8, and main is still 68fb94d. Code's notes: `dev/results/suspend-idle-lanes-2026-10-16.md`,
§ Round 6. Only Medium and above are detailed.

## Tests

- **Root suite:** 122 files, 1895 tests passed, the same as Code. Run twice, on a `git archive` copy of 43ead1a.
- **Electron, this round's files:** `project-config.test.ts` and `transcript-turn.test.ts`, 19 passed.
- **Electron full suite: I could not confirm Code's 983/983 on this machine.** The load average was 255–281
  while it ran (other lanes were running).
  - The first run had 6 failures; the second had about 20.
  - Almost all were 30 s timeouts in git-heavy tests in `worktree.test.ts`, a file this round did not change.
  - The number of failures followed the load, so I read them as environmental, not defects. Re-run the full
    electron suite on a quiet machine before merging.

## R5-1: fixed

- **Where main looks.** Main now resolves each lane's `projects` directory from that lane's project
  (`laneProjectsDir`). The order is: the project's `CLAUDE_CONFIG_DIR`, then the project's unset entry, then
  Operator's own env, then `~/.claude`. The lookup runs under that directory.
- **The test.** A project that points `CLAUDE_CONFIG_DIR` at a temporary directory finds its lane's turn there,
  while `~/.claude/projects` reads none for the same id.
- **Secret values.** A `CLAUDE_CONFIG_DIR` stored as a secret is dropped by `envForSettingsFile`, both for the
  lookup and for the launch, so the two agree.

## Unknown means keep: holds at every read

There are three call sites of `conversationsWithTurn` in the renderer. `git grep` finds no fourth.

| Read | Turn | None | Unknown |
|---|---|---|---|
| `hasConversation` (restore with `--resume`, `resumeSuspended`) | `true`, cached | `false` (refuse) | `undefined` (callers test `=== false`, so they go ahead as on main) |
| `noTurnIds` effect (resume card, ⌘K) | cached | added to `noTurnIds` (row hidden) | not added (row offered) |
| Suspend tick | `conversation = true` | `false` (never suspended) | `undefined` (kept running, read again next tick) |

On the main side, `sessionsWithTurn` adds an id to `none` in only two cases:
- the file exists but has no non-meta user record;
- the file is missing from a `projects` directory that main resolved and could list. A missing `projects`
  directory (`ENOENT`) counts as listed and empty.

Each of these leaves the id unknown:
- a null directory: an unknown project id, or a config dir that is relative or empty;
- a directory that cannot be listed (anything other than `ENOENT`, including `ENOTDIR` and `EACCES`);
- a malformed id.

A thrown IPC call is unknown on every renderer path. Restore and resume are refused only on a definite `none`.

## The `projectConfig` move: no change for callers

- `readProjectConfig` is the old body of `projectConfig`, line for line: the same `store.loadProjects()` (the same
  `./store` module ipc.ts imports), the same resolvers, and the same denylist pass on the way out.
- Its only behavioural difference is returning `null` for an unknown project. The `projectConfig` wrapper turns
  that into `{}`, and keeps its own `try/catch`, which logs and returns `{}`, as before.
- The only caller is `terminalSpawn`, unchanged. The electron typecheck passed.

## Medium or higher

None.

## Lows (one line each)

- **R6-L1.** A `CLAUDE_CONFIG_DIR` exported only in the user's shell profile reaches lanes through `$SHELL -ilc`,
  but not main when the app is opened from Finder. Main then looks in `~/.claude`, reads "none", and refuses or
  hides those restores. Code documented this. For such a user the transcript tailer is already blind to every
  lane, which predates this branch, so I rate it Low. Fixing it means main reading the login shell's env.
- **R6-L2.** A saved id that appears under two project ids is looked up once, under whichever row comes first.
- **R6-L3.** Every `conversationsWithTurn` call re-reads `projects.json` once for each distinct project. The cost
  is small.

R5-L1 to R5-L5 and the earlier Lows are unchanged, as the brief allowed.

## Merge verdict for 376b23b..43ead1a

**Approved from Review, on two conditions:**
1. **The full electron suite passes on a quiet machine.** I could not confirm it here under a load average of
   about 270. The failures were timeouts in files this round did not touch.
2. **The short QA pass from round 5 is done on this commit or on 7f103f8.** That pass covers: an unprompted lane
   stays running; card-resumed lanes are not re-suspended; the Team tab shows "suspended"; and "Close project"
   counts and ends suspended lanes, clicked by a person. Round 6 changes only the transcript lookup, so a pass on
   7f103f8 still holds, except where a project sets `CLAUDE_CONFIG_DIR`.

There is no open finding at Medium or above across the six rounds.
