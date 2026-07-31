# Brief — a dev build always shows the dark dock icon

User: **"dev should always have the dark icon."**

So you can tell a dev instance from the installed release at a glance in the Dock — which matters
here, because two or more instances run at once and they share `~/.operator`, so a screenshot
cannot tell you which window you were looking at.

## How it works today, and why dev never gets it

- `apply_dock_icon(variant)` (`src-tauri/src/lib.rs:1787`) picks between
  `icons/dock-dark.png` and `icons/dock-light.png`, both already bundled via `include_bytes!`.
- `set_dock_icon` is a Tauri command; AppKit needs the main thread, so it hops there.
- The renderer drives it: `App.tsx:11` reads `localStorage.getItem('operator.dockIcon')` and
  defaults to **light**. The comment already notes it must be re-applied on every launch, because
  the running app's icon is not the bundle's.

**Why it is always light in dev:** `localStorage` is **per origin**, and every dev launch has used
a different port (1433, 1443, 1460 as ports get taken). So a dev build is a fresh origin every
time, the key is absent, and it falls back to light. The Prefs setting can never reach it.

## What to build

**A dev build forces `dark`, regardless of the stored preference.**

Do it in **Rust**, not in the renderer: `cfg!(debug_assertions)` (or Tauri's dev flag — pick and
say which) makes it unconditional and immune to whatever the renderer asks for. Doing it only in
`App.tsx` would leave the renderer's own `setDockIcon` call able to override it, and would depend
on the very `localStorage` that is the problem.

- `set_dock_icon` should **ignore the requested variant in a dev build** and apply dark.
- Apply it at **startup** too, so the icon is right before the renderer's first paint rather than
  flipping a moment later.
- **Release builds are unchanged** — the preference still works exactly as now. That is the whole
  point: the override is a dev-only marker.

Leave the Prefs control alone. In a dev build it will have no visible effect, which is correct and
not worth a special-case UI — but say in your result whether you think that needs a note in Prefs.

## Worth recording either way

The per-origin `localStorage` finding matters beyond the icon: **every `localStorage`-backed
preference is invisible to a dev build on a new port** — theme, custom names, recents, saved
sessions, layout, the sidebar-collapsed state, the one-shot migration flags. That last one is the
interesting case: a one-shot migration keyed on `localStorage` will **re-run on every new dev
port**, which is exactly the guard the lane-prune and worktree-default migrations rely on.

Check whether that is a real hazard — a dev build on a fresh port re-running a one-shot migration
against the real `~/.operator` store — and report it. **Do not fix it here**; if it is real it
wants its own brief. It may already be harmless because the migrations are idempotent, but that
should be established rather than assumed.

## Verify

- Launch a dev build with no stored preference and confirm the Dock icon is dark.
- Set the preference to light in a dev build and confirm it **stays dark**.
- Confirm a release build still honours both settings — `npm run tauri build` if that is cheap,
  otherwise reason it out and say so.
- `cargo test --lib`, `npm run build` clean.

## Where to work

`main` is at `a794840`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/dev-dark-dock-icon-RESULT.md`: the mechanism you used, where the override sits, proof
release behaviour is unchanged, and your finding on the one-shot-migration hazard. Then one
OPERATOR-REPLY line.
