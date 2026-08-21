# Handoff — 2026-08-21

**`main` = `484d6a9`, pushed.** Root `npm test` 786 / 61 files · `tsc --noEmit` clean ·
`cargo check` clean · shell (`electron/`) 191 tests + 44 probe checks green on CI. Working tree
carries the user's own two changes from before this session (`.gitignore` modified,
`.claude/settings.json` staged for deletion) — leave them alone.

## The decision: Operator is moving from Tauri/WKWebView to Electron

Made 2026-08-20 by the user ("we're going electron"), after a measured case, not a vibe. The record:
`dev/briefs/2026-08-20-electron-shell-spike-RESULT.md` (M1: WebGL xterm under Chromium clean for
60 min continuous on real Claude Code output, DOM control identical; M2: 27-lane fleet rests at
230 MB renderer RSS under a 3.5 GB V8 ceiling instead of WebKit's hourly ~1.2 GB kill; M3: the
cost — 280 MB bundle / 359 MB idle / ~1 GB for three instances; M4: port ledger),
`…-electron-migration-plan-RESULT.md` (S0–S4), `…-tauri-updater-crossshell-handoff-RESULT.md`
(the Tauri updater WILL swap in an Electron `.app`: minisign over raw bytes, blind directory swap,
relaunch re-reads `CFBundleExecutable`), `…-electron-mcp-serve-probe-RESULT.md` (`--mcp-serve`
works from a packaged Electron app; **notarization is load-bearing** — an unnotarized quarantined
bundle hangs silently as an MCP server), `…-vscode-agent-host-competitive-RESULT.md` (AHP: the
same bet, no fleet surface yet; steal its reconnect model).

## What shipped

- **`electron/`** — the Electron shell. 85 of 91 `window.operator` methods native (the 6 left are
  `gridterm*`, dropped by decision: `alacritty_terminal` has no Node twin). Typed IPC derived from
  `src/renderer/env.d.ts` (fails to compile if a renderer method is unhandled), node-pty terminal,
  better-sqlite3 stores byte-compatible with the Rust ones, Node transcript tailer **accepted
  against the Tauri build's own `chat.db` rows: 9,213 rows / 5 real sessions / zero diffs**
  (`2026-08-20-electron-s1-transcript-tailer-RESULT.md`). S2/S3 accepted the same way
  (`2026-08-21-electron-s2-s3-acceptance-RESULT.md`): three real divergences found vs the Rust and
  fixed — the quit guard dropped `waiting` (a lane blocked on the user was missing from the ⌘Q
  dialog and counted idle), `JSON.stringify` insertion order vs serde's sorted keys (a first
  Electron save would have churned every key in `projects.json`), a `checkUpdate` rejection path.
  `src/shared/preview-inspector.js` is now the ONE source of the inspector script (`lib.rs`
  `include_str!`s it; Electron injects it). Renderer touched only to stop reaching past the seam
  (`showMainWindow`, `operatorHome`) and for `DragRegion`'s `-webkit-app-region` under Electron.
- **Three signed, notarized, stapled pre-releases** on `juanmnl/operator` via
  `.github/workflows/electron.yml` (tags `electron-v*` ONLY — `v*` is the Tauri job):
  `electron-v0.17.0-alpha.3` is current (DMG 151 MB · zip + `latest-mac.yml` · SHA256SUMS);
  alpha.2 superseded; **alpha.1's DMG was broken and removed** (its zip is fine). Bundle id stays
  `com.operator.app.tauri` on purpose (hand-off recipe), so a drag-over replaces the Tauri app in
  place and reads the same `~/.operator`. **Nothing goes through `latest.json`/operator-releases**
  — installed Tauri users are untouched until the one-way swap release is deliberately shipped.
- **Renderer fix, both shells:** `TerminalPane.tsx` fit starvation — the 150 ms "quiet" deferral
  had no bound, so streaming output starved every resize (0 fits in 2 s after a sidebar collapse);
  now `planDeferredFit` with a 500 ms cap (`2026-08-20-fit-starvation-fix-RESULT.md`).
- **Tauri CI fix:** `build.yml` now staples the `.app`, rebuilds + re-signs the updater tarball
  from the stapled app, notarizes the DMG itself (it never was), and asserts on the unpacked payload
  — proven green. Until this, every shipped Tauri build had NO stapled ticket.
- README updated for the move; the landing (`~/Developer/Operator-landing`, pushed) says so too —
  **its deploy is manual and still pending** (juanmnl.com/operator-app/).

## Verify before believing (this session's own corrections)

- The DMG of alpha.1 passed every CI assertion and was broken anyway: `release.mjs` staged it with
  `fs.cpSync`, which rewrites symlinks to ABSOLUTE targets; the zip (`ditto`) was fine. Now staged
  with `ditto` + a relative-symlink + `codesign` assertion before `hdiutil`. Lesson: **assert on the
  artefact you ship, where it ships** (the CI now validates the unpacked payload, not the build dir).
- Locally npm's install-scripts policy silently skips `esbuild`/`node-pty`/`electron-rebuild`
  postinstalls, so local tests passed where CI's first run died (vitest loading native deps built
  for Electron's ABI). The CI test job now installs `--ignore-scripts` + `npm rebuild` for the
  Node ABI, on Node 22 (better-sqlite3@13 needs ≥22); the release job does the Electron rebuild.
- better-sqlite3@13 ships N-API `prebuilds/darwin-arm64.node`; `build/Release` stays empty after
  electron-rebuild. Assert the prebuild, not `build/Release`.
- **Dispatches to a RUNNING lane were dropped twice** (zero trace in the lane's jsonl, no Operator
  note). After dispatching, grep the lane's transcript for the text before waiting on it. See
  memory `project_delivery_brakes_stall`.
- `/Applications/Operator.app` on this Mac is a **stale 0.5.0** copy (Jun 30). The user's running
  Operator is `src-tauri/target/release/bundle/macos/Operator.app` — don't confuse the two.
- The "something kills long-running processes" scare was the Code lane's own bench tooling, not
  Operator (`2026-08-20-external-process-kills-RESULT.md`).

## Rules learned the hard way (now in memory, apply them)

- **Do not install or launch GUI apps on the user's Mac unasked — lanes included.** I installed a
  side-by-side `Operator Preview.app` + `~/.operator-preview` to dodge a running lane; the user said
  no; both removed. A brief that said "run it from the bundle dir" made Code open Operator windows
  (and the stale 0.5.0). Write briefs as headless/simulated checks, or hand the user the command.
- `cp -R` breaks bundle symlinks on macOS; always `ditto`.
- The MCP plane has TWO tools (`report`, `task_status`); my briefs said three.

## Open, in priority order

1. **The user's three one-minute window checks on alpha.3** (they need a real window): a Finder
   drop onto the window (must not navigate; path lands in the terminal), ⌘Q with one lane mid-turn
   and one waiting (both listed, idle count right, "Stay open" keeps them), tray/inspector visuals.
   Also the old three from the Tauri handoff (Finder drop, ⌘C/⌘V/⌘A after the menu rebuild, ⌘Q)
   were never done on Tauri either — moot if the Electron build becomes the daily driver.
2. **The one-way swap release (0.17.0 proper).** Proven: `…-s4-packaging-handoff-RESULT.md` —
   Tauri 0.16.0 staged locally pulled the minisign-signed Electron tarball from a local feed,
   swapped in place, relaunched as Electron `Operator`; the only unexercised inch is pressing
   "Install & Restart" in a live Tauri window. Recipe: keep bundle id, tar the Electron `.app`,
   `tauri signer sign` with `~/.operator/updater-private.key` (NEVER regenerate), publish
   `latest.json` (v > 0.16.0) + `latest-mac.yml` + zip in one release. This moves EVERY installed
   copy and cannot be undone from the app — the user's call, explicitly.
3. `src-tauri/` stays on `main` until that release has soaked; then branch + remove; the
   5-file version bump collapses to `package.json`s.
4. Electron-specific: gridterm mocks fail soft (confirmed) — decide whether a Rust sidecar terminal
   is ever wanted; `electron-updater` is inert until `OPERATOR_UPDATE_FEED` / the packaged default
   serves a real `latest-mac.yml` (the pre-releases already publish one); bundle-id rename to
   `com.operator.app` as a later ordinary update (TCC risk isolated).
5. Still-open product items from before, unchanged: delivery brakes cascade
   (`project_delivery_brakes_stall`), close-project no-op, scrollback baseline sizing at 27 lanes,
   the renderer-side ghost candidates (follow us to Electron; now debuggable in Chromium devtools).

## Lanes at handoff

All idle. Code's worktree `operator-c25838` (branch `operator/c25838`) is fully merged. QA and
Research reported via files (no `operator__report` ever reached the coordinator this session —
results were read from the worktrees). Leftover on this machine from me: the Electron dev shell
may still be running (`electron/` at commit 91a3eb2 in a scratchpad checkout, pid 54234, Vite on
:1430, `OPERATOR_DIR` pointed at a scratchpad copy) — safe to kill; nothing else.

## Reference

- Memory: `project_electron_decision.md` (the full timeline), `project_shell_electron_reconsider.md`
  (the background), `feedback_no_unasked_installs.md`, `project_delivery_brakes_stall.md`.
- Briefs + results: `dev/briefs/2026-08-20-*`, `dev/briefs/2026-08-21-*`.
- Release: https://github.com/juanmnl/operator/releases/tag/electron-v0.17.0-alpha.3
