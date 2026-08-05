# RESULT — the grid terminal is reachable again, behind an opt-in pref

Branch `operator/ac9328`. Build clean, `cargo check` clean, `npm test` **619 passed** (612 + 7 new).

---

## FIRST, because it changes the recommendation: why it was shelved IS recorded

The brief says research found no doc or memory recording that the grid was tried and failed. **Both
exist.** `git log --follow` returns exactly one creating commit for both files:

```
e9e02e3  2026-06-30  ghostty-web becomes THE terminal + scrollback, theming, session restore
e896c91  2026-08-03  The rescue CR submitted whatever the user was typing   (GridTerminalPane only,
                                                                             an unrelated sweep)
```

**The commit that CREATED `gridterm.rs` is the commit that shelved it.** It was born orphaned —
which is why `--follow` shows no later abandonment commit to find, and I think why the search for
one came up empty. Its body says, verbatim:

> Adopt ghostty-web (real Ghostty VT engine as WASM, Canvas-2D) as Operator's sole terminal. It
> renders Claude cleanly in WKWebView where xterm corrupted and **the DIY alacritty grid hit an
> endless edge-case tail**.
>
> - TerminalSurface always renders GhosttyTerminalPane […] removed the Standard/Grid renderer
>   toggle. **xterm + grid panes remain in-tree but unwired.**

And the memory `project_grid_terminal_spike` names the tail concretely — it was written while the
spike was live, and lists under **STILL MISSING**: image drag/paste, damage-based diffs (it
re-sends every row on every emit), and *"wide-char/emoji alignment drift (spacer cells skipped; DOM
assumes 1 char = 1 cell)"*.

### What that does and does not tell you

- **It is not a corruption defect.** Nothing records the grid reproducing the overprint/ghost class
  it was built to make structurally impossible. The recorded reason is a **parity long-tail** —
  features it lacked, not a way it broke.
- **It was a COMPARATIVE judgement, and its comparator is dead.** The grid was dropped in favour of
  ghostty-web, which is itself now abandoned (memory: *"ghostty-web — DEAD, notes calling it 'the
  one true surface' are WRONG"*). So the grid was shelved for a path that then failed, and that
  reasoning has expired rather than been confirmed.
- **The "endless edge-case tail" claim is undated as to depth.** It was written by whoever was
  adopting ghostty-web, in the sentence justifying the adoption. Treat it as a real signal about
  cost, not as a verdict about correctness.
- **A renderer toggle already existed and was deliberately removed** by that same commit (memory:
  PrefsView → *"Renderer: Standard / Grid (beta)"*, `localStorage 'operator.gridTerminal'`). This
  pass restores that capability under a new key. Flagged explicitly against the standing rule "do
  not reintroduce a renderer toggle without a soak test": the brief authorises it *as the mechanism
  for the soak test*, it defaults off, and it is **not** exposed in Preferences.

**My read: the shelving reason is real but stale, and it points at parity, not at safety.** The
wiring is worth having for the soak test. Do not read it as "the grid was never tried" — it was,
and it was found to cost more than the alternative that was chosen at the time.

---

## What was wired

The missing wire was exactly where the brief said. `terminal_spawn` has accepted `grid:
Option<bool>` since 2026-06-30 and **the bridge never passed it**, so it was always `None` and the
core was never created. The comment in `operator-bridge.ts` has described the behaviour the whole
time. The intent was written; the wire was not.

**1. The pref** — `src/renderer/lib/terminal-options.ts`

`getRendererMode(): 'xterm' | 'grid'` / `setRendererMode`, persisted at
`operator.terminal.renderer`, **default `xterm`**, any unrecognised value → `xterm`, a throwing
localStorage → `xterm`.

Plus `spawnTerminalMode(): { grid, tuiMode }` — the spawn decision as one pure function, because
the interesting half is a **coupling**, not two prefs: grid forces `tuiMode: 'fullscreen'` whatever
the tui pref says. Inline in the bridge that could only be asserted in a comment, which is what it
had been. As a function it is tested.

**2. Passed at spawn** — `src/operator-bridge.ts`

`grid` now goes in the payload, and `tuiMode` comes from `spawnTerminalMode()`. `termBg`/`termFg`
go too, and they were missing for the same reason: the core is created at spawn *specifically* so
it can answer Claude's OSC background query — which arrives in milliseconds, before the pane mounts
— and without them it would have answered with its built-in near-black whatever palette was up.

**3. The pane mounts, per session** — `src/renderer/views/DashboardView.tsx`

`t.grid ? <GridTerminalPane/> : <TerminalSurface/>` at the one render site. `TerminalSurface` is
untouched and remains the default and the fallback.

**The lifecycle was already complete inside the pane** — I verified each of the four the brief
names rather than re-implementing them: `gridtermAttach` on becoming active (:434, at a measured
size, pushing a fresh full frame), `gridtermResize` from its own ResizeObserver (:268),
`gridtermSetTheme` on a new `theme` (:446), `gridtermDetach` in the mount effect's cleanup (:424).
I added one thing: `data-grid-pane` on its root, because which pane is mounted **cannot** be told
from xterm's DOM — the grid's key encoder *is* a real xterm and paints an `.xterm-screen` of its
own, so a driver counting those finds one in grid mode too and passes on the wrong evidence.

**4. Per session, bound at spawn** — and the backend is the authority

`gridterm::has(id)` (new, 6 lines) → `TerminalInfo.grid` on `terminal_list`. The core is created at
spawn and never after, so its existence **is** the fact "this session is in grid mode", and it
survives a renderer reload — which is exactly when the frontend must decide again which pane to
mount. A freshly launched tab takes `grid` from the spawn result (the bridge echoes back what it
actually sent, rather than the view re-reading the pref a second time that a mid-flight change
could answer differently); a re-attached tab reads it off the pty. There is no second copy of this
fact to drift.

---

## How to turn it on

Deliberately console-only — not a Preferences row:

```js
localStorage.setItem('operator.terminal.renderer', 'grid')
```

then **start a new session**. It binds at spawn, so running sessions keep the renderer they were
launched with, and setting it back to `'xterm'` affects only sessions started afterwards.

---

## What was verified

`npm run build` clean · `cargo check` clean · `npm test` **619 passed / 53 files**.

**7 new unit cases** in `terminal-options.test.ts`: the default is xterm when unset, a corrupt
stored value is xterm, a throwing localStorage is xterm, round-trip, and the coupling — grid forces
fullscreen even when the tui pref says classic; turning grid off restores the pref (grid overrides
at spawn, it never writes the tui pref).

**New driver `dev/drive-gridterm-wire.mjs`** (`?grid=1` on the mock reports every lane as
grid-spawned). All pass:

```
ok  G1 pref OFF: no gridterm call of any kind — 0 made
ok  G1 pref OFF: the xterm pane is mounted and no grid pane exists (4 xterm panes, 0 grid)
ok  G2 pref ON: the GRID pane is mounted in place of the xterm one (4 grid, 0 xterm)
ok  G2 and no rows are painted — the mock emits no gridterm:update, by design (0 rows)
ok  G3 attach: fired on becoming active — [.., gridtermAttach, gridtermResize]
ok  G3 attach carries a measured grid, not a placeholder — 172×46 cols×rows
ok  G3 theme: set_theme fired on a theme change
ok  G3 resize: resize fired when the pane changed size
ok  G4: the pref flipped to xterm mid-session and the live pane did NOT change (4 grid, 0 xterm)
ok  G4: nothing detached the live grid core on a pref change
ok  G3 detach: detach fired when the pane unmounted — [gridtermDetach], 3 grid panes left
```

G1 is the assertion that matters most for a default install, and G2's grid panes come from the
**re-attach** path, so the reload case is what is being exercised there. Detach is driven through
the real control (expand the strip → hover the row → close → confirm); navigating away instead
would tear down the JS context without running React's cleanup and could not observe it at all.

### `tui:fullscreen` reaching the argv — confirmed, in two halves

The TS half is tested (`spawnTerminalMode()` returns `tuiMode: 'fullscreen'` when grid is on, with
the tui pref at `'default'`). The Rust half is by inspection, `lib.rs:702-710`:

```rust
let tui = match tui_mode.as_deref() { Some("fullscreen") => "fullscreen", _ => "default" };
vec!["claude", "--settings", format!(r#"{{"tui":"{tui}"}}"#), …]
```

so the spawned argv is `claude --settings {"tui":"fullscreen"}`. Not asserted by a test — the
mapping is inline in a ~200-line command and extracting it was more surgery than this pass wanted.

### "Pref off is byte-identical" — behaviourally yes, literally no

State it precisely: the **spawn payload gained three fields** (`grid: false`, `termBg`, `termFg`).
The **spawned process is identical** — `grid.unwrap_or(false)` treats `Some(false)` exactly as the
old `None`, and `term_bg`/`term_fg` are read *only* inside the `if grid` block (`lib.rs:661-662`,
grepped). G1 confirms it from the renderer side: zero gridterm calls, xterm pane mounted.

---

## What does NOT work / was NOT verified — read this before judging the grid

- **Nothing about the actual rendering was tested. No `gridterm:update` was ever emitted.** The
  mock deliberately fakes no snapshot stream: those come from the alacritty core in Rust, and a
  fake would paint text and let this report claim "the grid renders" when none of the renderer had
  run. **Painting, typing, scrollback, selection, copy and click-to-open-URL are all UNVERIFIED.**
- **The grid has never been run against a real pty by me.** GUI verification of the real Tauri app
  is yours. Everything above is the wiring; whether the thing on the other end of the wire is any
  good is precisely what the soak test is for.
- **Do not read a short clean run as success.** The corruption class this path targets appears
  under sustained output over hours. That false negative is what burned July.

### Two things I found in the code and did NOT fix (per the brief)

1. **Wide characters lose a column.** `gridterm.rs:248` drops every `WIDE_CHAR_SPACER` cell from
   the snapshot, so a row containing an emoji or CJK glyph yields a string **shorter than the
   terminal's column count**. Visual alignment then depends on the font advancing that glyph by
   exactly two cells, and anything treating a string index as a column — selection slicing by col,
   `findUrlAtColumn` — is off by one per preceding wide char. This is the memory's recorded
   "wide-char/emoji alignment drift", confirmed still present. **Watch it first in a soak test**:
   this app's terminal is full of double-width ornaments, and the xterm path has a whole width
   audit (`verify:width`) built for exactly that hazard. The grid has no equivalent.
2. **Every emit re-sends every row.** No damage tracking (`gridterm.rs` builds the full snapshot
   each time, throttled ~16ms). Fine at a glance, and the first thing I would measure under load.

### One behavioural difference worth knowing

`reflow` only resizes when the pane is active (`GridTerminalPane.tsx:268`), so a **background**
lane's pty keeps its last size until you switch to it — the activation attach then resizes it. It
self-heals, but a background lane's app is briefly laid out at another pane's width. The xterm path
fits every pane instead. Not changed; the never-unmount/never-resize rules around this area are
load-bearing and the brief said not to touch the renderer.

---

## Files changed

| File | What |
|---|---|
| `src/renderer/lib/terminal-options.ts` | `getRendererMode`/`setRendererMode`/`spawnTerminalMode` |
| `src/renderer/lib/terminal-options.test.ts` | +7 cases |
| `src/operator-bridge.ts` | sends `grid`, `termBg`, `termFg`; `tuiMode` from the policy; echoes `grid` back |
| `src/renderer/views/DashboardView.tsx` | `TerminalTab.grid`; set at both spawn sites + re-attach; mounts the right pane |
| `src/renderer/components/terminal/GridTerminalPane.tsx` | `data-grid-pane` hook only — no behaviour |
| `src/shared/types.ts`, `src/renderer/env.d.ts` | `ManagedTerminal.grid`, `terminalSpawn` returns `grid` |
| `src-tauri/src/gridterm.rs` | `pub fn has()` |
| `src-tauri/src/lib.rs` | `TerminalInfo.grid` |
| `dev/mock-bridge.ts` | `?grid=1` fixture (emits no snapshots, on purpose) |
| `dev/drive-gridterm-wire.mjs` | new driver |

`TerminalSurface` and `TerminalPane` are untouched.
