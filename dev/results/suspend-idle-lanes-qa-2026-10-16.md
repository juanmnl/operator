# QA: idle-lane suspension, commit 376b23b (branch operator/b0b440), 2026-10-16

**Status: partial. Stopped at the coordinator's request** (Review found two High defects and Code is fixing them; a fixed commit will follow). Nothing here has been re-run on the fix. Nothing was fixed or edited by QA.

Screenshots: `dev/results/suspend-idle-lanes-qa-2026-10-16-shots/` (copies of the files named below).

## How it was run

- Dev build from the b0b440 worktree: `cd electron && npm run dev`, with `OPERATOR_DIR=<scratchpad>/opdir` (never `~/.operator`), `OPERATOR_ELECTRON_PORT=1431`, `OPERATOR_CDP_PORT=9344`. The `OPERATOR_*` variables of this lane were unset for the child.
- The app was driven over CDP on 9344 (real mouse and key events, screenshots, DOM text). Computer-use was not used. Every GUI result below was seen in the running app.
- Idle limit lowered to 1 minute with `localStorage['operator.lane.idleSuspendMinutes']='1'` in the renderer. The Tuning page was **not** opened, so the Tuning control (Off / 15 / 30 / 60 / 120) is untested; 1 minute is only reachable this way (the tick is read per tick, every 60 s).
- Lanes were real Claude Code 2.1.301 sessions (Sonnet) in a scratch git repo `scratchpad/proj1`: Research and QA. Operator, Design and Infra were on the roster but never launched.
- Setup notes that cost time and are not about the feature:
  - A hand-written `projects.json` was ignored on first launch of a lane: Operator created a second project `proj1` for the same path and the lanes went there. The seeded `/Users/dev/...` demo projects and sessions are written by the dev shell into an empty `OPERATOR_DIR`.
  - The first Enter on Claude Code's folder-trust prompt chose "No, exit" (the default), which ended the first lane. Later lanes got Down, Enter.
  - The dev instance's reapers logged "left pid N alone — OPERATOR_APP_PID=1256 belongs to another Operator run" for the live app's processes. They touched nothing.

## Results

| # | Check | Result | How |
|---|---|---|---|
| 1 | A lane suspends after idle | **Pass** | App driven. Research (unfocused, idle) was suspended at 13:02:39, about 80 s after its last activity (18:01:19Z), with the limit at 1 min. Its `claude` process was gone, `sessions.json` row got `idleSuspendedAt=2026-10-16T18:02:39.711Z`, and `last-run.json` gained `suspended:[{key, at}]` with `lanes` listing only QA. The rail keeps QA only. |
| 2 | Dimmed orb and the word "suspended" in the rail | **FAIL** | App driven (`02-rail-research-missing.png`, `01-after-suspend-rail-only-qa.png`), plus code read. After the suspend the rail shows only QA. The Research row is gone, so there is no dimmed orb and no "suspended" word anywhere on screen (a text search of the page for "suspend" found nothing). Cause (code read): `ProjectRail.tsx:307` `liveOf` keeps only `s.status !== 'ended'`, and a suspended lane is deliberately given status `ended` (`tabSessionStatus`, `DashboardView.tsx` operatorFields), so the rail drops it before `SessionItem` can draw the "suspended" label. The `SessionItem` change (`suspended = status === 'ended' && !!session.suspended`) is therefore never reached from the rail. A suspended lane is also no longer listed under the project rail, so the user cannot see it or click it there; it is only reachable by ⌘1-9. The Start-an-agent menu lists it as "Start Research", as if it were not running. |
| 3 | The overlay ("Suspended — click to resume", dimmed last frame) | **Not tested** | Not seen. Focus resumes at once, so the overlay is only on screen for the 1-3 s of "Resuming…" or after a failed resume. I did not capture a frame in that window. The failed-resume case was not tried. |
| 4 | Resume on focus | **Pass** (⌘1 only) | App driven. ⌘1 on the suspended Research tab: within about 3 s the rail showed Research again, the pane showed the same conversation (the earlier turn and "done 1:01 PM" intact, `03-after-cmd1-research-resumed.png`), same Claude session id `113f83fd`, same bus name `proj1-ac8e--research`, new terminal id t3, `idleSuspendedAt` cleared in `sessions.json`, `suspended` list empty in `last-run.json`. Not tried: rail click (the row is not on the rail, see #2), roster Launch, Team panel. |
| 5 | Resume on click or typing in the pane | **Not tested** | Only reachable when a resume has failed (focus starts the resume itself). I did not force a failure. |
| 6 | Resume on dispatch, text arrives exactly once (sentinel, bus, MCP, board) | **Not tested** | Not started. Plan: launch the Operator lane and have it print `OPERATOR-DISPATCH [research] <unique word>`; then count that word's user records in the resumed transcript. Also the board task assigned to a suspended role, and an MCP dispatch. |
| 7 | Exclusion: focused lane | **Pass** | App driven. QA was the focused lane and idle from 13:04:37 to 13:10:29 (about 6 min, limit 1 min), and was never suspended (`sessions.json` had no `idleSuspendedAt`, its `claude` process still ran at 08:35 elapsed). Research was likewise kept while focused. |
| 8 | Exclusion: unsent text | **Pass** (one case) | App driven. "unsent draft" was typed into Research's composer with real key events (`04-unsent-draft-in-research.png`), then focus moved to QA with ⌘2. Research stayed live through 13:10:29, about 5 min, with the limit at 1 min (`05-five-minutes-later-both-still-live.png`). Not tried: a pasted draft, Backspace-emptied draft, Enter or Ctrl+C clearing the flag so the lane then suspends. |
| 9 | Exclusion: running background Bash | **Not tested** | |
| 10 | Exclusion: dev server on the lane's port | **Not tested** | The lanes' dev-server brief found nothing to serve in the empty repo, so no server ran. |
| 11 | Relaunch keeps suspended tabs suspended, without starting their CLIs | **Not tested** | Only the on-disk part was seen: with a suspended Research, `last-run.json` held `suspended:[{key, at}]` and `sessions.json` the `idleSuspendedAt` (the data the restore reads). The relaunch itself was not run, nor crash auto-resume or the resume card. |
| 12 | A resumed lane is not suspended again within a minute (Review's High defect) | **Not exercised** | Research was resumed at about 13:04:20 and then stayed up, but it also had an unsent draft and was kept for that reason, so this run says nothing about the defect. |
| 13 | Tuning "Idle lanes" section and radio group | **Not tested** | |

## Defect found

**D1. A suspended lane disappears from the rail (the visible half of the feature does not render).**
- Repro: launch Research and QA in a project, set `localStorage['operator.lane.idleSuspendMinutes']='1'` in the renderer, leave QA focused and wait for the next 60 s tick after Research has been quiet for 60 s.
- Seen: Research's `claude` exits and the rail lists QA only. Expected per the notes: Research stays as a dimmed row labelled "suspended".
- Cause by code read: `ProjectRail.tsx:307` filters out `status === 'ended'`.
- Consequence: no way to see or click a suspended lane on the rail; the overlay and click/typing resume are reachable only through ⌘1-9. For whoever fixes it: the "N running" label, `isOnRail` and the close path also read `status !== 'ended'` (`project-shelf.ts:69`, `project-status.ts:29`), so a change in `liveOf` should be checked against those. Review's second defect (suspended lanes never close) is in the same area.

## Recommendations (to the coordinator)

- After Code's fix, re-run this pass in full. Remaining list: #3, #5, #6, #9, #10, #11, #12, #13, plus Design/Infra (worktree lanes) suspending and resuming in their worktree.
- A test for D1: render `ProjectRail` with one session `status:'ended', suspended:true` and expect its row with the word "suspended". That fails on 376b23b. Owner: Code.
- The 1-minute override exists only as a localStorage edit; if QA is to test the 15-minute option end to end it would take about 16 minutes per run. Not a request to build anything.
