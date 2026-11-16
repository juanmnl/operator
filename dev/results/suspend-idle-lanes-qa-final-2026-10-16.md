# QA: idle-lane suspension, final GUI pass on cd5df8b (branch operator/1a7f80), 2026-10-16

Earlier passes: `suspend-idle-lanes-qa-2026-10-16.md` (376b23b) and `suspend-idle-lanes-qa-r2-2026-10-16.md` (7aebaa9). Nothing was fixed or edited by QA.

**QA recommendation: do not merge until D2 and O2 are fixed and the close-project check is done by hand.** Two defects reproduced on cd5df8b (D2, O2 below). One merge-gate item (closing a project ends its suspended lanes) could not be exercised. Everything else I could reach passed.

Screenshots: `dev/results/suspend-idle-lanes-qa-final-2026-10-16-shots/` (names in the table).

## How it was run

- `git archive cd5df8b` into the scratchpad (so a lane releasing its worktree could not break the build again), `node_modules` cloned from an earlier export. Dev build with `OPERATOR_DIR=<scratchpad>/opdir4` (never `~/.operator`), port 1431, CDP 9344. Driven over CDP: real key and mouse events, screenshots, DOM text, plus `ps` and the lanes' `.jsonl` transcripts.
- Idle limit `localStorage['operator.lane.idleSuspendMinutes']='1'`; quiet-close limit `operator.lane.quietMinutes` set to 2, 1, 5 or 120 for individual checks. Tuning page not used for these (the control itself was checked in the 7aebaa9 pass).
- Lanes: Operator (coordinator, dispatcher), Research, Design (worktree lane, committed `marker.txt` on branch `operator/f208c0`), and QA, which was never given a turn on purpose (for D2).
- Timing: ticks are fixed per renderer boot (suspend tick every 60 s, lifecycle tick every 30 s, same phase). Timed clicks and keys were fired from a script within 0.1-0.4 s of a known tick.
- "No duplicate or orphaned claude": `ps` grouped by session id after each step; at most one process per session at every check, and 0 left after shutdown.

## Merge gate (Review's "Merge verdict" list)

| Item | Result | Evidence |
|---|---|---|
| A lane suspends and resumes on focus | **Pass** | App driven. ⌘N, rail-row click (after a crash relaunch, `f-16-click-resume.png`). Same session id, one process. |
| Resume on typing | **Pass** | ⌘ on suspended Research, then `the quick brown fox` typed at once with no pause: the whole line showed in the resumed composer, unsent (`f-03-typed-at-suspended.png`). Held-text count as a draft not checked. |
| Resume on dispatch, with no duplicate CLI | **Pass** | Board "Send →" to a suspended Research and to a suspended Design: each task text is one user record in the lane's transcript (KIWI-41 at 19:12:16.268, FIG-52 at 19:12:16.248), one assistant reply each, `ps` shows one process per session (`f-10-after-timed-sends.png`). In 7aebaa9 the sentinel, MCP and reply routes also gave one record each; not repeated here. |
| A dispatch sent while a suspend is starting resumes the lane, no "never started" toast | **Pass** (one timing) | Research was suspended by the tick at 19:12:12.09 and the Send click was fired at 19:12:12.285 (0.2 s after the tick start). The lane was resumed by that dispatch and the text arrived once. The page text had no "never started" / "did not get" string about 15 s later; toasts that fade sooner would be missed. The kill window itself (before the tab is marked suspended) was not hit; one try only. |
| Resumed lane not suspended again inside the idle window, including after ⌘R | **Pass** for focus, dispatch and ⌘R; **Fail** for project resume | Focus path: Design resumed 19:07:10 by ⌘4, page reloaded (⌘R equivalent, `location.reload()`) at 19:07:11, lane unfocused: still up at the 19:08:06 window, suspended at the first tick past 60 s (19:08:12, 62 s after spawn). Project resume fails: see O2. |
| A suspended worktree lane closes at the quiet limit; a dispatch during that close resumes on its own branch with its commits | **Pass** | Design suspended 19:14:12, quiet limit 2 min. Lifecycle tick 19:14:42.095 closed Research; the Design worktree directory shows birth time 14:14:42 (removed and re-created), the dispatch click was at 19:14:42.250. The task text arrived once (user record 19:14:46.292); the lane answered `branch=operator/f208c0 commits=2`; the worktree on disk is `operator/f208c0` at `1a2ad45 design marker` with `marker.txt` (`f-11-after-close-dispatch.png`). Later the project-resume card also brought Design back on `operator/f208c0` with the commit. |
| Closing a project ends its suspended lanes | **Not tested (inconclusive)** | The project menu says "Close project · end 1 agent": it counts the live lane only. Its confirm is a second click ("— click again"). With a synthetic double click the app left the project view for the gallery, but 90 s later the live Operator process and both suspended rows were unchanged (`f-13-after-close-project.png`, `f-14-gallery-close.png`). Real mouse clicks on the item only reset the label. I cannot tell whether the confirm was not satisfied by my automation or the close did nothing. Needs a manual click-through by a person. |
| Relaunch and crash restore suspended lanes as suspended | **Pass** | `kill -9` of the dev Electron with Research and Design suspended and Operator live: "previous run: unclean", Operator auto-resumed (1 claude process), rail showed `RESEARCH SUSPENDED` and `DESIGN SUSPENDED`, no CLI started for them (`f-15-crash-relaunch.png`). Clean-quit relaunch with suspended lanes passed on 7aebaa9 (0 CLIs after relaunch) and was not repeated with suspended lanes on cd5df8b; a clean quit and relaunch here (without suspended lanes) worked normally. |
| Rail row renders (dimmed orb, word "suspended") | **Pass** | `f-01-three-suspended.png`: `RESEARCH SUSPENDED ⌘2`, `DESIGN SUSPENDED M ⌘4`, dimmed orbs. |
| The overlay text renders | **Not tested** | Never on screen. With a burst of screenshots from 65 ms after ⌘N the first frame is already the new blank pane (`f-qa-0067ms.jpg`); the overlay only stays visible if a spawn throws, which I could not cause. |

## Round 3 and Round 4 "Not done" additions

| Item | Result | Evidence |
|---|---|---|
| Typing at a suspended lane without pausing lands the whole line, unsent | **Pass** | See the typing row above. |
| ⌘R a few minutes after resuming by focus, then unfocus: not suspended on the next tick | **Pass** (shorter than a few minutes) | See the ⌘R row above. I reloaded 1 s after the resume rather than minutes after, to make the next tick fall inside the window. |
| Closing a suspended lane while clicking it leaves no orphan `claude` (`ps`) | **Not tested** (race not hit) | I pressed ⌘2 on Research at 19:24:26.401, 0.37 s before the lifecycle tick that closed Design (19:24:26.769). Research was resumed first, was not closed, and `ps` showed one process for it. The close and the click did not overlap on one lane. One try. |
| Dispatch to a suspended worktree lane during its close resumes on its own branch with its commits | **Pass** | See the merge-gate row. |
| Pane shows "A message was not delivered" after a 30 s hang | **Not tested** | I could not produce a hang. |

## Defects and observations

**D2 (reproduced on cd5df8b). A lane suspended before its first turn cannot be resumed and is lost.**
- Repro: Start QA from the "+" menu and send nothing; focus another lane; wait for the next tick after 60 s (QA suspended at 19:06:06). Press ⌘3 on its row.
- Seen: the pane prints `No conversation found with session ID: d2c6d2a4-6ecd-461d-bbac-4858fec8c5fa`, then "Session ended"; the QA row disappears from the rail (`f-02-d2-qa-lost.png`, `f-qa-3239ms.jpg`). There is no `.jsonl` for that id: Claude Code writes the transcript only after the first message.
- Consequence: any lane the user started and did not use is lost the first time it is suspended. I found this stale row offered again by the project-resume card ("RESUME 4 AGENTS" included it), which then failed the same way.
- Also seen on 7aebaa9 (`suspend-idle-lanes-qa-r2-2026-10-16.md`, D2 and D3: any failed resume drops the lane from the rail, and I saw no toast). Likely cause: `resumable` is true as soon as the hook gives a session id. Fix direction (for Code): do not suspend a lane whose transcript has no turn, or resume it as a fresh session.

**O2 (reproduced on cd5df8b, twice). A lane resumed by the project-resume card is suspended again on the first tick, inside the idle window.**
- Repro: with 2 live non-coordinator lanes and one idle limit of 1 min, quit through the quit guard, relaunch, click "RESUME N AGENTS" on the project's Team view. Research and Design resumed at about 19:25:38 (Operator's spawn time in `last-run.json` is 19:25:37.9) and were suspended at 19:26:03.18 and 19:26:03.85: 26 s after the resume, with a 60 s limit. Their transcripts were last touched at 19:12 and 19:14. (First seen on 7aebaa9: a lane suspended 13 s after the same click.)
- The same lanes were not suspended early when resumed by focus, dispatch, or the rail-row click after a crash. So the spawn time that H1's fix reads is probably not set on the project-resume path.
- Consequence: the card's lanes are put back to sleep within a minute and the user has to resume them again.

**O1. The roster on the Team tab shows suspended lanes as live** (carried over from 7aebaa9): `LIVE · 4` with `LIVE` badges while two of those lanes had no CLI (`r2-19-relaunch-rail.png` in the r2 shots).

**O4. The project card's menu count excludes suspended lanes.** "Close project · end 1 agent" with two more suspended lanes on the rail. May be intended (they own no process); noted because it is the text the user confirms.

## Tuning, setting and other checks carried over

- Tuning page "Idle lanes" control: Off / 15 / 30 / 60 / 120 min wrote `0` and `15` to `operator.lane.idleSuspendMinutes` (7aebaa9 pass; not re-checked on cd5df8b).
- Exclusions (focused lane, unsent text, background Bash, dev server): passed on 376b23b/7aebaa9; not repeated on cd5df8b.
- Quit guard counts live lanes only ("2 agents are still working" with 2 suspended lanes present).

## Not tested on cd5df8b

The overlay frame and the click/typing resume at the overlay, the "not delivered" overlay, the session-bus dispatch route, the exclusions list repeated on this commit, the close-project check (inconclusive above), a click landing on the close of the same suspended lane.
