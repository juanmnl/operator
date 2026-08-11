# Handoff — 2026-08-11

**`main` = `a7f2a9c`, pushed, working tree clean.** `npm test` 731 / 59 files · `cargo test` 171 ·
`tsc --noEmit` clean. Version is still **0.15.1** (tag `v0.15.1`) — today's work is on `main` but
**unreleased**.

**The repo is now PUBLIC and MIT-licensed.** `github.com/juanmnl/operator`, description + 8 topics
set, `LICENSE` added, README rewritten for a cold reader. This was done to stop GitHub Actions
billing: `build.yml` runs on `macos-14` (10× multiplier) on **every push to `main`**, not just
`v*` tags. Public repos get unlimited minutes, so it is now free — but if it ever goes private
again, narrowing that trigger is the biggest single lever.

**✅ CI on `main` is GREEN** — [run 31462894084](https://github.com/juanmnl/operator/actions/runs/31462894084)
(the open-source push) completed **success**. The intervening `7a8d295` build had failed; that was
almost certainly the documented `actions/checkout@v4` infrastructure flake, and the green run
supersedes it. **`v0.15.2` is clear to tag** — bump the 5 version files, tag `vX.Y.Z`, CI signs and
notarizes.

## Verify before believing (including this file)

The previous handoff's own commit message said "unmerged on `operator/6e13d8`". **It was wrong** —
`e4fff9f` had already merged it, `git log main..operator/6e13d8` is 0 commits, and the branch tip
`c33df60` is in `main`. That false flag sat in the memory index for four days.

So: `git log main..<branch>` before believing any hand-off, this one included. As of writing,
`operator/63cc58`, `operator/ghost-fix` and `operator/rail-close` are **all 0 commits ahead** —
everything is in `main`.

## What shipped today (8 commits, one user-visible)

**`35de7b7` — the rail fix. This is the only user-visible change.** Closing a project now takes it
off the rail. Root cause was *not* `sessions.json` (which no activity rollup reads): `localSessions`
never read `TerminalTab.ended`, and since `get_active()` returns only `status == "active"` sessions,
an exited lane *disappears* from the tracked list and the projection synthesised `status: 'active'`
for it. Dead lanes counted as live forever, and `isOnRail` is literally the rail's membership rule.
`endedByBackend` had been polling `try_wait` and getting the right answer the whole time — nothing
read it. Second bug in the same path: the re-attach join fell back to `byId.get(t.id)`, and
`terminalId` is a per-run `AtomicU64` counter, so `t3` across runs are different sessions — that
stapled one project's saved row onto another project's live pty. Both rules now live in
`lib/session-reattach.ts` with 11 tests (6 fail against the old code).

**The worktree reaper — `6d7d558`, `4a2b913`, `0096329`. Ships INERT.** Dry-run only: `boot_sweep`
hardcodes `ReapMode::DryRun`, nothing outside tests passes `Execute`, `move_to_trash` is not wired
into `remove_worktree`, and `worktree_reap_dry_run` has no frontend caller. Current plan over the
real root: **0 reap · 4 needs-confirmation · 23 refuse · 34 keep**.

Two live defects were fixed on the path that *does* delete today: `remove_worktree` now runs the
guard rails **and both** nesting scans, refusing on `Nested` **or** `Unknown`, before it ever
reaches `git worktree remove --force`. Previously git failing to answer read as "nothing nested"
and went straight to `--force`, which deletes a nested worktree's files as untracked content.

**`c7acdaf` / `be1ea87` — `npm run verify:ghost` and the ghost probe.** First fullscreen terminal
coverage in the repo; every other fixture is `{"tui":"default"}`. The harness carries a self-check
that blanks 3 rows on purpose and **fails if they come back clean**.

## Open, in priority order

1. **Composer ghosting — REAL, UNDIAGNOSED, and the user's daily annoyance.** Every lane runs
   `tui=fullscreen`, whose whole justification is "alt-screen ⇒ structurally can't ghost". It
   ghosts anyway.
   **A research spike blamed pane hide/show (DOM-only) — that finding was RETRACTED.** Code
   reproduced the spike's exact signature from two harness bugs: `document.querySelectorAll` reads
   the *first* terminal on the page, and xterm's `RenderService` **pauses for a terminal outside
   the viewport** (`RenderService.ts:134`), so stacked panes render under different rules. One
   terminal per page ⇒ 0 mismatches across 9 scenarios × 2 fixtures. The recommended mitigation
   (drop the DOM row cache before `refresh()`) was **measured and not shipped**: `DomRenderer` has
   no row cache, and in stacked panes the "fix" *causes* 15 blanked rows.
   **Next step is a LIVE capture, and it needs the user.** Set `operator.terminal.ghostProbe='1'`,
   reload, hit **Ctrl+Alt+Shift+G** while the ghost is on screen. Buffer and DOM agree ⇒ it is the
   WKWebView compositor and the DOM theory is closed. They disagree ⇒ the harness is missing
   something real. Also watch for a DEC 2026 synchronized-output frame left open — `refreshRows`
   buffers and returns while that mode is set, and Claude Code wraps every redraw in one.
2. **Tag `v0.15.2`** once CI is confirmed green. One user-visible fix (the rail). Everything else
   inert. Or hold one cycle and ship the ghost fix with it.
3. **4 quarantined worktrees, 449 MB** — the `uwazi_2026-*` set, verdict `needs-confirmation`,
   no UI to resolve them. Deliberate: a **moved** repo is byte-identical to a deleted one, keeps a
   live back-reference, and `git worktree repair` fixes it in one command. The user confirmed by
   hand that this repo was genuinely deleted. The affordance that resolves these is `worktree
   repair` against a user-supplied path, not a filesystem search.
4. **Disk: 62 worktrees, 18 GB.** 12 merged-and-clean trees were reaped by hand today (6.1 GB).
   **Two of them — `uwazi_app-qa`, `web27-d2e050` — came back as 8 KB stubs** (`app/`,
   `node_modules/` recreated at 13:29), so something still running wrote through those paths.
   In-use detection needs to cover more than Claude sessions; a dev server holding a path is enough.
   The remaining bulk is **~35 merged-but-DIRTY** trees — residue from work that already landed.
   No safe automatic rule covers those; "dirty" is exactly where unsaved work hides.
5. **Agents cannot create tasks.** The MCP surface is only `operator__report` and
   `operator__task_status` (which *updates* an existing id). Tasks exist solely when the
   `OPERATOR-DISPATCH` parser calls `addRunning`/`addTask`. This is deliberate —
   `TaskBoard.tsx:59-62` records eight lane *status reports* from July that were filed as tasks,
   later assigned, and dispatched back as work, six of them already finished. If a lane should be
   able to file work, that is a new `operator__task_create`, designed against that failure.
   *(Investigated because the board looked empty. It was not broken: 377 tasks exist, all
   `done`/`abandoned`; Backlog/Running/Waiting were legitimately empty.)*
6. **Renderer killed + respawned hourly at ~1.1–1.2 GB** — the user calls it "the app restarts".
   Retention is NOT lane-scoped (~8 MB/lane freed). Untouched today.

## Direction — a competitor now exists

**`stablyai/orca`** (verified via `gh`): **41,436 stars, created 2026-03-17**, ≥100 contributors,
top author only 34% of commits, **multiple releases per day**, MIT. It already ships per-agent
worktrees, an embedded Chromium element inspector, diff annotations, a fleet view. It is
**Electron + `electron-vite` + React 19 + xterm.js** — the stack this repo deleted — and it ships
`@xterm/addon-webgl`, which this app refuted twice, purely because Chromium is not WKWebView.

**Fleet-of-agents-in-worktrees is not a defensible wedge.** Orca bet on breadth (20+ agents), which
forces lowest-common-denominator integration. Operator's bet is depth on one harness, and that is
the only defensible position. See `openchamber/openchamber` (8.1k stars, front-end for **OpenCode**,
66% single-author) — the structural analogue, and evidence the depth bet works.

**The concrete opportunity:** Claude Code **2.1.224+** ships a native cross-session bus —
`ListAgents` + `SendMessage`, backed by `~/.claude/sessions/<pid>.json` and per-pid Unix sockets at
`/tmp/cc-socks/<pid>.sock`. **Reachable from outside a Claude session**, so Operator's Rust backend
can use it directly; wire format captured (see `project_native_cross_session_messaging` memory).
It is the `operator__dispatch` that was held back — and something a 20-agent tool cannot lean on.
**Caveat: there is no application-level ack.** `"success":true` is a local transport signal, so
`delivery-confirm.ts` stays necessary. Do not claim "undelivered goes away".

## Reference

Reports from today's lanes are under `/tmp/operator-shots/` (`code-*.md`, `research-*.md`,
`review-*.md`) — that directory is a screenshot stash and may be reaped; copy anything worth keeping.
`review-reaper-phase1.md` in particular is the best adversarial review this project has produced.
