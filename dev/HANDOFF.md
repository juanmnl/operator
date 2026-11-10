# Handoff — 2026-11-10

`main` = `6136990` (pushed), tagged `electron-v0.29.0`. Release run 42746234626 succeeded on the first attempt; v0.29.0 is published on `juanmnl/operator-releases` (not a draft, six assets), and both update feeds (`latest-mac.yml`, `latest.json` with a signature) serve 0.29.0. Not GUI-verified.

## What shipped in 0.29.0 (release notes: `electron/release-notes/0.29.0.md`)

- **Lifecycle fixes, lane menu, by-hand suspend** (`operator/95b180`, merged @ 844cc57). Right-click a
  lane (rail collapsed or expanded) for Close, Suspend, Lane colour, Restart. ProjectCloseGuard dialog,
  one close toast with Retry, ⌘W arms on mid-turn lanes, Forget blocked while lanes are open.
  Results: `dev/results/lifecycle-fixes-2026-10-24.md` + review r1-r3.
- **Delivery hold on draft + terminal links** (`operator/98a1c0`, merged @ ccd2967). Messages to a lane
  wait while the person has unsent text (DraftHoldNotice pill, "Deliver now"); holds live in main
  (`lane-holds.ts`) and survive a reload. Links stop before trailing punctuation and resolve across
  wrapped rows. Results: `delivery-hold-on-draft-2026-10-24.md`, `terminal-link-punctuation-2026-10-24.md`
  + reviews.
- **Auto-close respects holds, picker P1/P2** (`operator/b8ce80`, merged @ 4f330e0).
- **Renderer leak fix** (`operator/39e340`: 61ad42d + 0ac83f5 + 67b7756, merged @ ddbbfa7). DashboardView
  callbacks read sessions/terminals/projects through refs, so render contexts stop chaining old
  `allSidebarSessions` copies; per-lane sidebar cache; fingerprint instead of the 10 MB
  `projectsSerRef`/`savedSerRef` strings. QA 2 h with live lanes: retained contexts flat at 14 (unfixed
  54 → 77), 0.07-0.08 MB (unfixed 0.75 → 1.10). Review: mergeable. Results:
  `renderer-leak-measurement-2026-10-25.md`, `renderer-leak-live-lanes-2026-10-26.md`,
  `renderer-leak-fix-2026-10-26.md`, `renderer-leak-fix-review-2026-10-26.md`, `renderer-leak-fix-qa-2026-10-26.md`.
- **CI moved to `macos-15`** (b45d472). GitHub retired `macos-14` on 2026-11-02; jobs on it are cancelled
  in 1 s with "The configuration 'macos-14-arm64-us-default' is not supported".

Tests on `main` @ ddbbfa7: root 2146 passed. Electron 1002 passed on the fix branch.

## Verification state

- Nothing in 0.29.0 is GUI-verified. In-app recipes: `lifecycle-fixes-2026-10-24.md` ("In-app checks
  for QA") and `delivery-hold-on-draft-2026-10-24.md`.
- **The leak fix is not proven against the field's 30-35 MB/h.** The lab chain grew only 0.2-0.25 MB/h;
  scaled to 17 lanes about 6 MB/h. Check after a day or two on 0.29.0 (renderer RSS), or take a heap
  snapshot of a long-running real renderer (needs a CDP port on Juan's app, his call).

## Open

1. Leak gaps: callbacks driven by user actions only (layout, theme, grid) can still add chain links;
   QA's fix run had board-task traffic only (no real dispatch/status/assign), and no lane reached the
   80-message cap.
2. Fingerprint costs about 5 ms per `projects` change on the real 10 MB store (`renderer-leak-fix`
   write-up). Cheaper option if it matters: per-project fingerprint cached by tasks/dispatches identity.
3. Not dispatched: a Team-tab launch registers a duplicate project named after the folder; a fresh
   `OPERATOR_DIR` gets mock-bridge session rows; person-initiated closes (⌘W, lane menu, project close)
   don't warn about owed messages (optional, Juan's call).
4. Operator dispatch: twice a dispatch to `code` returned `send` to a lane whose worktree was released;
   it launched fresh only after that lane called `worktree_done`. Reports #2800/#2801 were never
   announced. See memory `project_delivery_brakes_stall`, `project_report_routing_untrustworthy`.
5. Older open items from the 2026-10-20 handoff: crash recovery not verified against a real renderer
   crash; banner polish notes; idle-suspend follow-ups (mcp-serve as node, staggered crash auto-resume,
   tailer ignores `CLAUDE_CONFIG_DIR`, never-turned lanes dropped on relaunch).

## Side work this session (other projects)

- **LiteLLM 1.107.0 incident check (2026-10-24):** nothing found locally or in Juan's 55 GitHub repos.
- **Mantel:** demo redeploy, guide status and an open venue issue are recorded in the Mantel hub note
  (Obsidian vault), not here: this repo is public.
