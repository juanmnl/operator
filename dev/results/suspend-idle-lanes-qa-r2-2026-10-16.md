# QA: idle-lane suspension, round 2, commit 7aebaa9 (2026-10-16)

Superseded by the final pass on cd5df8b (`suspend-idle-lanes-qa-final-2026-10-16.md`), which the coordinator asked for before this pass was finished. Written up as it stands. Nothing was fixed.

Screenshots: `dev/results/suspend-idle-lanes-qa-r2-2026-10-16-shots/`.

## How it was run

- Same setup as round 1: dev build, scratch `OPERATOR_DIR` (`scratchpad/opdir3`), port 1431, CDP 9344, driven over CDP (real key and mouse events, screenshots, DOM text). Never `~/.operator`. Lanes were real Claude Code 2.1.301 sessions (Research, QA, Operator, Design) in the scratch repo `scratchpad/proj1`.
- Idle limit set with `localStorage['operator.lane.idleSuspendMinutes']` (1 min, 3 min for one check). Quiet-close limit with `operator.lane.quietMinutes` (3, then 120).
- The first run served from worktree `operator-528280`, which was deleted while the app ran (the Code lane released it). The build broke and a lane failed to start; that is not a finding. The pass was redone from `git archive 7aebaa9` extracted into the scratchpad, with the same `node_modules`.
- Transcript counts below are from the lanes' `.jsonl` files under `~/.claude/projects/`.

## Results

| Check | Result | How and evidence |
|---|---|---|
| D1: suspended lane has a rail row, dimmed, with the word "suspended" | **Pass** | App driven. Rail rows read `RESEARCH SUSPENDED ⌘2`, `QA SUSPENDED ⌘3`, dimmed orbs (`r2-03-rail-suspended.png`). |
| D1: "+" menu no longer offers "Start X" for a suspended lane | **Pass** | App driven. With Research and QA suspended the menu listed only Start Design and Start Infra (`r2-04-menu.png`). |
| D1: clicking the rail row resumes the lane | **Pass, with a caveat** | Clicking the DESIGN row started its CLI. In that run the transcript had been moved aside on purpose (see D3), so the resume itself failed; the click path was exercised, a successful click-resume was not. Resume by ⌘ focus and by dispatch did succeed. |
| Resume on focus (⌘N) | **Pass** | App driven, 3 times. Same conversation, same session id, new terminal id, `idleSuspendedAt` cleared. |
| H1: resumed lane that loses focus is not suspended again inside the idle window | **Pass** (focus and dispatch paths) | App driven. Research resumed by dispatch 13:35:31, I focused then left it, idle limit 3 min: suspended 13:39:34, 4 min after spawn. Design resumed by reply 13:47:21, limit 1 min: suspended 13:48:34, 73 s later. Neither was suspended inside its window. See O2 for one lane that was. |
| Dispatch text arrives exactly once, sentinel route (`OPERATOR-DISPATCH [research]`) | **Pass** | The suspended lane was resumed with the text as its opening prompt. The transcript has one user record with the text and one assistant reply. |
| Dispatch text exactly once, MCP route (`mcp__operator__dispatch`) | **Pass** | One user record. The sender was told "RESUMING it now". |
| Reply text exactly once (`OPERATOR-REPLY [design]`) | **Pass** | One user record. Not tested: the session-bus route (SendMessage to a bus name). |
| Keys typed at the overlay land in the composer unsent | **Pass** | App driven. ⌘2 on suspended Research, then `hello` typed at once: after the resume the composer showed `❯ hello`, nothing submitted (`r2-07-after-resume.png`). Not checked: that the held text counts as a draft and keeps the lane up. |
| Overlay frame ("Suspended — click to resume", "Resuming…") | **Not tested** | Not seen. With a burst of 7 screenshots from 65 ms to 3.2 s after ⌘N, the first frame is already the new, blank pane (`r2-burst-qa-0065ms.jpg`); the spawn replaces the overlay at once. The overlay stays on screen only if a spawn throws, which I could not cause. |
| Click or typing at the overlay resumes | **Not tested** | Same reason. |
| Suspended lane closes at the quiet limit | **Pass** | Quiet limit 3 min. Research suspended 13:48:34 (last activity 18:46:29Z); closed 13:49:34. Its rail row and tab were removed, `sessions.json` row got `suspendedAt`, `idleSuspendedAt` cleared, `last-run.json` `suspended` list emptied (`r2-16-after-quiet-close.png`). The clock runs from last activity, not from the suspension. |
| Closing a project ends its suspended lanes (M1) | **Not tested** | Not reached. |
| Background Bash excludes the lane (#9) | **Pass** | QA ran `sleep 1500` with `run_in_background`. Limit 1 min. It stayed up from 13:33 to 13:51 and over the next relaunches' first ticks, while an idle sibling suspended in 80 s. |
| Dev server excludes the lane (#10) | **Pass** | Design started a detached `python3 -m http.server 1621` (foreground Bash call with `nohup … &`, not a background task). Limit 3 min then 1 min. It stayed up 9 minutes idle. I killed the server at 13:46:19; Design was suspended at 13:46:34. |
| Unsent text excludes the lane | **Pass** (round 1) | See `suspend-idle-lanes-qa-2026-10-16.md`. |
| Focused lane excluded | **Pass** (round 1) | Same file. |
| Relaunch after a crash (`kill -9`) keeps suspended tabs suspended | **Pass** | Research and Design suspended, QA and Operator live. After the relaunch `last-run` said "previous run: unclean", crash auto-resume started QA and Operator only, the rail showed Research and Design `SUSPENDED`, and `ps` showed 2 claude processes (`r2-19-relaunch-rail.png`). |
| Relaunch after a clean quit keeps them suspended | **Pass** | SIGTERM on the dev Electron raised the app's quit guard: "2 agents are still working", counting QA and Operator and not the suspended lanes (`r2-20-quit-guard.png`). After "Quit and end them", `last-run.json` had `clean:true`, lanes `[qa, operator]`, and the suspended keys kept. Relaunch: 0 claude processes, rail rows suspended (`r2-22-clean-relaunch-rail.png`). |
| Project resume ("RESUME N AGENTS") leaves suspended lanes alone | **Pass** | After the relaunch the card resumed Operator, QA and one stale row, and left Research and the new Design suspended (`r2-23-after-project-resume.png`). The second time (card "RESUME 2 AGENTS"), 2 claude processes started and the two suspended lanes stayed down. |
| Tuning "Idle lanes" control | **Pass** (partly) | The section is on the Tuning page with Off, 15, 30, 60, 120 min. Clicking "15 min" wrote `'15'`, "Off" wrote `'0'` (`r2-14-tuning.png`). Not checked: the selected-state styling, that Off stops the tick. |

## Defects

**D2. A lane suspended before it has had a turn cannot be resumed; the lane is lost.**
- Repro: start QA from the "+" menu and type nothing. Focus another lane. After the idle limit QA is suspended (it is idle, has a session id, no transcript). Press ⌘ on its rail row.
- Seen: the pane prints `No conversation found with session ID: a715f201-…` in red, then "Session ended". The QA row disappears from the rail, no toast was found in the page text, and `sessions.json` keeps a dead row. Frames: `r2-burst-qa-0770ms.jpg`, `r2-burst-qa-3238ms.jpg`. In the same session `ls ~/.claude/projects/…/` has no file for `a715f201`; Claude Code writes a transcript only after the first message.
- Likely cause (not confirmed in code): `resumable` is `!!claudeIdOf(tab)`, which is true from the hook's session id before any transcript exists.
- Consequence: any lane the user started and did not use is lost on its first suspension. For whoever fixes it: either do not suspend a lane whose transcript has no turn, or resume it as a fresh session.

**D3. Any failed resume drops the lane from the rail with no visible message beyond the pane text.** Same behaviour as D2 when the transcript file is missing (I moved Design's `.jsonl` aside, then clicked its row): the pane shows "No conversation found…" and "Session ended", the row vanishes (`r2-13-failed-resume-b.png`). Round 2 notes say a toast ("X exited right after resuming") is raised; I searched the page text once, after D2, and found none.

## Observations

- **O1. The roster shows suspended lanes as live.** On the Team panel after the relaunch, Research and Design carry `LIVE` badges and the header reads `LIVE · 4` while only 2 CLIs run (`r2-19-relaunch-rail.png`). Round 1 notes said the roster reads them as not running.
- **O2. One lane resumed by "RESUME 3 AGENTS" was suspended again 13 s later.** After the first clean relaunch the card resumed a stale Design row (a dead lane left from the failed-resume test, `last` activity 18:47:23Z). Its `idleSuspendedAt` is 18:54:51Z, about 13 s after the resume click at about 18:54:38Z, on the first tick; the limit was 1 min. A second try (QA, whose phase was `running`) did not show it, so this is one observation, not a repro. It may be specific to the resume-project path, which may not set the spawn time that H1's fix reads.
- **O3.** After the first relaunch there were two Design rows (a stale one and the new one); an artefact of my test, noted because the card counted the stale row.
- The Research lane's own first prompt (dev-server brief) was repeated verbatim in the pane after a resume, as Claude Code replays it; not a defect.

## Not tested

Overlay frame, click and typing resume (see above), M1 (closing a project), the session-bus dispatch route, worktree lane resume beyond Design (it resumed in its worktree and kept its branch label), Design/Infra suspend then dispatch with a worktree removed.
