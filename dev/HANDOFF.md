# Handoff — 2026-08-16

**`main` = `cc3de74`, NOT pushed** — `origin/main` is still `2121b7a`. `npm test` 775 / 61 files ·
`cargo test` 173 · `tsc --noEmit` clean, all run against the merged tree.

**`v0.15.2` IS tagged and pushed** (`3f774a7` → `2121b7a`), correcting the previous handoff and the
memory index, which both said "untagged". So the 6 unpushed commits are **post-release** work, and
shipping them needs a **version bump**, not just a tag. The five files carrying the version:
`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
`src-tauri/tauri.conf.json` — note **`package-lock.json` is stale at `0.15.1`**, missed by the
v0.15.2 bump; a new bump should correct it.

Working tree is dirty with **the user's own two changes**, not this session's: `.claude/settings.json`
staged for deletion, `.gitignore` modified to ignore `.claude`. They were stashed and restored around
the merges; leave them alone.

## ⚠ The one thing to do before anything else

**Two fixes were merged to `main` without ever being exercised in a real window.** The user chose to
merge before verifying, deliberately and on the record. Every claim behind them is unit-level or
DOM-level. Three checks are outstanding, and one of them is a whole-app regression risk:

1. **Flick a screenshot in from Finder, releasing fast.** Does the window still navigate to
   `file://…`? This is the entire point of the drop guard.
2. **⌘C / ⌘V / ⌘A anywhere in the app.** The macOS menu bar was rebuilt to make ⌘Q interceptable.
   The Edit submenu is what gives the webview copy/paste. If this broke, it broke app-wide.
3. **⌘Q with a lane running.** The dialog should name the busy lanes.

None of this is testable from the Vite dev server — a browser page is not WKWebView with
`dragDropEnabled: false`, and the quit handling is Rust. Use `npm run tauri dev`.

## Verify before believing (including this file)

The last handoff's rule earned its keep again. **Three claims made confidently in this session were
wrong and had to be corrected mid-flight:**

- **"Tray → Quit is guarded."** False. `MenuBuilder::…quit()` (`lib.rs:2121`) is the same predefined
  `terminate:` item as ⌘Q. The tray is **not** guarded.
- **"Dock → Quit arrives as `ExitRequested`."** False — the design spec asserted it; reading
  `muda-0.19.2/src/platform_impl/macos/mod.rs:994` disproved it.
- **"Nothing iterates lanes that were live at last quit."** False — `workspace.ts` +
  `DashboardView.tsx:3486-3620` already do. The Design lane caught this and corrected the brief.

Pattern: **the wrong claims were all about behaviour nobody had read the source for.** The correct
ones came from the vendored crate cache, not the docs site.

## What shipped (2 merges, both user-visible, neither verified)

**`d708de9` — the drop guard.** A file dropped outside the app's own drop targets made WKWebView
navigate to `file:///…`, replacing the whole React app with the raw file — with no way back, because
the React app that owns every keybinding is gone. `installDropGuard()`
(`src/renderer/lib/drop-guard.ts`) installs `dragenter` + `dragover` + `drop` on `window` in the
bubble phase.

Two non-obvious constraints, both found by a failing test rather than by reasoning:
- **Scoped to `Files` + `text/uri-list`, never blanket.** The rail signals "I refuse this drag" by
  deliberately *not* cancelling `dragover` (`ProjectRail.tsx:1030`). A blanket cancel turns every
  refusal into an accept — `dev/drive-lane-reorder.mjs` R4/R5 fail exactly that way.
- **`dragenter` cancels but must NOT set `dropEffect = 'none'`.** No app drop target listens for
  `dragenter`; they all decide on `dragover`. Setting it there suppresses the `drop` event entirely,
  so an *intentional* screenshot flicked at the composer would silently vanish.

**`cc3de74` — the quit guardrail.** Closing the main window quit the app and killed every lane pty
with it. Rust owns both the veto and the count (`src-tauri/src/quit.rs`, `transcript.rs`'s `LiveLanes`)
**because the webview is gone in exactly the case that motivated the feature.** Frontend renders from
the emitted payload; a native `tauri-plugin-dialog` fallback fires if the webview doesn't ack in 400ms.
Triggers on **busy** (`running`/`compacting`/`waiting`), not merely alive.

**Guarded:** red traffic-light, ⌘Q, app menu Quit, ⌘W fall-through.
**NOT guarded, by decision:** Dock → Quit, tray → Quit, macOS logout/restart, Force Quit.

Three findings worth keeping:
- `Builder::menu` makes you owner of the **whole** menu bar, and a closure returning `Err` after it
  has begun mutating aborts `Builder::build` — i.e. a failed menu edit yields *no app at all*.
  `build_menu` edits `Menu::default`, touches only the first submenu, and never returns `Err` after
  its first mutation.
- muda 0.19.2 has **no alternate-item support**, so ⌥⌘Q is a plain visible row, not an ⌥-reveal.
  A deviation from the design spec, accepted.
- `prevent_exit()` already no-ops for `RESTART_EXIT_CODE` (`tauri-2.11.2/src/app.rs:86-94`), so the
  updater restart needs no special-casing.

## Open, in priority order

1. **The three GUI checks above.** Merged, unverified. Nothing else should ship on top.

2. **⚠ LIVE BUG — lane messaging dies after a long session, and the fleet goes idle.** User-reported,
   researched, **not fixed**. Full report: `~/.operator/briefs/OUT-delivery-brakes-stall.md`.
   It is `agent-delivery.ts`'s circuit breakers doing their job, plus one real design flaw:
   - **`inheritedHop` is one scalar per lane, shared across every conversation it is party to.** In
     hub-and-spoke, **6 messages spread across 4 unrelated lane pairs trip the same `HOP_LIMIT = 6`**
     that a single runaway pair needs 3 full round-trips to reach. Ordinary fleet traffic trips a
     brake built for two agents ping-ponging.
   - **Exhaustion spreads.** The check reads `exhausted[from]`; a block marks **both** ends. Once the
     hub is marked, its next reply to *any* lane — including one never involved — is blocked, and
     that block marks the fresh lane too.
   - **`exhausted` has no timer.** `resetChainFor` has exactly three call sites, all human-UI.
     `handleHumanSend` fires for the lane whose chat the human is typing into — so **the coordinator
     self-heals through ordinary use, and worker lanes have no comparable net.**
   - **It is nearly invisible.** A 3.5s `kind:'info'` toast with no action button (`Toast.tsx:244`,
     `AUTO_DISMISS_MS = 3500`), and `TaskBoard.tsx:47` **deliberately** excludes brake outcomes. Only
     Team → Dispatches shows them. **Zero UI components read `exhausted`.**
   - "Tasks/goals stay idle" is downstream, not a second bug: dispatch is confirmed **unbraked**, and
     task closure runs off the worker's own phase. What stalls is the coordinator's *awareness* — it
     never hears the work finished, so it never dispatches the next thing. **"Goal" is not a
     data-model concept at all** — prose in the coordinator's seeded prompt only.
   - Immediate workarounds: **restart the app** (the state is a ref, deliberately not persisted), or
     **send the lane a task from the board**.

3. **Terminal ghosting — new live sighting, and the leading theory doesn't fit it.** Seen while
   scrolling (2026-08-14): **cell-level overprint** — two sentences interleaved glyph-by-glyph, a
   `1 new message` banner struck across body text. The `bgBufferRef` 512KB-cap theory predicts
   **loss**; this shows **double-write**, nothing missing. Research ruled out "scrolling corrupts
   scrollback" at the xterm 6.0.0 source level (writes are `ybase`-relative). Two candidates remain
   and one frame cannot separate them; the proposed repro is capture+replay checking the **buffer**,
   not the DOM. **The screenshot was unstashable** — the memory note is the only record.

4. **Resume-on-relaunch: designed, not built.** `~/.operator/briefs/OUT-resume-on-relaunch-design.md`.
   Corrects its own brief: workspace restore already exists. The record is written **while the lane
   lives**, and the *absence of cleanup* is the signal — the lockfile pattern, the only one that works
   on a path giving no notice. §1.2 documents the defect that breaks it on exactly those paths.
   This is what covers Dock quit, logout and Force Quit, which no guard can.

5. **Operator cannot raise an OS notification at all.** `src-tauri/Cargo.toml` has `opener`, `dialog`,
   `updater`, `process`, `window-state` — **no `tauri-plugin-notification`**. Operator already computes
   the hard half (`waiting` is a first-class phase); it just can't tell anyone. A local ping when a
   lane needs a human is small work on state that already exists.

6. **Renderer killed + respawned hourly at ~1.1–1.2 GB.** Untouched again.

## Direction — a second competitor, adjacent not overlapping

**`zeronsh/comet`** (zeron.sh) — *"Access your agents from any device."* Rust/GPUI, MIT, 399 stars,
560 commits, v0.2.1. Runs Claude Code, Codex, Grok, Hermes and Pi; pilot from phone or iPad. Hosts
Claude via **ACP** (not pty, not the SDK, not jsonl tailing — their own `ARCHITECTURE.md` is stale on
this) and syncs through a **Cloudflare relay, explicitly not P2P and not E2E encrypted**.
**Verdict: adjacent job, not a threat — zero multi-agent dispatch.** Orca remains the serious
competitor by an order of magnitude.

Worth naming: Zeron is the **third** close analogue to choose native GPU rendering over a webview
(with diri and this repo's own shelved alacritty spike). They don't pay the WKWebView tax — the hourly
renderer kill, the ghosting. That is not an argument to reopen a shelved decision, but three
independent teams landing on the same choice is a data point, not noise.

The market signal the user flagged the same day (Danny Postma, 2026-08-14): *"I write a spec, go to
the gym, and my phone only pings when an agent needs a decision."* **The primitive there is the ping,
not the remote control** — which is item 5 above, and Operator already does the hard half.

## Reference

Lane briefs and reports now live in **`~/.operator/briefs/`** — an absolute path outside the repo, so
every lane worktree can read them. This replaces the old `/tmp/operator-shots/` convention, which was
subject to reaping. `OUT-*.md` are lane outputs; the unprefixed files are the briefs they answer.

Best reports from this session: `OUT-delivery-brakes-stall.md` (the live bug, with a hand-executed
state trace), `OUT-quit-guardrail-research.md` (every quit path, verified against the vendored crate
source rather than the docs), and `OUT-review-drop-guard.md` (found the `dragenter` hole that the
original fix left open — very likely the actual path of the incident that started all this).
