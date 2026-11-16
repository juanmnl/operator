# QA: idle-lane suspension, targeted pass on 7f103f8 (branch operator/80eb00), 2026-10-16

Five checks from the coordinator. **All five pass**, with two observations (below). Nothing was fixed.

Screenshots: `dev/results/suspend-idle-lanes-qa-r5-2026-10-16-shots/`.

## How it was run

- `git archive 7f103f8` extracted into the scratchpad, `node_modules` cloned. Dev build with `OPERATOR_DIR=<scratchpad>/opdir5` (never `~/.operator`), port 1431, CDP 9344. Driven over CDP with real key and mouse events, screenshots, page text, `ps`, and the lanes' state files.
- `localStorage['operator.lane.idleSuspendMinutes']='1'`; `operator.lane.quietMinutes='120'` (so no quiet-close interfered).
- Lanes: Operator, Research, QA (never prompted), Design. Research and Design were each given one prompt ("Reply with the single word ok.") so they have a conversation.
- After shutdown: no `claude` process left for the scratch dir, ports 1431 and 9344 closed.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | A lane started and never prompted stays running past the idle limit | **Pass** | QA started 19:44:40 and never given input. At 19:49:30, 4 min 49 s later with a 1-minute limit and at least 3 suspend ticks, its `claude` process was still running (`ps` etime 04:49) and its rail row read `YOUR TURN`, while Research (suspended 19:46:14) and Design (19:47:14) had been suspended (`g-01-qa-stays.png`). A second no-turn QA started later, and given only a slash command (`/cost`, which writes no transcript: no `.jsonl` for its session id), was also still running after 100 s past the limit. |
| 2 | Lanes resumed by the project-resume card are not suspended inside the idle window | **Pass** | After a quit (quit guard, "Quit and end them") and relaunch, the card read "RESUME 2 AGENTS". Clicked at 19:53:30; `last-run.json` spawn times 19:53:30.148 (Research) and 19:53:30.291 (Design). Suspend ticks fell at 19:54:00.3 (30 s after) and 19:55:00.3 (90 s after). Research stayed up at the first tick and was suspended at the second (`idleSuspendedAt` 19:55:00.322), 90 s after its resume with a 60 s limit. On cd5df8b the same click gave 26 s. Design was the focused lane after the resume, so it only shows the focus exclusion; the Research data point is the evidence. |
| 3 | The Team tab shows a suspended lane as "suspended", with a separate count | **Pass** | Header `LIVE · 2 · SUSPENDED · 2`; the Research and Design cards carry a `SUSPENDED` badge while Operator and QA read `WAITING` (`g-02-team.png`). |
| 4 | "Close project · end N agents" counts suspended lanes; confirming removes their rows and leaves no `claude` | **Pass** | With 2 live and 2 suspended lanes the menu item read `Close project · end 4 agents` (it read `end 1 agent` on cd5df8b). The confirm can be driven with real mouse events: move to the item, wait 250 ms, press and release, and it changes to `… — click again` (`g-03-close-armed.png`); a second real click within the same menu opening fires it. First attempt separately armed and then re-armed because the second click came after the arm had lapsed; once both clicks were sent in one run (400 ms apart) the close ran. Result at 19:50:25: `claude` process count 0 within 3 s and stayed 0 for 25 s; the project view showed "No worktrees and no lanes in any project right now" (`g-04-after-close.png`); the rail was empty; the Design worktree directory was removed; `last-run.json` had `suspended` empty and no lanes; the project's session rows were gone from `sessions.json`. The project card remained in the gallery ("5 lanes") (`g-06.png`). |
| 5 | Re-run D2's repro; a lane with no conversation is never lost from the rail | **Pass** | Repro on this build: QA started, no turn, other lane focused, several ticks past the limit. QA was never suspended, so it never reached the failed resume that removed it on cd5df8b (see 1). Clicking Start QA again later started a fresh session with no error (`g-08-start-qa-again.png`). |

## Observations

- **P1. A lane that never had a conversation is not restored after a quit.** After the quit and relaunch, the resume card offered 2 agents (Research and Design). QA (never prompted) and Operator (no conversation either) were not restored, not on the rail and not on the card; the Team roster listed them as ready to start. Nothing was lost that a resume could have recovered, but the user's open QA lane silently goes away on a restart. A stale dead row for QA stays in `sessions.json`.
- **P2. Real-click confirm needs both clicks in one menu opening.** The menu closes its armed state after a short while; a person clicking twice quickly is fine, a slow second click re-arms. Not a defect; recorded because it is why the earlier synthetic attempts failed.

## Not tested

- Overlay frame and click/typing resume at the overlay (same reason as before: the spawn replaces it at once).
- A click racing the close of the same suspended lane.
- Exclusions and the Tuning control on this commit (passed on earlier commits; no code in them changed per the diff stat, which I did not read in detail).
