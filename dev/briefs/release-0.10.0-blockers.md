# Release blockers — v0.10.0

**Decision: publishing soon.** This is the must-fix list, ordered. Everything not on it is a
follow-up and does not block. Sources: `dev/review-todays-landings.md`,
`dev/review-working-tree.md`, `dev/qa-chat-regression.md`.

**Version: 0.10.0**, not 0.9.2 — this release contains project-first navigation, the settings
template, a rebuilt chat view, task-lifecycle reconciliation and dispatch hardening. That is a
minor, not a patch.

## Must fix before tagging

Ordered by user-visibility, because that is what a release is judged on.

1. **`last_tool_name` is never cleared → the chat status line reports a stale verb.**
   *(`review-todays-landings` P1.)* This is directly visible on the surface the user just asked for
   and liked. A signal that lies about what the agent is doing is worse than no signal.
2. **Restore the renderer-side injected-turn guard.** `dev/briefs/injected-turns-history-regression.md`
   — **188 rows across 32 sessions** already in `chat.db`. The Rust fix stops new junk; every
   pre-existing session still renders `<local-command-caveat>` as a YOU turn. This is the exact
   screenshot the user reported and it will still be there on day one after upgrading.
3. **Hover cards stick on screen.** `dev/briefs/hover-card-stuck.md` — user-reported, twice, and
   still untouched. Review §7 confirms `SidebarRail` carries the same card with none of the
   hardening. Fix both, one shared implementation.
4. **`NARRATION_CAP` is 80 and tool calls now share it with prose.** *(P1.)* Decide and fix: a
   tool-heavy turn can now evict the prose the user actually wants to read. Whatever is chosen, say
   why in the code.
5. **Prev-review §3 — the project switcher can't be closed from its own header.** Small, visible,
   belongs in the project-first-navigation commit.
6. **Prev-review §4 — `galleryTab` never resets**, so "All projects" can land on a page with no
   projects. Same commit.
7. **The two tool-pipeline P1s** — output captured, capped, given a DB column and *never persisted*;
   and a third of real results stored as raw JSON rather than text. Not user-visible today because
   nothing renders tool output, but Review is right that they are cheap now and expensive once a UI
   depends on them. Add the `t.pending` assertion so the persistence path is actually covered.

8. **The project page's header sits 84px down.** `DashboardView.tsx:2169` renders a 40px
   `DragRegion` spacer for every `contentMode` except `localTerminal` and `gallery` — but
   `ProjectView` owns its *own* 44px drag strip (`ProjectView.tsx:46`), so `project` double-counts.
   Add `contentMode !== 'project'` to that condition. Verified that `PageShell`, `AgentsHubView`,
   `PrefsView` and `FolderPreferencesView` have no `DragRegion` and still need the spacer, so
   nothing else moves. User-reported; the project page is a landing surface.
   *(Why it hid: it presents as extra whitespace, which reads as a design choice, and every other
   page looks correct. A screenshot diff against the session view is what exposed it.)*

9. **The splash can hang forever, and its safety net cannot fire.** `App.tsx:19-27` schedules both
   the reveal and its 3000ms `safety` fallback **inside a `useEffect`**. If `DashboardView` (or
   anything it imports) throws during render, `App` never mounts, the effect never runs, the timer
   is never scheduled, and `app_ready` is never invoked — the main window stays hidden behind the
   splash indefinitely, with nothing on screen explaining why. The fallback is inside the thing it
   is meant to protect.
   Fix: move the guarantee somewhere a render failure cannot reach — a timer started before React
   mounts (in `tauri-main.tsx`), a backend-side timeout that reveals the window regardless, or an
   error boundary that reveals and shows the error. Prefer belt *and* braces here: a user who cannot
   open a terminal has no way to diagnose a blank splash.
   *(Surfaced 2026-07-28 when dev hung on the splash. That instance had a mundane cause — a
   six-day-old `vite --port 1420 --strictPort --host 127.0.0.1` (PID 4975) squatting `devUrl`, so
   `beforeDevCommand` could not bind and the app loaded a stale server; note it bound IPv4-only with
   nothing on `::1`, the known IPv4/IPv6 trap. But the reason it presented as an unexplained hang
   rather than an error is the design flaw above, and that ships.)*

## Explicitly NOT blocking

The structured-transcript UI, the DOM-overlay/selection decision, per-project env vars, roster
on-demand, `completeTerminalTasks` mis-attribution (P2), and the P3 list. Ship what is finished.

## Then, the release itself

Follow `project_release_process` exactly — it is a **5-file version bump**: `package.json`,
`package-lock.json` (**two** places), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the
`operator` block in `Cargo.lock`. Then tag `v0.10.0`; CI signs, notarizes and publishes to
`operator-releases`.

- **NEVER regenerate the updater key** (`~/.operator/updater-private.key` / CI secret
  `TAURI_SIGNING_PRIVATE_KEY`).
- **Apple-403 gotcha:** if signing fails with 403, the Account Holder re-accepts the Developer
  Program License Agreement, then `gh run rerun <id>` — **do not cut a new tag**.

## Commit shape

Land as the five commits from `dev/review-working-tree.md` (submit-queue → task lifecycle →
project-first navigation → PageShell → toolbar/composer), plus a sixth for the chat/transcript work.
95 files and ~3000 insertions are uncommitted; do not collapse that into one commit — if this
release regresses something, the split is what makes it findable.

## Gate

`npm test` green, `tsc --noEmit` clean, and the theme pass at 0 below floor. QA's chat regression
(`dev/qa-chat-regression.md`) passed 19/19 against real data — re-run it after these fixes, not
before.
