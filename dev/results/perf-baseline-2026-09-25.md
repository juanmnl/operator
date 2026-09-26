# Performance baseline, 2026-09-25

Measure only. No source file was changed. Checkout `65ffdd2` (0.26.0 plus the hub-note commit). Scripts are in
`dev/results/perf-baseline-2026-09-25-scripts/`.

## What could and could not be measured

| Target | Status |
|---|---|
| Live app (`/Applications/Operator.app` 0.26.0, up 3 days) | Observed passively with `top`, `ps`, `footprint`, `vmmap`. No CDP: nothing answered on 9340 or 9344, and the installed build does not open a debug port. I did not restart or launch the user's app (it holds 15 running lanes). |
| Renderer on `:1428` | That is the Vite dev server for the mock harness (`dev/mock.html`, React dev build). Used only for React render costs. Everything else used production builds of the same harness served from `:1429`. |
| Real Electron startup, real IPC cost, heap snapshot of the live renderer | **Not measured.** See "Not measured" at the end. |

Harness limits that apply to every "harness" number: headless Playwright Chromium on this Mac, mock bridge
(`dev/mock-bridge.ts`, 4 lanes, small fixtures, no real IPC, no real pty), pty output replayed from
`scripts/width-audit/claude-stream.bin`. The `.requests` page error (mock has no `openDispatches` fixture) repeats
in every run and is a mock gap, not an app bug.

## Numbers

### Live app (real data)

Method: `top -l 7 -s 10 -o cpu` (first sample dropped, 5 samples of 10 s), `ps`, `footprint -p`, `vmmap -summary`.

| Process | CPU mean (min–max) | Memory |
|---|---|---|
| Renderer (pid 79697, up 3d 1h) | **16.2%** (14.4–18.9) | RSS 1256–1296 MB, footprint 1269 MB, peak 1.4 GB |
| GPU process | **9.9%** (9.8–10.1) | RSS 284–380 MB |
| Main process | **3.6%** (3.4–3.9) | RSS 146–152 MB |
| 16 `Operator --mcp-serve` processes + 32 Electron helper children | not sampled | footprint **733 MB** (458 MB mains + 275 MB helpers), 48 processes |
| 18 `claude` lane processes (context, not Operator code) | not sampled | RSS 3.9 GB |

- Renderer footprint by category (`footprint`, `vmmap`): 1095 MB dirty in one anonymous tag ("App-Specific Tag 16",
  3794 regions) and 163 MB in "Tag 14". The tools do not say which allocator owns Tag 16 (V8 or PartitionAlloc), so
  this does not split JS heap from DOM or canvas memory.
- Renderer RSS over about 90 s: 1296 → 1277 MB. Flat; no growth visible on that timescale. Hourly growth was not
  measured. `dev/results/scrollback-long-sessions-2026-09-25.md` recorded the renderer at "800 MB after 3 days"
  earlier today, so the two readings differ by roughly 450 MB; different instruments, not comparable without a
  matching method.
- Machine pressure at the sample: 23 GB used, 8.1 GB in the compressor, 327 MB unused (`top` header).

### Startup to first interactive frame (harness, production build, 8 cold contexts)

Method: `PerformanceObserver` paint entries, a `MutationObserver` for the first `.xterm-screen`, CDP `Performance.getMetrics`.

- First contentful paint: median **80 ms** (72–136).
- First xterm mounted: median **108 ms** (104–180).
- Script duration in the first 3.5 s: 141 ms of 313 ms main-thread task time. One 52 ms long task in one run, none in the rest.
- Transfer: 1.5 MB, 8 resources, 500 DOM nodes, JS heap 6.4 MB.
- This is a floor. It has no app boot, no `sessions.json` / `projects.json` load, no real IPC. Real Electron startup was not measured.

### Bundle size

Method: `vite build` of `electron/vite.config.ts` and of `dev/mock.html` (minified), `esbuild --metafile` for attribution.
`electron/out/renderer` in the checkout is from Sep 6 and stale, so it was rebuilt into scratch.

- One eager JS chunk pair: `main` 544 KB + `styles-*.js` 718 KB = **1.26 MB, 361 KB gzip**. No code splitting.
- By package: `src/renderer/components` 381 KB, `@xterm/xterm` 336 KB, `react-dom` 177 KB, `@xterm/addon-webgl` 123 KB,
  `src/renderer/lib` 90 KB, `src/renderer/views` 79 KB (`DashboardView.tsx` alone 79 KB), unicode-graphemes addon 33 KB.
- Installed app: 312 MB on disk, `app.asar` 20 MB, Electron Framework 274 MB.

### CPU at idle and while streaming (harness, production build)

Method: CDP `Performance.getMetrics` `TaskDuration` delta over the window ÷ wall time (main-thread CPU, not GPU); 20 s idle,
10 s per stream case after a 1.5 s warm-up; timer and rAF callback counts from wrapped `setTimeout` / `setInterval` / `requestAnimationFrame`.

| Case | Main-thread CPU | Style recalcs/s | Layouts/s |
|---|---|---|---|
| Idle, 4 lanes (2 running/compacting in the fixture) | **5.4%** (4.7–5.4 across 5 runs) | 60 | 0.1 |
| Idle, home/landing state (`?empty=1`, no lanes) | **7.5–8.1%** (2 runs) | not recorded | not recorded |
| 4 lanes × 20 Hz × 1 KB (80 KB/s) | 12.0% | 49 | 31.5 |
| 4 lanes × 60 Hz × 2 KB (492 KB/s) | 24.8% | 156 | 149 |
| 1 visible lane × 60 Hz × 2 KB (125 KB/s) | 24.0% | 112 | 108 |
| 3 hidden lanes × 60 Hz × 2 KB (366 KB/s) | 8.7% | 16 | 4.8 |

- Rates are synthetic. The real byte rate of a Claude Code pty was **not measured** (nothing in the app counts it).
- One visible lane costs about as much as four (24.0% vs 24.8%): the visible pane's xterm repaint dominates, hidden lanes are cheap (8.7%).
- Idle timers: `requestAnimationFrame` 60/s (the orb frame loop, `StatusWave.tsx:436`), intervals 8.1/s: the 500 ms dispatch poll
  2/s, per-pane 1 s heal check 4/s, heartbeat 1/s, 4 s report poll and 4 s poll `C()` 0.25/s each, 5 s dev-port poll 0.2/s.
- CPU profile of 10 s idle (`Profiler`, 200 µs sampling, unminified build): `draw` 60 ms + `easeInOut` 47 ms + `bx` 7 ms +
  `twinkleProgress` 4 ms ≈ 120 ms JS (1.2%), and 251 ms "(program)" (2.5%, native style/paint/composite). 96% of samples idle.
- Home/landing state: `document.getAnimations()` returns 90 concurrent `twinkle-logo` CSS animations on SVG (`fill`, `opacity`, `transform`).
- `prefers-reduced-motion: reduce` did not lower idle CPU (4.8 / 5.3 / 5.1 / 5.4% for normal / reduce / normal / reduce) and style recalcs stayed
  at 60/s. I did not find what produces them under reduced motion.

### Switching cost (harness, production build)

Method: capture-phase `keydown`/`click` listener, `event.timeStamp` to the second `requestAnimationFrame` after it (2 frames = 33 ms at 60 Hz, so
anything near 33 ms is the measurement floor), `longtask` observer.

| Action | Idle | 4 lanes streaming 60 Hz × 2 KB |
|---|---|---|
| Lane switch ⌘1/2/3 | median 25.7 ms, p95 34.1 ms, no long tasks | median 23.6 ms, p95 33.7 ms |
| Project switch operator ↔ el-encanto | median 32 ms, p95 34 ms; first switch of a run had one 124–143 ms long task (3 runs) | median 31.4 ms, p95 33.7 ms |
| Console ↔ Terminal | median 31.3 ms, p95 33.9 ms | median 29.2 ms |
| Lane switch after all 4 lanes hold 10 000+ lines | median 21.8 ms, p95 33.1 ms, no long tasks | not run |

Switching is at the frame floor with 4 lanes. The one exception is the first project switch (mount cost, 124–143 ms). Behaviour with 15 lanes
and large real scrollback was not measured. Opening Preview from the toolbar was not measured (the toolbar button disappears once toggled, and I
did not script around it).

### Renderer memory (harness) and terminal buffers

Method: `HeapProfiler.collectGarbage`, `Performance.getMetrics` `JSHeapUsedSize`, `Memory.getDOMCounters`, renderer RSS via `SystemInfo.getProcessInfo` + `ps`.

| Point | JS heap | DOM nodes | Renderer RSS |
|---|---|---|---|
| Baseline, 4 lanes | 5.1 MB | 588 | 175 MB |
| +12 000 lines × 4 lanes | 9.8 MB | 1056 | 230 MB |
| +24 000 lines × 4 lanes | 9.6 MB | 940 | 228 MB |
| +100 / +200 / +300 MB of output across 4 lanes | 9.3 / 9.2 / 9.7 MB | 1608 / 1608 / 1398 | 250 / 251 / 252 MB |

- Terminal output memory is bounded and flat: about 19 MB of RSS per lane at full scrollback, no growth from 100 to 300 MB of output.
  Terminal buffers therefore do not account for a 1.26 GB renderer. This matches the cap analysis in `scrollback-long-sessions-2026-09-25.md`.
- The harness pushed about 2.9 MB/s total into 4 xterm panes (100 MB per 35 s, with a 2 ms yield between pushes). That is a harness-paced number, not a ceiling.
- "After 1 h of lane output" was not run in real time; the 300 MB soak is the accelerated stand-in. The fixtures hold a few MB of app state,
  so the harness cannot reproduce state-driven growth (sessions payloads, projects, reports).

### Main-process work per pty chunk, and the tailer (real transcripts, Node 26 running the shipped `transcript.ts`)

Per chunk (`terminals.ts:347-352`, microbenchmark in Node with real Claude output; ns-level hrtime over 3000 runs):

| Chunk | main: `Buffer.from` + history + base64 | renderer: atob + bytes + `TextDecoder` | renderer: `detectDevServerPort` + `stripOrnaments` |
|---|---|---|---|
| 512 B | 0.6 µs | 1.1 µs | 2.6 µs |
| 2 KB | 0.6 µs | 3.1 µs | 3.8 µs |
| 8 KB | 1.9 µs | 11.6 µs | 12.7 µs |
| 32 KB | 8.6 µs | 45.5 µs | 48.2 µs |

Per-chunk JS is microseconds. What is not batched: `terminals.ts:347-352` calls `broadcast` (`webContents.send`) once per node-pty chunk, so IPC
message count equals pty chunk count. Electron's IPC cost per message was not measured.

Tailer (`transcript.ts`, polled at 1 Hz per lane, `poll()` at `:299`): reads the whole file into one `Buffer.alloc(length)` (`:317`) and splits it (`:323`)
on the first poll after `register`, with no yielding.

| Transcript | First poll | Peak RSS delta of the Node process | Retained heap |
|---|---|---|---|
| 0.4 MB | 7 ms | 6 MB | 2 MB |
| 18.9 MB | 78 ms | 72 MB | 6 MB |
| 54.2 MB | 238 ms | 133 MB | 9 MB |
| 79.7 MB | 301 ms | 171 MB | 5 MB |
| 172.4 MB | 631 ms | 238 MB | 6 MB |
| **15 most recent saved lanes, 421 MB total** | **1489 ms** | **+937 MB** | not recorded |

- The 15-lane run measured a **528 ms maximum event-loop block** (1 ms watchdog interval). In Electron main that loop also forwards pty data and IPC.
- Steady state after that: a tick over 15 unchanged transcripts costs 0.53 ms.
- The `sessions` broadcast (`transcript.ts:757` → `index.ts:274`) sends every lane on every tick where anything changed: **1258 KB for 15 lanes**
  (49–101 KB per lane, 80 narration entries each). `structuredClone` 1.34 ms, `JSON.stringify` 2.21 ms in Node. Up to 1 Hz.
- The first tick also queued 18 564 narration entries (6.9 MB) for `chat.db`. Upserting that many rows in a WAL SQLite with a Python harness: 39 ms
  insert, 42 ms conflict-update. Small.
- Transcripts on disk: 230 files over 1 MB, largest 314 MB (median of those 3.9 MB). Saved-session transcripts total 474 MB.

### Other main-process reads and writes

- `projects.json` is **3.13 MB** (17 projects, 1471 tasks; `mantel` alone 857 KB). On each `projects` state change (`DashboardView.tsx:3755-3760`):
  renderer dedupe `JSON.stringify` 2.7 ms + `localStorage.setItem` 5.1 ms (Chromium, 2.8 MB string) + structured clone for IPC 2.4 ms ≈ 10 ms
  on the renderer thread; main `stableStringify` (sorted keys, indent 2, `store.ts:45`) 7.0 ms + write 1.4 ms ≈ 8.4 ms.
  Plain `JSON.stringify(…, null, 2)` is 4.4 ms. How often `projects` changes during real work was not measured.
- `artifactReports(200)` returns about **439 KB** per call (200 newest of 1542 rows, 7.3 MB table); the query is 2.1 ms (`sqlite3 -readonly`).
  The renderer calls it every 4 s and stores the new array unconditionally (`DashboardView.tsx:3899`).
- `chat.db` is 176 MB, 212 800 `messages` rows (159 MB in the table). `~/.operator/worktrees` is 19 GB (disk, not perf).

### React re-renders (harness, unminified production build with a fake DevTools hook counting fibers with `PerformedWork`)

4 lanes; component names from the unminified build. Re-render cost from the Vite dev server (React dev build, `root.current.actualDuration`),
so those millisecond figures are inflated relative to production.

| Case | Commits/s | Component renders/s | Notes |
|---|---|---|---|
| Idle | 1.0 | 48.5 | `TerminalPane`, `TerminalSurface`, `SessionItem`, `MemberRow`, `StatusWave`, `FootItem` at 4/s each (once per lane per commit) |
| 4 lanes streaming 20 Hz × 1 KB | 0.5 | 24.8 | pty data does not cause commits (xterm writes bypass React) |
| `sessions` push at 1 Hz, 15 sessions, 886 KB, fresh object identities, nothing changed | 2.3 | 114 | same components at 9.2/s each |

- Render time (dev build): idle median 3.7 ms per commit (p95 6.7), 2.4 ms/s total; sessions push median 3.3 ms per commit (p95 6.4), 5.9 ms/s total.
  At 4 lanes React is cheap. It scales with lane count and was not run at 15 lanes with real state.
- `TerminalPane` and `TerminalSurface` re-render on every top-level commit.

## Ranked hotspots (top 10, by user impact)

Impact is judged from what the numbers show for the person using the app, and each entry says how solid its evidence is.

**1. Renderer memory, 1.26 GB at 3 days, cause unattributed.** Live: footprint 1269 MB, peak 1.4 GB, 1095 MB in one anonymous tag. The known kill
threshold is about 1.1 GB. Harness: terminal buffers plateau (about 19 MB/lane), JS heap 10 MB, so xterm and JS state as modelled do not explain it.
Candidates not yet tested: the per-second whole-array `sessions` replacement (1.26 MB/s of fresh objects, `index.ts:274`), the 3 MB `projects`
strings held twice (state plus `localStorage`), 439 KB report arrays every 4 s, canvas backing stores, image cache (58 MB on disk).
Fix path: take a heap snapshot and an allocation timeline of the live renderer before changing anything. Start the app once with
`OPERATOR_CDP_PORT=9340` (dev build, or `--remote-debugging-port=9340` on the packaged binary) and use DevTools Memory. Cheap mitigation regardless of the
snapshot: stop replacing unchanged state (see 6 and 7).

**2. Sustained CPU with no user activity: renderer 16.2%, GPU 9.9%, main 3.6% (live).** Harness attribution: the orb frame loop runs at 60 fps
whenever a lane is running or waiting (`StatusWave.tsx:436-450`, `joinFrameLoop`), and each frame evaluates `twinkleProgress` for every dot
(`StatusWave.tsx:282`, `:415`), which calls `easeInOut` (`:424`) doing a 24-step bisection per dot. Profile: those functions are about 1.2% JS
plus 2.5% native for 2 to 3 animating orbs in the fixture; a rail with more running lanes scales this. The landing state is worse than the lane view
(7.5–8.1% vs 5.4%): 90 concurrent SVG `twinkle-logo` animations (`LogoMark.tsx:51`, `styles.css:704`). Proposed fix: precompute the eased curve
once as a lookup table (removes the bisection), cap the orb loop at 30 fps, stop both loops when the window is not focused or `document.hidden`, and
pause the logo animation after a few seconds. `prefers-reduced-motion` should also stop them; measured to have no effect today. Earlier passes
(`perf-pass-1-twinkle.md` to `perf-pass-3-orbs.md`) already reduced this; the live number says a large share remains.

**3. Boot and lane-resume stall in main: 1.49 s, 528 ms event-loop block, +937 MB transient memory for 15 lanes (421 MB of transcripts).**
`transcript.ts:317` allocates a buffer the size of the whole file and `:323` splits it, in one synchronous pass per lane, on the first poll. Every
`register` (boot, lane launch, resume) pays it. Pty forwarding and IPC share that thread. Evidence: measured with the shipped code on this machine's
transcripts, in Node, not inside Electron main. Proposed fix: read in fixed chunks (1–4 MB) and `await setImmediate` between chunks; for very large
files parse only what the payload needs (the live payload keeps 80 entries) or persist a per-file cursor snapshot (path, size, mtime, derived state) so a
boot does not replay history.

**4. 16 `--mcp-serve` processes are full Electron trees: 48 processes, 733 MB footprint.** Each lane's MCP server is `Operator --mcp-serve`
(`terminals.ts:273`, `mcpConfigArg`; branch at `index.ts:368`); `ps` shows each main with a GPU-process and a network-service child. Per lane: about 29
MB main + 11 MB GPU helper + 7 MB network helper at rest (more once active; this lane's main is 92 MB RSS). Evidence: `footprint` on every pid.
Proposed fix, untested: run the server with `ELECTRON_RUN_AS_NODE=1` from a separate entry file (the `--mcp-serve` branch is inside `index.ts`, which
imports `electron`, so it needs its own entry), or serve all lanes from one long-lived process. Check that `better-sqlite3` loads under run-as-node
(same Electron ABI) and that the 85 ms startup in `dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md` does not regress.

**5. Streaming into the visible lane: +19 points of renderer CPU at 125 KB/s.** Harness only, synthetic rate. One visible lane (24.0%) costs as
much as four lanes together (24.8%); three hidden lanes at 366 KB/s cost 8.7%. Style recalcs and layouts run at 108 to 149 per second, driven by xterm
row DOM rewrites plus the per-write repaint (`TerminalPane.tsx:502`, `term.write(clean, scheduleRepaint)`) and the once-a-second layer rebuild while
output is recent (`:486-490`). The real output rate of a lane is unknown, so the user-visible weight of this is unmeasured. Proposed fix: first add a
per-lane byte counter to learn real rates; then coalesce visible writes to one per animation frame and re-check whether `scheduleRepaint` still
needs to run per write.

**6. The `sessions` broadcast sends everything, every second: 1.26 MB for 15 lanes.** `transcript.ts:757` emits `this.sessions()` for all tracks when
any is dirty; `index.ts:274` sends it; the renderer replaces its state with new objects each time. Cost per message is small (structured clone 1.3 ms in
Node) but the renderer receives about 1.2 MB/s of fresh objects while lanes work, which is allocation churn and defeats reference equality (114
component renders/s in the harness). Proposed fix: send only sessions that changed, and shrink the per-session narration tail in the payload (the
renderer holds 80 entries per lane; check which views read more than the last few).

**7. Top-level polls set state with new objects, so the whole tree re-renders every second.** Idle: 1 commit/s, 48 component renders/s at 4 lanes,
with `TerminalPane` and `TerminalSurface` re-rendering per lane per commit. Sources: `DashboardView.tsx:394` (`setReservedDevPorts(p || {})`, 5 s),
`:3899` (`setReports(rs ?? [])`, 4 s, 439 KB), the 500 ms dispatch poll (`:1795`) and the 5 s reconcile. Cost at 4 lanes is small (dev build: 3.7 ms per
commit, 2.4 ms/s), so the ranking reflects scale risk rather than a measured problem; the harness was not run at 15 lanes. Proposed fix: skip
`setState` when the payload is structurally unchanged, and wrap `TerminalPane`/`TerminalSurface` in `React.memo` with stable props.

**8. `projects.json` is 3.13 MB and is fully rewritten on every change.** About 10 ms on the renderer thread and 8 ms in main per change
(`DashboardView.tsx:3755-3760`, `store.ts:45-62`), including a 2.8 MB `localStorage.setItem` (5.1 ms) that duplicates the file. Board tasks and
dispatches live inside the project objects and only grow (1471 tasks). Change frequency during real work was not measured. Proposed fix: drop the
`localStorage` copy (the file is the source of truth), replace the sorted-key `stableStringify` with plain `JSON.stringify` (saves about 2.5 ms),
debounce the write, and move done tasks to an archive file.

**9. Bundle: one eager 1.26 MB chunk (361 KB gzip), no code splitting.** Harness startup is 80 ms to first paint and 108 ms to the first terminal, and
script time is 141 ms of the first 3.5 s, so the bundle is not the startup bottleneck on this evidence. Candidates for lazy loading: Preview, Tuning,
Agents library, Settings views (`AppPreviewPanel.tsx` 29 KB, `RosterPanel.tsx` 28 KB, `TaskBoard.tsx` 23 KB of minified output) and the WebGL
addon (123 KB) if it is off by default. Low impact until real startup is measured.

**10. Suspected, not measured: a write statement every 500 ms in the main process.** `openDispatches()` runs `expireDispatches()`, an `UPDATE …
WHERE answered_at IS NULL AND at < ?` (`chat-store.ts:564-570`), before every poll, and the renderer calls it twice a second (`DashboardView.tsx:1795`).
An UPDATE takes the SQLite write lock even when it changes no rows, and 16 `--mcp-serve` processes write to the same database, so main can wait on
`busy_timeout` on its own thread. I only timed the read side (2.1 ms). Proposed fix: run the sweep on a slower timer (every 10 s) and keep the
500 ms path read-only; measure lock waits before and after.

## Not measured

- Real Electron startup to first interactive frame, and any boot-time work before `createWindow`.
- Live renderer heap composition (no CDP into the running app) and its growth over an hour. Only 90 s of flat RSS was observed.
- Electron IPC cost per message and total IPC bytes per second at real pty chunk rates. Message rates were counted from the wrapped timers and the code.
- The real output rate of a Claude Code pty.
- GPU-process attribution (9.9% live).
- React render counts and switch costs at 15 lanes with real state.
- How often `projects` changes during real work.
- Whether `prefers-reduced-motion` should have stopped the 60 style recalcs/s.

## Addendum: real Electron dev app over CDP (2026-09-25, after the first write-up)

Target: the Electron dev app on `http://localhost:1428` (electron renderer, Vite dev server, unbundled) with CDP on 9340 and an isolated
`OPERATOR_DIR` (empty: no projects, no lanes, no `claude`). Playwright `connectOverCDP`; process CPU by `top -l 2 -pid`. Script: `perf-baseline-2026-09-25-scripts/real.mjs`.
Note on the earlier numbers: the harness runs above used `dev/mock.html` built with the root config, not the 1428 server, so they were not affected by which
config `:1428` served. The React render-time numbers came from a Vite dev server that was the root config (mock bridge); they stand as labelled.

- Reload to first paint (5 reloads, dev server serving 183 unbundled modules): FCP 124–148 ms (median 136), load event 80–99 ms. This is the dev server, not the packaged bundle.
- At rest, empty project state: JS heap 14.4 MB, 138 DOM nodes, renderer 0.3% CPU, Electron main 0.3%, GPU 0%. So the CPU and memory findings in items 1 and 2
  come from lanes, orbs and state, not from the shell itself.
- **Real pty path.** 4 plain shells (`shellSpawn`) replaying the real Claude output fixture, paced 6 KB every 50 ms per shell:
  **463 IPC messages/s carrying 320 KB/s, median chunk 800 characters (max 1001)**. Renderer main thread 1.1–1.3%, Electron main 1.8%, renderer process 1.5%.
  No xterm pane is mounted for these shells, so the renderer number excludes terminal parse and paint (those are in the harness table).
- The same shells flooded with `cat` in a loop: 771–864 messages/s at 533–597 KB/s (the loop finished quickly, so CPU for that case is not meaningful).
- Consequence for item 5 and for IPC volume: node-pty delivers about 800 to 1000 characters per chunk and `terminals.ts:347-352` forwards each as its own
  message, so message rate is roughly bytes/s divided by 800. Coalescing pty chunks per frame in main would cut messages by about an order of magnitude at these rates.
- JS heap after spawning, streaming and killing the shells: 14.4 → 14.7 MB. No retention visible.
- Not done here: a full-lane run with `claude` (would spend API usage) and a heap snapshot with real project state.
