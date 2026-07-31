# A dev build always shows the dark dock icon — RESULT

**Status: built. `cargo test --lib` 125 passed (122 → 125) · `cargo check --release` clean ·
`tsc` clean · `npm run build` clean · 546 JS tests.**

## Mechanism, and where the override sits

**`cfg!(debug_assertions)`, not `tauri::is_dev()`.** It resolves at *compile* time, so a release
binary does not merely skip the override — it does not contain it. `main.rs` already keys its
`windows_subsystem` attribute off the same flag, so this is the crate's existing notion of "dev"
rather than a second one that could drift from it.

Two additions in `src-tauri/src/lib.rs`:

```rust
fn dock_variant<'a>(requested: &'a str, dev: bool) -> &'a str {
    if dev { "dark" } else { requested }
}
const fn is_dev_build() -> bool { cfg!(debug_assertions) }
```

**The override sits inside `apply_dock_icon`** — the single choke point both the `set_dock_icon`
command and the startup hook go through, so nothing can route around it:

```rust
let bytes: &[u8] = match dock_variant(variant, is_dev_build()) { … };
```

Doing it in `App.tsx` instead would have failed twice over: the renderer's own `setDockIcon` call
would override it a moment later, and it would depend on the very `localStorage` that is the
problem.

**`dev` is a parameter rather than a `cfg!` read inside the function**, deliberately: `cargo test`
only ever compiles in debug, so a release path expressed as a `cfg!` is a path no test can reach.
As a parameter, both branches are exercised.

**At startup**, in `.setup()`, a dev build claims the dark icon before the renderer's first paint,
so it never flashes the release icon on the way up:

```rust
#[cfg(target_os = "macos")]
if is_dev_build() {
    let _ = app.handle().run_on_main_thread(|| apply_dock_icon("dark"));
}
```

Release is deliberately untouched there — the renderer applies the stored preference exactly as it
always has, and a startup write would be a second opinion about what a release icon should be.

## Proof release behaviour is unchanged

```rust
#[test] fn a_release_build_is_unchanged() {
    assert_eq!(dock_variant("light", false), "light");
    assert_eq!(dock_variant("dark",  false), "dark");
    assert_eq!(dock_variant("",      false), "");          // the match's light fall-through
    assert_eq!(dock_variant("chartreuse", false), "chartreuse");
}
```

With `dev = false` the request passes through untouched, so the Prefs preference keeps working
bit-for-bit as before. The dev side is covered symmetrically (`light`, `dark`, `""` and an
unrecognised value all become `dark`), and a third test asserts `is_dev_build()` is wired to the
build profile rather than hardcoded.

`cargo check --release` compiles clean, so the release profile builds with the branch eliminated.

## What I did NOT run, and why

**I did not launch a dev build to look at the Dock — on purpose, and it is the same finding the
brief asked me to investigate.**

`npm run tauri dev` lands on a fresh port, which is a fresh `localStorage` origin, which means **no
one-shot migration flags** — so launching it would have run the seeded-lane prune against your real
`~/.operator/projects.json`. Verifying a dock icon is not worth mutating the live store, and doing
it would have been the exact hazard I was asked to characterise.

`npm run tauri build` I also skipped: it needs `TAURI_SIGNING_PRIVATE_KEY` exported and produces a
signed bundle, which is a release-pipeline action rather than a check. `cargo check --release` gives
the compile-side assurance; the behavioural assurance is the pass-through test above.

**So the one-glance confirmation is yours:** launch a dev build and look at the Dock. If you want
it safe, set both flags in that origin first — but see below, because that is exactly the thing
that needs its own brief.

## The one-shot migration hazard — REAL, and only half of it

`localStorage` is per-origin and every dev launch takes whatever port is free (1433, 1443, 1460…),
so a dev build starts with **every** `localStorage`-backed preference absent: theme, custom names,
recents, saved sessions, layout, sidebar-collapsed, `channelReadAt`, `activeProjectId` — and the
one-shot migration flags. The migrations then run **against the real durable store**, which is *not*
per-origin: `~/.operator/projects.json` and `role-defaults.json` are shared by every instance.

I tested both migrations by re-running them over already-migrated state:

| migration | flag | re-run on a fresh dev origin |
|---|---|---|
| `migrateSeededWorktreeDefaults` | `operator.worktreeSeedMigratedAt` | **harmless** — genuine no-op, returns the same object by reference |
| `pruneSeededIdleLanes` | `operator.seededLanePrunedAt` | **DESTRUCTIVE** |

```
LANE PRUNE re-run on a fresh dev origin:
  roster before : operator, code
  roster after  : operator
  lanes removed : 1   ← the hand-added lane is GONE
```

**The scenario is ordinary:** you add a lane with "+ Add agent" and haven't launched it yet. It is
stock (it *is* a copy of the preset) and it has no history, so the predicate cannot tell it from a
leftover seeded lane — which is precisely why the flag exists and is documented as correctness, not
optimisation. Open a dev build on a new port and that lane is deleted from your real store.

Only the coordinator survives, because of the floor added earlier today. Everything else is at risk.

**Mitigations that already exist, and why they are not enough:** the prune backs up `projects.json`
before writing, and raises an Undo toast — but the toast appears in the *dev* window, which is
exactly the window you are not watching, and it is per-run.

**Not fixed here, as instructed.** It wants its own brief. The obvious shapes, briefly: move the
flags into the durable store beside the data they guard (`~/.operator/`, where they belong, since
they are facts about the store and not about a browser origin); or make the prune's predicate
require positive evidence of seeding rather than absence of evidence of use. The first is smaller
and I would start there.

## The Prefs control

Left alone, as instructed. In a dev build it now has no visible effect.

**My view: it does not need a note.** A dev build is a developer's build, the icon being wrong-on-
purpose is the signal itself, and a conditional line of copy in Prefs would be UI that exists only
in a configuration users never ship. If it ever does confuse someone, the honest fix is a single
"dev build" affordance somewhere global — not a caveat bolted to this one control.
