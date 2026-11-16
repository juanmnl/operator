# Renderer leak, live-lanes follow-up (2026-10-26)

Measurement only; no app code changed. Build under test: `4f330e0` (main, with the delivery-hold, lifecycle and link merges, without the leak fix). Follow-up to `renderer-leak-measurement-2026-10-25.md`.

## Answer

1. **The DashboardView callback chain retains real session data, and the cost per link is about 2.6 times higher with live Claude lanes than with the shim-only run.** Dominated bytes held by the chain contexts: 0.746 MB at +10 min, 0.841 MB at +1 h, 1.096 MB at +2 h. That is +0.35 MB over 23 new links, about 15 KB per link (the 12 h run without real events: about 6 KB per link). The extra bytes are `AgentSession.messages` arrays: each new session version carries freshly deserialized message items, and the chain keeps the old versions.
2. **Measured growth with 8 lanes (2 real): 0.19 MB/h over the run, 0.25 MB/h in the second hour.** The JS heap after GC did not move beyond noise (+0.28 ± 0.64 MB/h from 30 min on), because 0.25 MB/h is below what 12 samples can resolve.
3. **Whether this chain explains the field's 30-35 MB/h is not shown.** Scaling the measured 0.25 MB/h by lane count (17 instead of 2 real lanes) and by a full message window (80 instead of 26 messages) gives about 6 MB/h at the same turn rate as this run. Reaching 30-35 MB/h needs roughly 5 times more session-change events per lane than this run produced (12 prompts/h per lane, one reply each, no tool calls). Busy lanes with hook events and tool calls could produce that, but I did not measure the field's event rate, so the estimate has one unmeasured input. See "Estimate for 17 lanes".

## Setup (same as the 10-25 run, changes listed)

- Build: detached worktree at `4f330e0`, `npm run build` plus `vite build --sourcemap` (bundle `out/renderer/assets/main-YrjdSQ66.js`). Production renderer, unpackaged `Electron .`, CDP 9343, fresh `OPERATOR_DIR` (only the 5.3 MB synthetic `projects.json` copied in) and fresh Chromium profile. Nothing under `~/.operator` or the default profile was touched.
- Lanes: 6 shim lanes in `proj-fake` (5 running `date; ls -la /usr/bin | head -40` every 3 s, 1 printing 700-char ANSI lines and a 6,000-char line every 20th), and 2 real Claude Code lanes in `proj-scratch` (Research and QA roles, Sonnet 5.5, Claude Code 2.1.310, auto mode). Total 8 lanes, not 17.
- `operator.lane.idleSuspendMinutes` set to `0` (Off) in localStorage, the key the Tuning page writes. Both real lanes stayed alive for the full 2 h (sampler `lanes: 8` in every row).
- Prompts to the two real lanes every 5 min through `terminalWrite` (`prompter.mjs`, `prompter2.mjs`):
  - +0 to +60 min: "Reply with the single word: ok" (13 rounds, 26 prompts).
  - +62 min onward: "Write a 120-word explanation of what a git worktree is and when to use one. Plain prose, no lists, no tools." (13 rounds, 26 prompts by the 2 h snapshot). I changed the prompt after the first hour to get a second data point on cost versus message length. The coordinator's brief asked for the tiny prompt; this deviates from it and costs about 160 output tokens per reply (about 4,000 tokens in total).
- Active lane switched every 10 min through the sidebar (`switcher.mjs`).
- Sampling every 10 min (`Runtime.getHeapUsage`, post-GC reading, RSS of every Electron process). Snapshots (after forced GC) at +10 min, +60 min, +120 min: `live-10m`, `live-1h`, `live-2h`.
- t0 = 13:24:16Z. App launched about 6 min earlier; lane launches finished before t0.

## Measurements

### Chain size

Method: the chain contexts are the DashboardView render Contexts that hold all four slots `setPanelOpen`, `focusTerminal`, `allSidebarSessions` and `projectsSerRef` (minified `mn`, `Lc`, `He`, `su` in this build; names found with `srcnames.mjs` through the source map). "Dominated bytes" is the sum of `retained size` of every link context that is not itself dominated by another link context (`chaintotal.mjs`).

| Snapshot | Links | Top-level groups | Dominated MB | Real-lane message arrays dominated by a link | AgentSession objects |
|---|---|---|---|---|---|
| +10 min | 54 | 19 | 0.746 | not run | 354 |
| +60 min | 63 | 20 | 0.841 | 12 of 20 (35.9 KB) | 466 |
| +120 min | 77 | 21 | 1.096 | 27 of 32 (199.3 KB) | 626 |

- Links per hour: 9 in 50 min (+10 to +60 min, about 11/h), 14 in 60 min (+60 to +120 min). The 12 h run without real events: about 6/h.
- Growth per hour: +0.114 MB/h in the one-word phase (10.5 KB per link), +0.255 MB/h in the 120-word phase (18 KB per link). Whole run: +0.35 MB in 110 min.
- The chain is not one nested list. It is 19 to 21 separate groups; one group of 520-534 KB is the base (present from +10 min, almost constant) and the growth is in the other groups. My earlier "marginal retained per link" statistic (mean, median, max in `linkstats.mjs`) assumed one nest and is unreliable here (median 452 B, mean 7-10 KB, max 350-427 KB). I use the sum over top-level groups instead. I re-ran that sum on the 10-25 snapshots to check the earlier report: 0.078 / 0.259 / 0.488 MB at 1 / 6 / 12 h for 17 / 47 / 85 links, which gives 0.41 MB over 68 links, 6 KB per link. The earlier 5.8 KB figure holds.
- The sums are lower bounds: an object also referenced from outside the chain is not dominated by it and is not counted.

### Session versions

`sessdetail.mjs`, `sessshare.mjs`, `itemsize.mjs` on the real-lane `AgentSession` objects:

| | +60 min | +120 min |
|---|---|---|
| Real-lane session objects (2 sessions) | 58 | 98 |
| Mean `messages` length per object | 12.1 | 25.8 |
| Mean `activity` length per object | 0.8 | 0.9 |
| Distinct `messages` arrays | 20 | 32 |
| Distinct message items | 251 | 807 |
| Retained bytes of those items | 53.7 KB | 232.1 KB |
| Mean retained bytes per item | 214 | 288 |
| Median / p90 / max per item | 140 / 580 / 1,012 | 140 / 924 / 1,012 |

- Items are not shared between versions: 32 arrays × about 25 items = 807 distinct items. An unchanged session keeps its array; a changed session gets a whole new array of new item objects. So one retained version costs about (number of messages) × (about 100 B + text length).
- An item with a one-word reply or short prompt is 112-140 B retained. An item with a 120-word reply is about 1,000 B (`text` string 916 B self size).
- The 408 / 528 shim-lane `AgentSession` objects (60 min / 120 min) have `messages` and `activity` of length 0 and cost 143 B each; they are the same fresh-per-render objects as in the 10-25 run.
- `activity` stayed near 1 per session because the prompts used no tools. The activity side of the cap (80 entries) is not exercised.
- 8 of 20 and 5 of 32 message arrays are not dominated by the chain; the 5 at +120 min are held through other paths (a GC-roots entry and an array holder); I did not identify them.

### Sampler series (12 samples, 0 to 110 min)

| Quantity | Value |
|---|---|
| Post-GC JS heap | 23.7 MB at 0, 28.8 at 20 min, 29.4 at 110 min |
| Slope, from 0 min | +1.44 ± 0.71 MB/h (includes the initial scrollback fill) |
| Slope, from 30 min | +0.28 ± 0.64 MB/h |
| Renderer RSS | 239 MB at 0, 191 at 30 min, 197 at 110 min; slope from 30 min -2.0 ± 5.7 MB/h |
| Renderer footprint (`footprint`) | 143 MB at 0, 199-200 at 20-30 min, 209-211 MB at 90-110 min |
| DOM nodes | 1,213 to 1,500, no trend |

The expected chain growth (0.2 to 0.25 MB/h) is smaller than the slope error (0.64 MB/h) and the sawtooth in RSS. The heap series cannot confirm or refute it; the snapshots can.

## Estimate for 17 lanes

Formula (measured parts marked): `MB/h = links per hour × session versions captured per link × messages per version × bytes per message`, plus the same for `activity` entries.

| Factor | This run (measured) | Field (assumption) |
|---|---|---|
| Links per hour | 11 to 14, with 12 prompt rounds/h and one reply each | unknown; scales with `sessions`/`terminals` change events across 17 lanes |
| Session versions per link | about 2 (15 KB per link ÷ about 7.5 KB per version at 26 messages) | 1 to 17 |
| Messages per version | 12 to 26 (avg), cap 80 | up to 80 |
| Bytes per message | 140 B median, 288 B mean (short prompts, one-word replies, some 1 KB replies) | 300 B to 1.5 KB; prompts up to 4,000 chars and tool results up to 2,000 chars are allowed by the caps |
| `activity` entries per version | about 1 | up to 80 |

Scaling the measured 0.25 MB/h:

- 17 real lanes instead of 2, same turn rate per lane: ×8.5 → about 2.1 MB/h.
- Full window of 80 messages instead of 26 on average: ×3 → about 6.4 MB/h.
- Reaching 33 MB/h from there needs ×5: either 5× more session-change events per lane than 12 per hour, or 5× larger items (about 1.4 KB mean), or activity entries adding a comparable amount.

These are linear scalings of a small sample; I did not run 17 lanes. The two inputs that decide the answer are the field's links per hour and its bytes per message. Neither is measured in the field.

Plausibility: a lane doing real work emits many session updates per turn (tool calls, hook events, assistant messages), and a message at the cap holds up to several KB of text. The ×5 gap is within the range of a busy 17-lane setup, so the chain is a plausible main contributor. It is not demonstrated, and other growers (scrollback, per-terminal buffers, the stringified saved-sessions list) are not excluded; the 10-25 report found them flat within 12 h.

How to close the gap with data, not scaling:
1. Take a heap snapshot of a long-running field renderer and run `chaintotal.mjs` on it (slot names from `srcnames.mjs` for that build). If the chain holds hundreds of MB there, the question is answered directly. The packaged app has no CDP port; a dev build or `--remote-debugging-port` on the user's own running app would be needed, which is the user's decision.
2. Re-run this measurement on Code's fix branch with the same scripts. Expectation if the fix works: the link count and the dominated total stay flat (about 0.75 MB, 19 groups) while the sessions state keeps changing.

## Pass/fail rundown

| Item | Result | How exercised |
|---|---|---|
| Keep 2 real lanes alive for 2 h (`idleSuspendMinutes` = 0) | PASS: 8 lanes in every sampler row | App driven; sampler data |
| Prompt each real lane every 5 min; events reach the renderer | PASS: 52 prompts, replies "ok" and 120-word prose, renderer `AgentSession.messages` grew 12 → 26 | App driven via CDP `terminalWrite`; heap snapshots |
| Snapshots at +10 min, +1 h, +2 h | PASS | Heap snapshots 37 / 40 / 40 MB |
| Count retained DashboardView contexts | PASS: 54 / 63 / 77 | Heap analysis (`linkstats.mjs`) |
| Count AgentSession objects | PASS: 354 / 466 / 626 | Heap analysis |
| Per-link retained size with real session data | PASS, with correction: 15 KB per link (10.5 KB with one-word replies, 18 KB with 120-word replies), by summing dominated bytes of top-level groups; the earlier marginal-difference method fails when the chain is not a single nest | Heap analysis; cross-check on the 10-25 snapshots |
| Estimate MB/h for 17 lanes | PARTIAL: 6 MB/h by linear scaling at this run's event rate; 30-35 MB/h needs 5× more events or larger items; not measured | Calculation from measured inputs |
| Chain explains the field's 30-35 MB/h | NOT SHOWN: plausible, depends on the field's event rate and message size | Reasoning plus the measurements above |
| JS heap slope visible in sampler | NOT RESOLVED: +0.28 ± 0.64 MB/h from 30 min, below noise | Sampler series, 12 points |
| The cause is in the callback chain (inferred in the 10-25 report) | CONSISTENT, not proven by a controlled test: contexts and retained session copies grow together, held through the same four-slot contexts | Heap analysis; no run with the fix |
| Activity-entry cost | NOT TESTED: prompts used no tools; `activity` ≈ 1 per session | — |
| Fix verification | NOT DONE: Code's branch does not exist yet for me | — |

## Caveats

- 8 lanes (2 real), not 17; shim lanes have no hook events and no transcript, so their `AgentSession` objects are empty.
- The real QA lane began its own turn at launch (it said it was waiting for app code), so it produced some unprompted events besides my prompts. I did not check whether the Research lane did the same.
- The prompt changed at +62 min (one word → 120 words). The two phases differ in item size and in message count, so the 10.5 vs 18 KB per link is not a clean comparison of item size alone; message arrays also grew from about 12 to 26 over the same period.
- Replies are plain prose, no tool calls, no hooks other than prompt-submit and stop events. Real busy lanes differ in event rate and in item size.
- The synthetic 5.3 MB store is filler text; `projectsSerRef` holds one constant string (9.9 MB in the earlier run), not growth.
- Link counting uses minified slot names specific to build `YrjdSQ66`. The method needs the names re-derived per build (`srcnames.mjs`).
- One snapshot per time point; no repeat, so no confidence interval on the per-link figures. Dominated bytes are lower bounds.
- Only `4f330e0`, not the fix.
- Run length 2 h (120 min after t0), as asked. 10-minute sampling left 12 points.
- The switcher clicked every visible lane in turn, so the active lane changed every 10 min.
- Token cost: 52 prompts, about 160 output tokens per 120-word reply, so well under 10,000 output tokens plus cached context re-reads for two lanes.

## Corrections to my earlier files

- `renderer-leak-measurement-2026-10-25-tools/bigstr.mjs` and `sessobj.mjs` indexed `s.retained[s.post[n]]` (wrong; `s.retained` is indexed by node index). Fixed in place. The 10-25 report did not use the numbers those two scripts printed (the 272 KB "dominated-retained" figure); its per-link 5.8 KB came from `analyze.mjs` and is confirmed above by the new method.

## Recommendations (the coordinator decides; I do not dispatch)

1. **Code:** the fix direction stands. Read `sessions`, `terminals` and `sessionLayouts` through refs inside `setPanelOpen`, `togglePanel`, `focusTerminal` and `openLaneTerminal` so their deps stop changing. Also consider freezing the `startedAt: new Date().toISOString()` default in the sidebar sessions builder so unchanged lanes keep one object across renders.
2. **QA (me), after Code's branch exists:** re-run this exact 2 h workload with the same scripts. Pass criterion: the link count and the dominated MB at +2 h stay close to the +10 min values (54 links, 0.75 MB here) instead of growing by about 23 links and 0.35 MB.
3. **Coordinator/user:** a snapshot of a long-running real renderer (see "How to close the gap") would turn the estimate into a measurement. It is the only way to resolve the 5× gap; user's decision, because it needs a CDP port on their own app.
4. **Review:** check that the fix does not leave a second chain through `openLaneTerminal`, which has the same deps shape as `focusTerminal` (DashboardView.tsx near :3602 at 4f330e0).

## Files

- Tools and data: `dev/results/renderer-leak-live-lanes-2026-10-26-tools/` (`linkstats.mjs`, `chaintotal.mjs`, `sessdom.mjs`, `sessdetail.mjs`, `sessshare.mjs`, `itemsize.mjs`, `srcnames.mjs`, `prompter.mjs`, `prompter2.mjs`, `sampler-live.mjs`, `switcher.mjs`, `launch2.sh`, `table-live.py`, `live-samples.jsonl`, run logs, plus `heap.mjs`, `sourcemap.mjs`, `cdp.mjs`). Slot names in the examples above are for this build.
- Heap snapshots (37-40 MB each) stay in the scratchpad: `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/snapshots/live-{10m,1h,2h}.heapsnapshot`.
- Leftovers outside the repo: `~/.claude.json` trust entry for the scratch project path (already existed from the 10-25 run), registered detached worktree `scratchpad/wt` now at `4f330e0` (`git worktree remove --force` removes it).
