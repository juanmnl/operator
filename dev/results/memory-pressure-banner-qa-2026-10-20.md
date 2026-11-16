# QA: memory-pressure banner with lanes running, 2026-10-20

Branch `operator/897500`. First pass on **3a17a2f**; Operator then asked for a re-run on **c8d50f5** (Design's fixes: re-judge each lane right before its kill, 60 s debounce on a drop to normal, button capped at the shown count). Most checks were run on both. Anything not marked 3a17a2f below was run on **c8d50f5**. Nothing was fixed or edited.

Screenshots and scripts: `dev/results/memory-pressure-banner-qa-2026-10-20-shots/` (`3a-*` = 3a17a2f, `c8-*` = c8d50f5, `driver/` = updated `dev/drive-memory-banner.mjs`, `scripts/` = my CDP helpers; their scratch paths are templated as `$SCRATCH`).

## Verdict

**No defect found in the banner on c8d50f5.** Every required check passed in the running app. Four observations and three gaps are listed below. Not GUI-verified: a real kernel level change (all levels came from the fake file), a packaged build.

## How it was run

- `git archive` of each commit into the scratchpad (the `operator-897500` worktree was gone by the second pass; c8d50f5 was taken from the branch), `node_modules` cloned. Dev build via `electron/ npm run dev` with `OPERATOR_DIR=<scratch>/x/opdir` (never `~/.operator`), port 1434, CDP 9344, `OPERATOR_MEMORY_PRESSURE_FILE=<scratch>/x/pressure`.
- The isolated dir comes up seeded with the mock bridge's demo projects and sessions (`/Users/dev/...`). I replaced `projects.json` with one test project (a scratch git repo) with roster Research, QA, Review, Code, and emptied `sessions.json`. The mock re-seeds `sessions.json` on boot (8 fake rows, none for my project); they did not affect any count I read.
- Lanes started from the rail's "Start an agent" menu (no brief), driven over CDP with real key and mouse events. Research, QA and Review are Sonnet/Sonnet/Opus lanes given one turn each ("Reply with the single word OK. Use no tools."). The mid-turn lane is Review given a long foreground `python3 -c "time.sleep(580)"` (a standalone `sleep` is blocked by the harness, which made Review idle the first time, see N1). Code is the Opus worktree lane. Claude Code's folder trust was accepted once for the scratch folder, so `~/.claude.json` now has an entry for it.
- "Which lane was suspended" was read from `ps` (one `claude --settings .../sessions/<id>/settings.json` per live lane), the rail labels and the transcripts, not from the banner alone.
- At the end the dev app, all test `claude` processes and the sleeps were gone, port 1434 was free, and the fake file was left at level 1.

## Required checks

| # | Check | Result | How | Evidence |
|---|---|---|---|---|
| 1 | Level 2: "Suspend N idle lanes" shows the right N | **Pass** (both commits) | App driven. N matched the lanes I could eliminate by hand: Research + QA idle, Review mid-turn (excluded), Code focused or with no conversation (excluded) → 2. On 3a17a2f the first reading was 3 because Review's sleep had been blocked and it was idle, which was correct | `c8-01-warn-dark-mc.png`, `3a-01-…`, `3a-02-…` |
| 2 | Button suspends exactly those lanes, never the working lane | **Pass** (both) | `ps` after the press: Research and QA gone, Review (mid-turn) and Code still there. Review then finished its turn (`DONE`, "Sautéed for 9m 45s"), so it was not interrupted by any of the later passes either | `c8-03-after-suspend-dark-mc.png` |
| 3 | "Suspending…" then the count updates | **Pass** (both) | Sampled every 60 ms: `Suspending…` for ~0.8 s, running count steps 4→3→2 as each kill lands, then "Suspended 2 idle lanes. No other lane can be suspended right now." The button disappears when nothing is eligible | `c8-02-suspending-dark-mc.png` |
| 4 | Level 4: eligible lanes suspended automatically | **Pass** (both) | Level written at 11:21:2x; banner at 4 within 3 s and both idle lanes suspended by the first pass, mid-turn lane untouched | `c8-04-critical-auto-dark-mc.png`, `3a-05-…` |
| 5 | …and again 30 s later | **Pass** (both) | Research resumed by focus while the level stayed at 4, unfocused at 11:22:24; no click; it was suspended by the next pass within 4 s (c8d50f5) and at ~11:13:54 (3a17a2f). A lane resumed and still focused when a pass ran was skipped and caught by the following one | transcript of `ps` polls in the run, summarised here |
| 6 | Level 4 with idle suspension Off: nothing automatic | **Pass** (both) | Tuning page → Off (wrote `operator.lane.idleSuspendMinutes=0`). Two idle lanes left running through 75 s (2+ passes). Banner reads "Idle suspension is off in Tuning." with the button kept. The button still works under Off and suspended both | `c8-05-critical-off-dark-mc.png`, `3a-06-…` |
| 7 | Banner dismissed at 2 shows again on a rise to 4 | **Pass** (c8d50f5) | Dismissed at 2 (main stayed at 2), file → 4, banner back at 4 within 4 s. The updated driver also covers dismiss at 4 and "stays dismissed 4→2" | `c8-06-dismissed2-shown4.png` |
| 8 | 1984 and mr-pink palettes | **Pass** (c8d50f5) | App driven, dark and light, level 2 with the button and level 4 with the Off message plus button. The strip's wash, dot, button and ✕ read correctly in all four; text colour contrast is fine. Computed styles come from the theme tokens (different per palette) | `c8-th-{1984,mr-pink}-{dark,light}-{warn,critical}.png` (also `mission-control-light-warn`) |
| 9 | Narrow window, 720 px | **Pass** (c8d50f5) | `window.resizeTo(720, h)` (720 is the window's `minWidth`), `innerWidth` = 720, so the content card is 432 px wide. Level 2: whole text fits. Level 4 + Off: the sentence is cut with an ellipsis (`scrollWidth > clientWidth`) and the button (553–678) and ✕ (686–704) stay inside the strip (ends at 712). Same in mission-control, 1984, mr-pink | `c8-narrow-720-*-L{2,4}.png` |
| 10 | Review L1: flap 1→2→1→2 | **Not a problem on c8d50f5** (see below) | App driven | below |
| 11 | Updated `dev/drive-memory-banner.mjs` on c8d50f5 | **Pass, 19 of 19** | Ran with 3 lanes live; dark and light | `driver/results.txt`, `driver/*.png` |
| 12 | Button capped at the shown count (Design's c8d50f5 change) | **Pass** | Banner showed "Suspend 2", Review was focused when the count was read; I focused Code so that Research, QA and Review were all eligible (3) and pressed immediately: exactly 2 were suspended (Research, Review), QA stayed up, and the label became "Suspend 1 idle lane". A first attempt had Code as the third lane, but Code had no conversation, so it proved nothing (see G2) | `cap2-suspending.png`, `cap2-after.png` |

### Check 10: flap (Review L1) on c8d50f5

All with the app in a window of 1100 px; "term heights" are `.xterm` boxes (a visible one is 605 px without the banner and 574 with it); "RO" is a ResizeObserver callback count on them.

| Test | Result |
|---|---|
| Fast flap, banner shown and not dismissed: file 1→2→1→2→1→2, 7 s per step | Banner stayed at level 2 the whole time. Heights 574 throughout, RO count unchanged (no refit). |
| Fast flap with the banner dismissed at 2: same steps | Banner did not come back. Heights 605 throughout, RO unchanged. |
| Slow flap, dismissed at 4: file 4→2, then twice (1 held 70 s, then 2 held 12 s) | Drop to 1 is reported after 60 s (measured: banner gone 60.8 s after the write). A rise to 2 within 5 min of the drop does not bring the dismissed banner back (round 1 and round 2). Heights unchanged. |
| Debounce timing on a clean drop | Banner gone 60.8 s after writing level 1. |

Why the fast flap is invisible: main polls every 5 s at level 2 and only reports a drop to 1 once it has held for 60 s, so a flap shorter than that never reaches the renderer. I did **not** run the same flap on 3a17a2f, so I did not reproduce L1 before the fix. On 3a17a2f I only saw a drop to 1 take 34 s to hide the banner (poll plus the renderer), which is unexplained but moot after the debounce. Not tested: a rise more than 5 min after a drop (should show again; left to the unit tests), and a real kernel flap.

## Observations (not defects; for Design to decide)

- **O1. The count can lag the lanes by up to 30 s.** The eligible count is read when the banner shows and every 30 s, not when focus changes or a lane goes idle. Seen: "Suspend 1 idle lane" for ~15 s after two lanes were idle, then "Suspend 2" (3a17a2f); on c8d50f5 the stale count and the pass disagree safely because the pass re-judges each lane and is capped at the shown count (check 12). The label can therefore under-promise, never over-promise.
- **O2. The "Suspended N" sentence is cumulative per episode** (by design in `reducePressure`: since the level last rose from normal). After a button press and an auto pass the banner said "Suspended 4 idle lanes" when the second pass suspended 2, and a lane suspended, resumed and suspended again counts twice. It reads as this-pass to someone who has not seen the earlier pass.
- **O3. A stale sentence stays next to fresh state.** After resuming two lanes the banner read "…Suspended 2 idle lanes. [Suspend 1 idle lane]". Also, because the Off message is only shown when nothing has been suspended yet, turning idle suspension Off mid-episode does not show "Idle suspension is off in Tuning." until the episode resets (it showed correctly when Off was set before the level rose).
- **O4. Pre-existing, not the banner:** at 720 px the lane header clips the project name to "op" and the footer clips "Session…" ("Ses"). Visible in `c8-narrow-720-mission-control-dark-L4.png`.

## Notes on the test lanes

- N1. Review's first working turn was blocked by the harness ("Blocked: standalone sleep 540"), so it was idle, and the banner's "3" on 3a17a2f was right. A mid-turn lane needs a non-`sleep` command (`python3 -c time.sleep`).
- N2. On c8d50f5 the Code lane never received its prompt (no transcript for its worktree session), so it was ineligible as "no conversation yet" in every pass; that is an expected exclusion, and the 3a17a2f run did have Code with a background shell (also excluded, and shown as such: "3 idle" vs 4 running).

## Gaps (not covered)

- G1. A real kernel pressure level and the `sysctl` path (all levels were the fake file).
- G2. Cap check with a mix of eligible and ineligible lanes: only the three-eligible case above. Not exercised: the pass re-judging a lane that became ineligible between the count and its kill (Design's fix 1); that needs a lane to start a turn inside the ~0.3 s window.
- G3. Packaged build; the scratch-terminal sheet clearing the banner; the banner in Board/overview mode (I only looked at lane view and the project view); rise to 2 more than 5 min after a dismissed drop.

## Recommendations

- Design: decide O2 and O3 (reset the counter per pass or say "since memory rose"; show the Off message regardless of the counter). O1 needs no change.
- Operator: the banner can go to merge from QA's side; G1 and G3 want a person with the packaged app under real memory pressure.
- No new automated tests needed from QA: the unit suites in the branch already cover the reducer, copy and debounce; the in-app results above agree with them.
