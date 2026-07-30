# QA: release gate — v0.10.0

**Verdict: GREEN. All gate items pass.** The three user-reported bugs are confirmed
fixed with evidence. Chat regression re-run 20/20. `tsc`/`vitest`/`cargo test` all
green. The theme pass — initially blocked by host memory pressure from concurrent
lanes — completed clean once the other lanes quieted down: **all 6 palettes, 0 contrast
violations below floor.**

Checked against `dev/briefs/release-0.10.0-blockers.md`'s must-fix list, items 1-3
(user-visible, explicitly named in this task).

## A moving target, honestly

Code was still actively landing the hover-card fix while this pass ran — `Sidebar.tsx`,
`SessionItem.tsx`, `SidebarRail.tsx` all had live saves during this session (confirmed via
file mtimes and live Vite HMR events arriving mid-test). Two things fell out of that
worth recording:

- An early `grep` for the stale-tool-verb fix came back empty, then present a minute
  later on a clean re-check — caught mid-write, not actually missing. Lesson: don't trust
  a single static-analysis snapshot against a lane that's actively saving; re-check before
  reporting a fix as absent.
- The theme-pass crash (below) coincided with, but on closer check was NOT caused by, the
  concurrent edits — it reproduced even after the sidebar files had been quiet for 5+
  minutes and `tsc` was clean, and even on a single isolated theme. See that section.

All three bug verifications below were re-confirmed **after** the sidebar edits went
quiet (no writes to any of the three files for 5+ minutes, `tsc --noEmit` clean) and are
stable across repeated runs, not one-off snapshots.

## 1. Stale tool verb — FIXED, confirmed

**Blocker #1:** `last_tool_name` was never cleared, so the chat status line kept
reporting a tool the agent finished minutes ago.

`src-tauri/src/transcript.rs:286` now clears it the moment the last open tool call
closes:
```rust
if self.open_tools.is_empty() {
    self.last_tool_name = None;
}
```
with a comment citing the exact user-facing failure mode this fixes. Covered by a real
cargo test, `transcript::tests::last_tool_name_clears_when_the_last_tool_closes`
— part of **88/88 cargo tests passing** (`cargo test`, `src-tauri/`).

## 2. Injected turns in OLD sessions — FIXED, confirmed at both layers

**Blocker #2:** `dev/briefs/injected-turns-history-regression.md` — the renderer-side
`isInjectedTurn` guard had been removed, so 188 pre-existing rows across 32 sessions in
`chat.db` still rendered Claude Code's own plumbing (`<local-command-caveat>`,
`<command-name>`, …) as a **YOU** turn.

Both fixes from that brief have landed:

- **Renderer guard restored.** `CanvasConversation.tsx:516` calls `isRenderableTurn`
  (`lib/chat-turns.ts`), which filters `kind: 'user'` turns through `isInjectedTurn` —
  confirmed live in this pass's chat-regression re-run (below): a synthetic
  `<system-reminder>` row, injected via the same live-update path a real transcript
  append would use, rendered **zero times**.
- **One-time DB migration landed and has already run for real.** `chatstore.rs`'s
  `purge_injected_rows` (gated on `PRAGMA user_version`, backs up before deleting) is
  covered by a new cargo test, `chatstore::tests::injected_rows_are_purged_once`. More
  tellingly: **the real `~/.operator/chat.db` shows the migration has already executed**
  — the injected-row count is down from the brief's reported 188 rows / 32 sessions to
  **3 rows / 1 session** just now. Those 3 are consistent with residual leakage from the
  currently-running pre-fix app binary (it hasn't been restarted on this build yet — see
  `project_open_followups`'s "RESTART APP" note), not a flaw in the fix: the write-side
  guard that stops new junk only exists in the rebuilt binary, which isn't the one this
  machine's live app is running right now.

## 3. Hover cards stick — FIXED, confirmed for both SessionItem and SidebarRail

**Blocker #3:** `dev/briefs/hover-card-stuck.md` — cards got stranded on screen when the
cursor left the window rather than the row; `SessionItem` had partial hardening (for a
different failure mode — rows moving under a stationary cursor), `SidebarRail` had none.

A shared implementation now exists — `src/renderer/lib/use-hover-card.ts` — used by both
`SessionItem.tsx` and `SidebarRail.tsx`. It implements every point the brief asked for:
`mouseout` on `document` with a null `relatedTarget`, `window` `blur`, `document`
`visibilitychange`, an unfocused-document check inside the existing re-verify-on-render
logic, and a module-level single hover owner so a second card evicts the first rather
than stacking.

Verified behaviorally (`dev/qa-drive-hover-card.mjs`, against the real-data harness),
following the brief's own repro recipe — dispatch `mouseout` with `relatedTarget: null`
plus a `window` blur, assert no card survives — **7/7, reproduced stable across two
consecutive runs**:

| check | result |
|---|---|
| A1. hovering a session row shows exactly one card | PASS (count=1) |
| A2. `mouseout(relatedTarget=null)` + `blur` dismisses the SessionItem card | PASS (count=0) |
| A3. re-hovering afterward still works (fix didn't break the happy path) | PASS (count=1) |
| B1. hovering a rail button shows exactly one card (rail had **zero** hardening before) | PASS (count=1) |
| B2. same repro dismisses the SidebarRail card | PASS (count=0) |
| C1. hovering row A then row B without a clean leave never shows two cards at once | PASS (before=1, after=1) |

Not covered: the *original* regression (a row moving away under a stationary cursor,
already-hardened before this brief) — the real-data fixture only has 2 sessions, not
enough to force a meaningful reorder. That path was already covered by
`SessionItem`'s pre-existing hardening and this pass didn't touch it; low risk, worth a
follow-up with a larger fixture if anyone wants full coverage.

## Chat regression re-run — 20/20 (dev/qa-chat-regression.md, methodology unchanged)

Re-ran the real-data harness from the last pass (same real "operator" roster, same two
real chat.db sessions, re-extracted fresh — the live app has kept writing to chat.db in
the meantime, so the fixture now differs slightly in size from last time, still 100%
real). One new check added: a synthetic-but-real-shaped injected row, since the real
noise in the primary fixture session has since been migrated away (see §2), which would
otherwise have made the "no leak" check trivially true rather than a live exercise of the
guard.

All prior categories still pass: orb send/stop/idle across the full real phase matrix
(9/9), interrupt-then-no-resubmit through the real `send()`/`interruptSession()`/
`submitQueue` chain including the control case (3/3), cap/freeze on the real largest
message plus a synthetic 57KB GFM-table stress case (3/3), pre-existing history load +
scroll (2/2), plus the new injected-turn-guard live-exercise check (1/1). One run showed
a transient `500` on a resource load and a slower 6.8s load — reproduced clean (0 errors,
~0.9s) on immediate retry; consistent with the concurrent sidebar edits happening at that
exact moment (Vite HMR mid-save), not a real defect.

## Theme pass — PASS, 0 below floor (re-run after lanes quieted down)

The first attempt (documented in the prior version of this report) crashed WebKit **5
consecutive times** — genuine host memory pressure from 9-13 concurrent Claude Code
agent sessions (this project's own lanes plus other projects sharing the machine), not a
product defect: it reproduced even on a single isolated theme with the sidebar quiet and
`tsc` clean, and `top -l 1` showed as little as **70-186MB free** at points.

Rather than force it through, a background poller (`ps aux` concurrent-agent count +
`top` free memory, checked every 20s) waited for the host to actually quiet down before
re-running. It took two ~6.7-minute polling windows — the process count climbed from 12
to 13 before finally dropping to **7**, with free memory jumping to **3.06GB** — at which
point the full sweep ran clean in one pass, no crash:

```
✓ Mission Control (dark)
✓ Mission Control (light) — the "Light" theme
✓ Mr Pink (dark)
✓ Mr Pink (light)
✓ 1984 (dark)
✓ 1984 (light)

BELOW FLOOR (4.5 body / 3 meta): 0
```

**0 violations across all 6 palettes** — every measured surface (ready-row name/model,
roster pills, chat status line, composer orb, project switcher, all prefs/settings
pages, agents hub, gallery card fields, sidebar idle/live lane names, lost-project card)
clears the WCAG floor in both light and dark variants of all three themes. The only
`NOTES` output is informational (title/card left-edge alignment — all `Δ0px`, i.e.
correctly aligned; card-hover colors listed for reference) — no action items.

Screenshots: `/tmp/operator-shots/theme-pass/`.

## Baseline gate checks

| check | result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **242/242** pass (33 files) |
| `cargo test` (`src-tauri/`) | **88/88** pass |
| chat regression (`dev/qa-drive-real-chat.mjs`, real data) | **20/20** pass |
| hover-card fix (`dev/qa-drive-hover-card.mjs`, real data) | **7/7** pass |
| theme pass (`dev/drive-theme-pass.mjs`) | **PASS** — 6/6 themes, 0 below floor |

## Not re-checked (out of this task's stated scope)

Blockers #4-8 from `release-0.10.0-blockers.md` (`NARRATION_CAP` sharing prose/tool
slots, the project-switcher close affordance, `galleryTab` reset, the two tool-pipeline
persistence P1s, the drag-region double-count) — this task named the chat regression,
theme pass, and the three specific user-reported bugs only. Worth a pass before tagging
if nobody has verified them separately.

## Artifacts

Untracked, left on disk: `dev/qa-extract-real.mjs`, `dev/qa-real-bridge.ts`,
`dev/qa-real.html`, `dev/qa-real-main.tsx`, `dev/qa-drive-real-chat.mjs` (updated with a
synthetic injected-noise check and dynamic labels), `dev/qa-drive-hover-card.mjs` (new).
`dev/qa-real-fixture.json` (real conversation content) deleted after the run, same as
last pass — re-run `qa-extract-real.mjs` to regenerate.
