# Handoff — 2026-09-26

`main` = `f0ec1e8` (pushed). **0.27.0 published** (`electron-v0.27.0`, lightweight, run `36259557739`
green: test and release jobs). Verified: `operator-releases` v0.27.0 is not a draft or pre-release and has six
assets (dmg, zip, `Operator.app.tar.gz`, `latest.json`, `latest-mac.yml`, `SHA256SUMS.txt`); `latest.json`
serves 0.27.0 for `darwin-aarch64` with a 408-char signature; `latest-mac.yml` serves 0.27.0.

0.27.0 is also the first update FROM a build that contains the 0.23.0
updater fix to reach a user who updated through 0.26.0, so check `~/.operator/updater.log` for
`requested by Squirrel.Mac` before the restart prompt.

## Verification state

- **GUI-verified by Juan:** refocus on activation, including Cmd-Tab away while typing in the
  Preview and back.
- **Everything else in 0.27.0, and all of 0.24.0-0.26.0, is verified by tests, typecheck and review
  only.** Worth trying by hand: Diff panel Merge on a running lane, Settings → Worktrees (Rescue,
  labels, the one-press safe removal), side panel and rail collapse, scrolling up in a long idle lane
  after switching away and back, the Add agent menu.
- Tests on `main` before the release commit: root tsc and electron typecheck clean; electron 790,
  renderer 1598.

## What shipped in 0.27.0 (release notes: `electron/release-notes/0.27.0.md`)

Branches merged 2026-09-25/26, each reviewed adversarially by the Review lane until merge-ready.
Reviews and results are in `dev/results/*-2026-09-25.md` and `*-2026-09-26.md`.

- **Scrollback freeze** (`80be6da`). Hiding a pane lowers `scrollback` 10,000 → 2,000; xterm 6 trims
  the buffer without firing the events its viewport syncs on, so the viewport sat ~8k lines past the
  buffer. `resyncViewport` in `lib/terminal-options.ts` calls xterm privates
  (`_core._viewport.scrollToLine` + `queueSync`). **`@xterm/xterm` is pinned to 6.0.0** for that
  reason, with a canary test (`9b2bbae`). Don't unpin without re-checking those names.
- **pty batching** (`electron/src/main/pty-batch.ts`). One IPC message per 16 ms or 64 KB; a read
  after a quiet spell is sent at once (keystroke echo). Flush on exit and kill. Measured 540 → 155
  msg/s on a paced four-shell workload.
- **Worktree cleanup** (`worktree-reap.ts`, from the audit `worktree-cleanup-audit-2026-09-25.md`):
  provably non-work dirt ignored (byte-identical untracked copies, root `node_modules` symlink;
  tracked edits still count); `sessions.json` claims kept only when a live pty backs them or another
  live Operator pid wrote them; interrupted user-started removals drained at boot and quit;
  ended-session records never drained; Rescue action copies unsaved files + patch to
  `~/.operator/rescued/`; squash/rebase-merged label; debris enters the one-press tier only with the
  interrupted-creation shape. `AUTO_REAP_ON_TRIGGERS` is still false.
- **Gutted checkouts.** Cause of mantel lane t2's gutted `mantel-55da80`: the mantel coordinator's
  `gh pr merge --squash --delete-branch`; gh 2.100 runs `git worktree remove` on a linked worktree
  that has the branch checked out, and the lane's Vite made it fail halfway
  (`mantel-55da80-gutted-2026-09-25.md`). Now: `BRANCH_SAFETY_NOTE` in the launch note,
  `checkout-health.ts` detects a live lane in a checkout with no `.git`, and merge/discard refuse
  while another live pty is in the worktree; the Diff panel stops its own lane only after the
  refusals, and keeps a worktree still dirty after the merge.
- **Cross-project messaging** (`lib/bus-name.ts`). Every lane is launched with
  `claude --name <slug>--<role>`; verified on CLI 2.1.283 that this sets the session descriptor's
  `name` with `nameSource: "user"`. Matching is by exact slug (the `-` version let `mantel-landing`
  read as `mantel`). Unstamped tabs get their own brake key; no unscoped report announce/expire; the
  MCP caller is matched on terminal id plus session or cwd. **The mantel/uwazi misroute Juan saw
  left no trace on disk**; the most likely path was a lane picking a session by prefix on the
  machine-wide bus, which the naming closes.
- **Side panel and rail** (`SidePanelSlot.tsx`, `lib/layout-motion.ts`): the content no longer
  re-lays out during the move, the terminal fits once after it, and the panel yields before the
  console drops below 70 columns. Add agent menu placement (`lib/menu-placement.ts`, shared
  `PopMenu`).
- **Refocus on activation** (`electron/src/main/activation.ts`, `lib/refocus.ts`,
  `lib/refocus-controller.ts`).
- **Infra lane preset** and corrected Code/Review/Design/QA charters; lanes still carrying the old
  stock text are migrated at load.
- **Dev instances use their own port windows** (`electron/src/main/port-ranges.ts`), and
  `npm run dev` takes `OPERATOR_ELECTRON_PORT`, then `OPERATOR_DEV_PORT`, then 1610.

## In flight

- **Lanes as profiles** (several live instances of one lane per project). Plan:
  `dev/results/lane-profiles-plan-2026-09-25.md`, 12 steps, each mergeable alone; step 7 is the
  first that lets a second instance exist. **Code is on steps 1-3** (identity module, stamping
  `instance`, store columns) on a new branch from `main`; no branch had appeared when this was
  written. Code was told the merged name format is `<slug>--<role>`, so instance n≥2 needs a suffix
  that parses unambiguously (e.g. `<slug>--<role>--<n>`). Step 12 (UI) needs Design's answers to the
  plan's §4 questions, not yet dispatched.
- **Renderer memory (1.26 GB live) is unexplained.** QA's baseline
  (`dev/results/perf-baseline-2026-09-25.md`) rules out xterm buffers and JS heap in the harness.
  The heap-snapshot run with real lanes was approved twice and never ran; the dev instance it needed
  has since exited. Next step, if wanted: a heap snapshot of the real app.

## Worktrees

`~/.operator/worktrees` held 18.7 GB on 2026-09-25; about 12.4 GB (31 dirs) was safe to remove, listed
in `worktree-cleanup-audit-2026-09-25.md` (List 1). Nothing was removed; Juan removes them through
Settings → Worktrees, which in 0.27.0 no longer asks about the non-work dirt. Six lane reports that
existed only in old worktrees were copied into `dev/results/` (`b4938a7`).

## Gotchas learned this session

- **Launching a dev instance of Operator:** use `electron/` `npm run dev`, never the root `npm run dev`
  (that is the Tauri-era Vite config). Always set `OPERATOR_DIR` to a scratch dir: the boot and quit
  reapers act on whatever `~/.operator` they are given, including the live app's lanes.
- **Test lanes are real agents.** Design's test lane in a dev instance searched the vault and started
  an HTTP server on 1422. Don't leave test lanes running unattended.
- **Late reports.** `mcp__operator__report` announcements arrive oldest-first, often long after the
  work was acted on from the result file. Check the commit is already merged before acting.
- **Merges into `main` are Juan's** (run via `!`); pushes and tags are done on his explicit go-ahead.
