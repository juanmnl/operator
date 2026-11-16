# Operator memory footprint after the 2026-10-16 jetsam event

Research only. No code changed. Sources: `JetsamEvent-2026-10-16-120029.ips` (read with `python3 -I`, pageSize 16384), `footprint` and `ps` on the relaunched app (app pid 1256, 17 lanes, sampled at 2.7 to 4.8 minutes of uptime), and the code paths cited below.

## Summary

1. The per-lane "Operator" (28 MB) plus two "Operator Helper" (11 MB, 6.5 MB) are one `Operator --mcp-serve` process per lane and the two Chromium helpers (GPU, network) that Electron starts for it. The lane's MCP config launches the full Electron binary without `ELECTRON_RUN_AS_NODE`. Running it as plain node footprints 15 MB instead of about 46 MB (measured).
2. pid 8752 is the main window's GPU process. Live, its footprint is about 365 MB, of which 229 MB is IOSurface (compositor surfaces). The 2.8 GB lifetime peak is graphics memory, not heap. I could not identify what drove it.
3. Renderer: 942 MB at 10.7 hours, 287 MB at 4.8 minutes with the same 17 lanes. The terminal buffers explain roughly 100 to 150 MB (estimate). The remaining growth is unexplained.
4. Operator has no memory-pressure handling. Nothing reads system memory, and nothing bounds the lane count. The largest cost is the Claude CLI processes (about 258 MB each, 4.9 GB for 19). Suspending idle lanes is the only large saving inside Operator.
5. Operator was 7.4 GB of about 24 GB physical. Chrome (about 25 GB resident, shared pages counted more than once) and Umbra were the bulk. Trimming Operator alone would not have prevented this event. It would have reduced Operator's share from about 12% to about 8%.

## What the jetsam report shows

- Event 12:00:29 local. `largestProcess` is Umbra. `memoryStatus`: free 215 MB, wired 6.2 GB, compressor 9.8 GB, so the machine was fully compressed.
- Summing `rpages` over all 1793 processes gives 60.7 GB. That counts shared pages once per process and is larger than physical RAM; use it for ranking, not as an absolute.
- Operator rows (all share coalition 127360 with the other 295 processes in that coalition, including Chrome, so the coalition id does not isolate Operator; I summed by process name):

| Process | Count | rpages total | Notes |
|---|---|---|---|
| `2.1.301` (Claude CLI) | 22 total, 18 above 150 MB | 4,904 MB | the 18 lane CLIs: 219 to 333 MB each |
| Operator Helper (Renderer) | 1 | 942 MB | lifetimeMax 1,406 MB |
| Operator | 19 | 769 MB | main app 247 MB + 18 mcp-serve at 28 to 30 MB |
| Operator Helper | 39 | 756 MB | main GPU 398 MB (lifetimeMax 2,849 MB), main network 9 MB, 18 x (GPU 11 MB + network 7 MB) |

- Process age is in 24 MHz ticks (assumption, consistent with the 10.7 hour uptime and the SWBBuildService ages). The app had run 10.7 hours (started about 01:17). Lane ages: 7 lanes at 9.6 to 10.7 hours, the rest 0.7 to 3 hours.
- CPU over the app's life: main 1,699 s (4.4% average), GPU 4,757 s (12%), renderer 7,014 s (18%). The two helpers worked continuously.

## Q1. Per-lane "Operator" and "Operator Helper" processes

Verified.

- `electron/src/main/terminals.ts:303` adds `--mcp-config` with `mcpConfigArg(process.execPath, ...)`. `src/renderer/lib/launch-args.ts:22-25` builds `{"mcpServers":{"operator":{"command":<Operator binary>,"args":["--mcp-serve"]}}}`.
- Claude Code starts that command as its own child, per lane. `electron/src/main/index.ts:487-490` sees `--mcp-serve`, hides the dock icon and calls `serveMcp()` (`mcp-serve.ts:431`), a readline JSON-RPC loop.
- Because the binary is the full Electron app, Chromium still starts its GPU and network helpers for it. Live process tree for one lane: `claude` (1813) > `Operator --mcp-serve` (2500, RSS 105 MB) > `Operator Helper --type=gpu-process` (2517, RSS 49 MB) and `--utility-sub-type=network.mojom.NetworkService` (2518, RSS 36 MB). `ps` shows 18 `Operator --mcp-serve` processes, one per live lane (17 restored lanes plus this one).
- Footprint (the number that counts toward memory pressure): 28 MB + 11 MB + 6.5 MB = about 46 MB per lane. The jetsam rpages figures (29 + 11 + 7) agree. `ps` RSS (190 MB per lane) includes shared framework pages and overstates it.
- Measured alternative: `ELECTRON_RUN_AS_NODE=1 /Applications/Operator.app/Contents/MacOS/Operator -e ...` footprints 15 MB (RSS 66 MB), with no helpers.

The server needs only stdin/stdout JSON-RPC, `better-sqlite3` through `ArtifactStore` (`mcp-serve.ts:16`), and `evaluateWorktreeDone`. It does not need Electron's `app`.

## Q2. The 2.8 GB-peak helper (pid 8752)

Identified by elimination, not by a label in the report.

- It is a child of the main app (pid 8750), started at the same age as the app (10.707 hours), fds 50, lifetimeMax 2,849 MB. The other lane GPU helpers have the same fd count and `rpages` 11 / lifetimeMax 51. The adjacent pid 8753 (9 MB, fds 64) is the network service, and the audio service starts lazily. So 8752 is the GPU process.
- Live GPU process (pid 1267) `footprint`: 364 to 365 MB total. IOSurface 229 MB (104 regions), "Owned physical footprint (graphics)" 60 MB, IOAccelerator 39 MB, App-Specific Tag 14 20 MB. Almost no malloc heap. It grew from 309 MB at 2.7 minutes to 365 MB at 4 minutes and then held.
- The jetsam record for 8752 shows `physicalPages.internal` of 1,388 pages (22 MB) with a peak of 3,598 (56 MB). So the 398 MB resident and the 2.8 GB peak were not ordinary heap. I read `internal` as dirty anonymous pages; I did not verify the field's meaning.
- Not the WebGL addon: `TerminalPane.tsx:103-106` states the DOM renderer is used and `TerminalSurface` does not pass `webgl` (the `WebglAddon` path at `TerminalPane.tsx:201-207` is dead). I did not confirm the pass-through in `TerminalSurface.tsx`.
- Candidate drivers, none verified: `backgroundThrottling: false` (`index.ts:180`) keeps all 17 mounted xterm panes compositing; the Preview iframe (`AppPreviewPanel.tsx`); preview screenshot capture (`preview-screenshot-capture.ts`, `bench.ts` capture is env-gated and off). Few infinite CSS animations exist (3 matches, `styles.css:493` cursor blink, `LogoMark.tsx:51`), so animation alone is unlikely.
- To find the driver: sample `footprint <gpu-pid>` every 10 minutes for a day with a fixed lane set, and log `app.getAppMetrics()` (type `GPU`) beside which view was active. `bench.ts:59-72` already does this behind `OPERATOR_ELECTRON_CAPTURE`; it is off in the shipped app.

## Q3. Renderer at 942 MB

Partly explained.

- Terminals. Every lane's xterm stays mounted (`terminal-options.ts:150-155`, `DashboardView.tsx:6050`). Caps exist: active pane 10,000 lines (`ACTIVE_SCROLLBACK`, `terminal-options.ts:146`), inactive 2,000 (`INACTIVE_SCROLLBACK`, `:180`, applied through `scrollbackFor`, `:184`). The hidden-output buffer holds 512 KB per hidden pane and flushes at the cap (`TerminalPane.tsx:25`, `hidden-output.ts`). The cap is enforced for panes that are not visible, since it keys on active, not on visibility.
- Estimate (not measured): xterm stores about 12 bytes per cell. At 200 columns that is 2.4 KB per line, so 10,000 lines is about 24 MB and 2,000 lines about 5 MB. One active plus 16 inactive is about 100 MB, plus about 9 MB of hidden-output buffers. DOM rows exist only for the viewport.
- Main-process retention is separate: 256 KB per pty (`terminals.ts:38`, trimmed at `:847`), about 4 MB for 17 lanes.
- Growth. Fresh renderer: 282 to 287 MB footprint with 17 lanes at 4.8 minutes. At 10.7 hours: 942 MB resident, peak 1,406 MB. Roughly 650 MB or more of growth is not accounted for by the capped terminal buffers. I did not find the source; I did not profile the heap. Candidates are React state in the 6,000-line `DashboardView.tsx`, DOM retained by the 17 stacked panes, and image caches. These are guesses.
- Related: the renderer SIGTRAP-crashed on 2026-10-13 11:41 after 4.4 days (`Operator Helper (Renderer)-2026-10-13-114123.ips`, launched 10-09 01:59), and on 2026-10-06 after 7.8 days. Two renderer deaths in ten days at roughly 4 to 8 days of uptime fit slow growth, but the report has no heap figures, so this is an inference.
- To find the source: take a heap snapshot at 1 hour and 8 hours through the existing CDP port (`preview-cdp-port.ts`) on a dev build, or log `performance.memory` and per-terminal `buffer.active.length` hourly.

## Q4. Lanes, idle cost, bounding

- 18 lane CLIs at 12:00 (the report lists 22 `2.1.301` processes; four are small non-lane processes, for example 53715, 51702, 52968). `last-run.json` at the 12:26 relaunch lists 17 lanes across 6 projects (web27 5, escriba 4, mantel 2, fastrack 2, umbra 2, operator 2).
- I cannot say how many were idle at 12:00. Process CPU as a share of wall time is 0.65% to 4.8% for every lane CLI, so none was busy on average; the report has no working/waiting state. Working vs waiting state lives in `Transcript.liveLanes` (`index.ts:481`), which a memory watcher could use.
- Operator does nothing to bound lane count or lane memory. No idle timeout, no suspend. A lane ends only when closed, when its agent exits, or when it calls `worktree_done` (`last-run.ts:10-12`; the retire-released-lane path from 2026-09-27). Lanes are never ended for memory.
- Resume exists: `--resume <claudeSessionId>` in `launch-args.ts:31`, used at `DashboardView.tsx:3074` and `:3453`, and by crash auto-resume (`last-run.ts`).
- Side effect seen today: after the reboot, crash auto-resume relaunched all 17 lanes within about 2 seconds of each other (`last-run.json` `startedAt` 17:26:06.0 to .x). Whatever filled memory could fill it again straight away. Resume has no concurrency limit.
- Cost of idle-lane suspension (end the CLI, keep the tab, `--resume` on the next dispatch or click):
  - Saves per lane: about 258 MB (CLI average) plus about 46 MB (mcp-serve set) = about 300 MB.
  - Costs: a cold start per resume (seconds); the prompt cache is cold after more than an hour, so the first turn re-reads the full context at full price (not measured); the lane's bus presence disappears while suspended, so `dispatch` to it needs a launch-then-send path (the retire-released-lane dispatch already launches fresh, `dev/results/retire-released-lane-review-2026-09-27.md`); background tasks and subagents running in that CLI die; the on-screen scrollback is replaced by Claude's repaint of the resumed session. A lane waiting on a permission prompt or a question must never be suspended.
  - Gate by transcript state: only lanes the transcript reads as waiting for longer than N minutes, not in a dispatch chain, not holding a dev server port, not asking.

## Q5. Memory-pressure handling

None. Verified by search of `electron/src/main`:

- `getAppMetrics` appears only in `bench.ts:59-72`, behind `OPERATOR_ELECTRON_CAPTURE` (off by default; `bench.ts:29` returns early).
- No use of `process.getSystemMemoryInfo`, `powerMonitor`, `memory_pressure`, or `sysctl`. `renderer-recovery.ts` reloads a crashed renderer (`logRendererGone`) but only after it died.
- Available on this machine: `sysctl kern.memorystatus_vm_pressure_level` returns 1 (normal; 2 warn, 4 critical) and `kern.memorystatus_level` returns 85 (percent free). Both are readable with `execFile` and cost almost nothing. `process.getSystemMemoryInfo` is an Electron main-process API; `node` here reports it undefined, so I did not call it. The Electron docs list it; unverified here.
- Pressure level 2 usually arrives well before jetsam kills (not verified for this event; the report has no timeline before 12:00:29).

## Ranked fixes

Savings are footprint estimates, for 18 to 19 lanes.

| # | Fix | Saves | Effort and risk |
|---|---|---|---|
| 1 | Idle-lane suspension, gated on transcript state (waiting more than N minutes, nothing pending). Resume on dispatch or tab click | about 300 MB per suspended lane; 6 idle lanes about 1.8 GB | Largest. Needs dispatch-to-suspended path, bus-name handling, cold-cache cost. Settings opt-in first |
| 2 | Memory-pressure watcher in main: poll `kern.memorystatus_vm_pressure_level` every 15 to 30 s, show a banner at level 2, offer "suspend idle lanes", and at level 4 suspend automatically | 0 by itself; this is what keeps the next event from reaching jetsam | Small. Depends on #1 for the action; the warning alone is useful |
| 3 | Run `--mcp-serve` as node: a dedicated entry that does not import `electron`, launched with `ELECTRON_RUN_AS_NODE=1` through the `env` field of the MCP config (`launch-args.ts:24`) | about 31 MB per lane, about 560 MB for 18 (46 to 15 MB); 36 fewer processes | Small to medium. Needs a separate bundle (index.ts imports `app`); `better-sqlite3` is built for Electron's ABI and should load, unverified; the notarization hang note in `mcp-serve.ts:8-10` applies to the same binary. `NOT_A_LANE_SERVER` / `NOT_A_SERVER_RE` (`port-alloc.ts:211`, `dev-servers.ts:62`) match "Operator Helper" and `--mcp-serve`; update if the command line changes |
| 4 | Serve MCP from the main process over localhost HTTP and give each lane only a URL with a per-lane token (no process per lane) | about 46 MB per lane, about 830 MB for 18 | Medium to large. `mcp-serve.ts:238-245` blocks synchronously waiting for a verdict (Atomics-style sleep over `better-sqlite3`); inside main that would freeze the app, so `dispatch` must become async. New listening socket needs auth. Do #3 first |
| 5 | Limit crash auto-resume to N lanes at a time (stagger, or resume only the lanes that were active) | avoids the immediate refill after a reboot; no steady-state saving | Small. Lanes not resumed stay offered as cards |
| 6 | Find and fix the renderer growth (about 650 MB or more over 10 hours) | up to 600 MB, unconfirmed | Needs the heap snapshots above first. Do not guess a fix |
| 7 | Find the GPU IOSurface peak (2.8 GB) and test `backgroundThrottling` or layer promotion for the 16 hidden panes | up to 300 MB steady, peak unknown | Needs the sampling above. `backgroundThrottling: false` is intentional (`index.ts:178-180`); lowering it is a product decision |
| 8 | Lower `INACTIVE_SCROLLBACK` from 2,000 to 1,000 | about 2 MB per lane | Not worth it; the terminal buffers are already small |

## Not established

- How many of the 18 lanes were idle at 12:00.
- What the 2.8 GB GPU peak consisted of and when it happened.
- What the renderer's extra 650 MB or more is.
- Whether `ELECTRON_RUN_AS_NODE` with the `env` field works end to end through Claude Code's MCP config and the asar bundle (the 15 MB figure is for a bare `-e` script).
- Whether memory pressure level 2 was reported before 12:00 (no log of it exists).

## Recommendation

Do #3 now (cheap, 560 MB, 36 fewer processes), #2's warning half now, and #1 as an opt-in setting with the transcript gate. Run the two measurements (renderer heap, GPU sampling) in a dev build before touching #6 or #7. Chrome and Umbra were most of the 24 GB, so none of these removes the risk; #2 and #1 give the user a way to react before macOS kills something.
