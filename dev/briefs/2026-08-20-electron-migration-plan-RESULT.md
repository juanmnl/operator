# Result — Operator back to Electron: staged migration plan

Read-only planning. No code changed. Sources: `docs/tauri-migration.md`, `src/renderer/env.d.ts`,
`src/operator-bridge.ts`, `src-tauri/src/*.rs` (public surface), `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `.github/workflows/build.yml`,
memory `project_release_process.md`/`project_tauri_build_state.md`, the pre-Rust-port tree at
`94cb187^`, and `stablyai/orca` (MIT) for pty/worktree reference. `docs/tauri-migration.md` itself
is **stale** — it documents the 2026-06 port from the old hook-based permission-gateway era
(`server.ts` on :47821, permission `queue.ts`/`rules.ts`) which no longer exists; today's
14-module Rust surface (worktree/transcript/chatstore/mcp/quit/tray_anim/artifacts/…) postdates
that doc entirely, so this plan is built fresh off the current codebase, using the old doc only for
its Node-lib patterns (node-pty, better-sqlite3, js-yaml equivalents).

## Stage plan

| Stage | Scope | Node libs | LOC est. | Risk | No-equivalent |
|---|---|---|---|---|---|
| **S0** | Shell + real terminal (the in-flight spike) | electron ^34, electron-vite ^3, node-pty ^1.1, @xterm/xterm ^6 (+webgl addon iff M1 picks WebGL) | 200–400 | Low–Med | `gridterm.rs`/`alacritty_terminal` — dropped regardless of spike outcome |
| **S1** | Transcript tailer + chat store | better-sqlite3, plain `fs`+`setInterval` poll (no watcher lib — matches current 1s-poll Rust, no regression) | 1,100–1,550 | Medium | none |
| **S2** | Sessions/projects/folderprefs/agents/role defaults | js-yaml, plain fs/JSON | 600–800 | Low | none |
| **S3** | Worktree, usage/planlimits, MCP control plane, quit guard, tray, dock, preview inspector, drop guard | child_process/simple-git, better-sqlite3, electron `Tray`/`nativeImage`/`app.dock` | 3,100–3,800 | **Med–High** | none — but largest surface, most business logic |
| **S4** | Packaging: electron-builder, notarization, electron-updater | electron-builder ^26 (bump at impl time), @electron/notarize | 200–300 (config, not app logic) | Medium | Tauri `latest.json` feed format has no direct reuse — new updater feed, see hand-off |

Total new/ported LOC ballpark: **~5,200–6,850**, against ~11,159 Rust LOC today (JS/TS is generally
more compact than Rust for this class of code, and several pieces — worktree reap-dry-run/APFS
clonefile logic, expanded usage pricing tables — have no pre-Tauri ancestor at all and are net-new
regardless of language). Frontend (`src/renderer`, 29,432 LOC) is **untouched** — it is the one
thing this migration must not require porting.

---

## S0 — Shell + real terminal

Already the Code lane's spike (`dev/briefs/2026-08-20-electron-shell-spike.md`, in flight) — state
what to keep from it once that RESULT lands; don't duplicate the M1 WebGL-vs-DOM call here.

- **Directly revivable from `94cb187^`**: `terminal/pty-manager.ts` (102 LOC, plain node-pty
  spawn/write/resize/kill/list — matches `gridterm.rs`'s pty-facing job almost 1:1) and
  `terminal/terminal-registry.ts` (23 LOC, trivial bidirectional id map).
- **Needs rework**: `terminal/agent-launcher.ts` (56 LOC) — builds the `claude` CLI invocation via
  `zsh -ilc`; missing today's `--session-id <uuid>`, `--settings`, `--append-system-prompt` flags,
  all added post-port. The login-shell/quoting trick is still valid, just extend the arg list.
- **Transport change from both eras**: current Rust sends pty output over `terminal:data` as
  **base64** (renderer-side `TextDecoder` stream). node-pty's `onData` gives raw strings directly —
  drop the base64 hop entirely, one less encode/decode pass than either the current Tauri build or
  the old Electron one.
- **Acceptance criteria**: `electron-vite dev` boots the unmodified `src/renderer` bundle; a real
  Claude Code session runs 2+ hours in a spawned pty with scrollback readable and no atlas/garble
  reproduction (the terminal pain that triggered this migration — `project_terminal_ghost_*`
  memory family); renderer memory at the 27-lane shape used in
  `2026-08-06-renderer-heap-RESULT.md` is measured and compared against the ~1.1–1.2 GB WKWebView
  kill threshold it's meant to fix.

## S1 — Transcript tailer + chat store

- `transcript.rs` (1638 LOC) polls `~/.claude/projects/<slug>/<uuid>.jsonl` on a **1-second
  `std::thread::sleep` loop** — no `notify`/inotify crate in `Cargo.toml`. Node port needs no
  watcher library either: `setInterval` + a stored byte offset reproduces it exactly, same
  fidelity, same 1s latency, zero regression risk here.
- `chatstore.rs` (545 LOC): `rusqlite` (bundled SQLite) against `~/.operator/chat.db`, keyed
  `(session_id, seq)` with `INSERT OR IGNORE` idempotency. `better-sqlite3` reads the **same SQLite
  file format byte-for-byte** — no migration script needed, an existing `chat.db` from a Tauri
  install opens unmodified in the Electron build. Verify with a round-trip test: write with the
  Tauri build, read with the Electron build, and vice versa, before calling S1 done.
- `core.rs` (458 LOC) carries a comment: **"Ported from the Electron main process: sessions.ts and
  tool-summary.ts"** — this is a revert, not a fresh translation, and its structs are already
  camelCase-tagged to match `shared/types.ts`. Lowest-risk item in this stage for exactly that
  reason.
- `usage.rs` (452 LOC): parses `~/.claude/projects/<slug>/*.jsonl` into an in-memory cache
  (`Mutex`/`OnceLock` in Rust → a plain `Map` in Node), aggregates per time range. The pre-Tauri
  `usage.ts` (166 LOC) is a real skeleton but ~3x smaller than today's module — model-pricing
  coverage grew since; expect to extend it, not just port it.

## S2 — Sessions/projects/folderprefs/agents/role defaults

All on-disk formats (`~/.operator/{sessions.json,projects.json}`, `.claude/agents/*.md`,
`~/.claude/{settings.json,settings.local.json,managed-settings.json}`) are the actual contract per
the brief and **must stay byte-compatible** — this stage is validation-heavy, not logic-heavy.

- `agents.ts` (153 LOC, pre-Tauri) and `folder-prefs.ts` (201 LOC, pre-Tauri) are marked **directly
  revivable** — they already target the exact paths Operator still uses; `serde_yaml` → `js-yaml`
  is the only real substitution.
- `sessions`/`projects`/`role-defaults` save/load have no clean pre-Tauri ancestor at this shape
  (the old era's session model was hook-event-driven, not transcript-derived) — net-new, ~250–350
  LOC, low complexity (JSON read/write with the existing `shared/types.ts` shapes as the spec).

## S3 — the big stage (worktree, MCP, quit/tray/dock, preview, drop guard)

This is where most of the LOC and the plan's real risk lives. Sub-item breakdown:

- **worktree** (git create/status/diff/commit/merge/discard/remove + reap-dry-run): `worktree.rs`
  is pure `std::process::Command` wrapping the `git` CLI — no Rust-specific dependency, `execFile`
  or `simple-git` ports 1:1 conceptually. But the pre-Tauri ancestor `worktree.ts` (255 LOC) covers
  only basic create/status/diff/commit/merge/discard — **reap-dry-run and APFS clonefile awareness
  (`project_worktree_lifecycle_sota_design.md`) never existed in the old Electron code and are
  net-new**, not revivable. Recommend reading Orca's (MIT, `stablyai/orca`) `worktree-logic.ts`
  (branch-name sanitization — strips unicode/emoji safely, collapses `..` so a prompt-derived name
  can't produce a path-traversal or ref-format-rejected branch), `worktree-apfs-clone.ts` (the
  clonefile technique already flagged as the one steal in `project_worktree_lifecycle_sota_design.md`),
  and `worktree-removal-safety.ts`/`worktree-lineage-pruning.ts` (reap safety) as reference — MIT
  permits reading for reference with **no notice required**; only lifting code verbatim requires
  including Orca's license text + "(c) 2026 Lovecast Inc." notice in a NOTICE/THIRD-PARTY file.
  Est. ~1,200–1,500 LOC.
- **MCP control plane** (`mcp.rs`, 337 LOC): hand-rolled JSON-RPC 2.0 over stdio, three methods
  (`initialize`/`tools/list`/`tools/call`), deliberately dependency-free. **Key mechanism**:
  `main.rs` checks `args().any(|a| a == "--mcp-serve")` *before* Tauri starts and branches to
  `mcp_serve()` instead of opening a window — the same signed binary doubles as the MCP server via
  a CLI flag, spawned per-lane, no second binary to notarize. Electron replicates this exactly:
  check `process.argv` at the very top of `main/index.ts`, before `app.whenReady()`, and branch to
  a `readline`-over-stdin JSON-RPC loop instead of creating a `BrowserWindow`. Est. ~150–250 LOC —
  small, but see **Order of risk** below, this is the one to probe first.
- **artifacts.rs** (271 LOC, the report/task_status/brief store — separate `artifacts.db`,
  append-only, two-writer discipline between the app and short-lived MCP servers): `better-sqlite3`
  port, mechanical. ~150–200 LOC.
- **dispatch/reply tailing** (`operator:dispatch`/`operator:reply` events): logically continuous
  with S1's transcript work (sentinel-line matching against already-tailed jsonl content) but its
  full round-trip only testable once MCP/artifacts exist — gate here per the brief's staging.
  ~100–150 LOC.
- **quit guard** (`quit.rs`, 324 LOC): the Rust version replaces the native predefined Quit menu
  item because it binds `terminate:` directly, **bypassing Tauri's event loop** (documented
  workaround, `muda-0.19.2/src/platform_impl/macos/mod.rs:994`) — a custom menu item with the same
  ⌘Q accelerator is substituted so it routes through a normal event. **Electron doesn't need this
  workaround at all**: `app.on('before-quit', e => e.preventDefault())` is a first-class OS-level
  hook. Simpler in Electron, not harder. Same three paths stay unguardable in either shell — Dock
  right-click Quit, logout/restart, Force Quit/SIGKILL — that's an OS constraint, not a framework
  gap; QA should re-verify these three specifically, not assume parity. Est. ~150–200 LOC.
- **tray + tray_anim** (220 LOC, 7×7 dot animation at ~12fps rasterized to a macOS template image):
  pre-Tauri `tray.ts` (76 LOC) gives the `Tray`/`Menu`/`nativeImage` skeleton but its content
  (badge count from the dead permission `queue.ts`) is superseded — source badge/status state from
  the transcript-derived session model instead. Animation logic is new translation work, ~250–350
  LOC total.
- **dock icon** (`set_dock_icon`): Rust does this via `objc2`/`objc2-app-kit` raw Cocoa calls.
  Electron's `app.dock.setIcon(nativeImage)` is a **first-class built-in** — this is a case where
  Tauri needed more native-API surface than Electron will. ~30–50 LOC.
- **preview inspector** (`preview_inspect_*`, a second Tauri webview): per
  `project_preview_annotations.md`, the current architecture needed a **custom-scheme beacon hack**
  because an embedded remote webview couldn't route command IPC. Electron's `<webview>` tag has
  **real IPC** (`ipc-message` events) — this stage may *simplify* on today's build, not just port
  it, but the feature's current build state is only partial per that memory, so confirm scope with
  Design/Code before estimating tightly. ~300–400 LOC, Medium risk (UX-sensitive, fuzzy scope, not
  a mechanical port).
- **drop guard**: Electron's native drag-drop exposes `.path` directly on dropped `File` objects
  (simpler than Tauri's `onDragDropEvent`, per the bridge inventory) — the `file://` stray-navigate
  bug this guards against may not even reproduce by default in Electron; still add the
  `will-navigate` veto as a backstop and have QA re-verify rather than assume the bug class is gone.
  ~50–80 LOC.

**A design fork worth naming explicitly, not defaulting silently**: Orca runs pty + worktree
operations in a **separate daemon process** (`src/main/daemon/daemon-server.ts`, a `node:net`
Unix-socket NDJSON server) so terminals survive app quit/relaunch — architecturally different from
today's single-process Tauri model. Recommend **staying single-process for S3** (matches current
architecture, lower risk, ships faster) and treating the daemon split as a **post-S4 candidate**
only if terminal-survives-app-quit becomes a wanted feature later, not a requirement of parity.

## S4 — Packaging

- electron-builder targeting a single `aarch64`/arm64 DMG — matches both the old Electron era's
  scope and today's Tauri CI, which also builds `aarch64-apple-darwin` only (no universal/x64
  build exists in either era).
- **Signing/notarization reuse the exact same credentials already in GitHub Actions** — Developer
  ID `Juan Cornejo (UJS4C5GUCW)` and the App Store Connect API key secrets
  (`APPLE_CERTIFICATE`/`APPLE_API_KEY`/`APPLE_TEAM_ID` etc., confirmed present in
  `.github/workflows/build.yml`) carry over unchanged — no new Apple-side setup. electron-builder's
  `afterSign` hook + `@electron/notarize` is the standard path (the old pre-Tauri `package.json`
  had `notarize: false` — never wired up back then; this migration needs to actually wire it, not
  revive a dead flag).
- **`macOSPrivateApi: true`** in today's `tauri.conf.json` has no direct Electron equivalent flag —
  check whether the transparent-until-rendered launch splash
  (`project_splash_screen.md`, "needs macos-private-api") depends on private-API behavior; if so,
  that specific effect may need a different implementation under Electron's public APIs, flag as a
  possible regression to verify, not assume away.
- LOC is config-heavy (electron-builder.yml/config block, a notarize hook script, CI workflow
  rewrite) — ~200–300 lines, not application logic.

---

## Hand-off plan for installed users

**Constraint, architecturally established, recommend Code re-verify against
`@tauri-apps/plugin-updater` source before committing to it**: the Tauri updater validates a
specific bundle format (`.app.tar.gz`) against a minisign signature keyed to the pubkey baked into
`tauri.conf.json`, fetched via a `latest.json` shaped `{version, notes, pub_date,
platforms:{darwin-aarch64:{signature,url}}}`. It is not a generic installer — it has no path to
download-and-run an arbitrary `.dmg`. Electron's own updater (`electron-updater`) expects a
different feed shape (`latest-mac.yml`) entirely. **The two are not bridgeable through either
updater's normal mechanism.**

**Recommended option: a final Tauri release whose only job is a "download the new Operator" notice
with a link.** Reuses the *existing, already-working* updater delivery — installed Tauri users
already poll `juanmnl/operator-releases` and will pick this up automatically — and costs almost
nothing to build (strip the app to one always-shown screen). Ship it **after** S4's Electron build
is itself notarized and downloadable; bump the Tauri app's version strictly above `0.16.0` so the
updater actually offers it, keep publishing a normal `latest.json` for it so the existing update
machinery works unmodified.

Rejected: serving the Electron `.app` disguised inside a Tauri-updater-shaped payload — the
plugin's own format/signature validation is the whole point of the mechanism and isn't something to
route around; accept a one-time manual step instead (a click-through link) over asking users to
trust a payload the safety mechanism wasn't designed to verify. Accept a plain manual reinstall as
the fallback for anyone who never opens the notice — no auto-migration path exists in either
direction.

**Coexistence — confirmed safe on disk**: today's identifier is `com.operator.app.tauri`
(`tauri.conf.json`) — the trailing `.tauri` reads like deliberate foresight for exactly this
transition. Recommend the Electron build ship as `com.operator.app` (drop the suffix). Because
Operator's durable state lives in **`~/.operator/*`**, not inside a bundle-id-scoped
`~/Library/Application Support/<id>` directory, **the Electron build reads the same
`sessions.json`/`projects.json`/`chat.db`/`artifacts.db` as an existing Tauri install with zero
migration needed** — confirmed by S1/S2's byte-compatibility findings above. The only casualty is
localStorage-backed prefs (theme, sidebar order — already flagged in CLAUDE.md as
non-persisted-across-restart for sidebar order specifically), which reset once because Tauri and
Electron serve the renderer from different origins. **Caveat**: don't run both apps against
`~/.operator` at the same time — SQLite's WAL mode tolerates multi-process access, but concurrent
worktree/session writes from two live GUI processes wasn't audited here; quit one before opening
the other during the transition window.

**Versioning**: stay in `0.x` — this is a shell rewrite, not a maturity milestone, and a `1.0` bump
would misrepresent it as one. Note the transition in-app (About screen / release notes) for anyone
who goes looking later.

---

## Repo shape

- Electron code lives at `electron/` at repo root. `src/renderer` (and `src/shared`) stay exactly
  where they are, unmodified — that's the whole point of preserving the bridge as a seam.
- `src-tauri/` stays on a **branch**, not deleted, until the hand-off release (the Tauri
  "download the new Operator" notice build) has been live for a buffer period — pick a length (2–4
  weeks is a reasonable default) so a revert stays possible without archaeology; only remove
  `src-tauri/` from `main` after that window closes.
- **CI**: still needs `macos-14` for signing/notarization regardless of shell — no billing change
  from the shell switch itself (`project_open_followups.md`'s "went public to dodge Actions
  billing" decision is unaffected). Replace `cargo test --locked --lib` with vitest running the
  `electron/` main/preload code in a Node test environment — reuse the existing frontend test
  runner rather than adding a second framework; the 775 renderer tests are untouched since the
  renderer is untouched. The 173 Rust tests have no automatic replacement — count each ported
  module's test coverage complete only when an equivalent-scenario Node/TS test exists, prioritized
  by risk: worktree, transcript, chatstore, quit-guard scenarios first.
- **Version bump simplifies**: today's 5-file bump (`package.json`, `package-lock.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`) collapses to
  essentially `package.json` + `package-lock.json` once `src-tauri/` is gone — no separate manifest
  duplication to keep in sync.
- **Dev loop**: `electron-vite dev` should bind the Operator-reserved dev port (this session's own
  worktree is pinned to 1432 via `OPERATOR_DEV_PORT`) the same way `scripts/tauri.mjs` resolves a
  free port today — write a `scripts/electron.mjs` wrapper mirroring that script's env-var contract
  so nothing about the outer port-reservation/CI tooling has to change.
- **Not in scope for this plan, flagged for later**: Operator's own north star
  (`project_direction.md`) is a harness *orchestrator*; VS Code's Agent Host now runs the Claude
  Agent SDK / ACP / AHP **in-process** in its Electron-adjacent-in-spirit dedicated process
  (research just completed, `dev/briefs/2026-08-20-vscode-agent-host-competitive-RESULT.md`) rather
  than shelling to a CLI in a pty. This migration's S0–S4 preserve today's CLI-in-pty architecture
  end to end — moving to in-process Agent SDK hosting is a separate, much larger decision, not
  something to fold into a shell swap.

---

## Order of risk

**Riskiest single item, and the cheapest thing to probe first: the MCP server's self-spawn via
`--mcp-serve` inside a packaged, signed, notarized Electron `.app`.** It's small (~150–250 LOC) but
if `process.execPath`/the packaged app's self-path doesn't resolve to a stable, re-executable
binary once wrapped in asar + Squirrel-style auto-update helpers, the **entire MCP control plane —
report/task_status/brief, everything this Research lane itself uses to talk to Operator** — breaks
silently, and only once someone builds + signs + notarizes + installs a real `.app` and tries
`--mcp-serve` from outside `electron-vite dev`. It will work fine in dev and fail invisibly at
release time if untested early.

**Cheapest probe**: before writing any of S1–S3's actual business logic, build the thinnest
possible packaged/signed/notarized `.app` — one that just prints `process.argv`, and on
`--mcp-serve` does a single `readline` round-trip over stdin/stdout. Sign and notarize it with the
real credentials (free, since the secrets already exist in CI) and confirm
`/Applications/Operator.app/Contents/MacOS/Operator --mcp-serve` behaves identically to the same
invocation under `electron-vite dev`. Half a day of work; run it in parallel with S0, or even
before S1 starts — it de-risks the single most silent failure mode in this whole plan for the price
of a throwaway build.

**Second-riskiest, not a probe candidate but worth flagging early**: `worktree.rs`'s scope gap.
2,665 current Rust LOC against a 255-LOC pre-Tauri ancestor means most of today's worktree logic
(reap-dry-run, APFS clonefile handling, richer status) has **no revivable code**, only a pattern to
follow — reading Orca's `worktree-logic.ts`/`worktree-apfs-clone.ts`/`worktree-removal-safety.ts`
first (reference-only, no license notice needed) is cheaper than re-deriving the same edge cases
(unicode/emoji branch names, path-traversal-safe reap) from scratch.
