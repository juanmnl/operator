# RESULT — collapsing the sidebar stranded Settings, theme and the UPDATE button

Base: `main` @ `ce86232`. **The worktree I was handed was on `a023972`, four commits behind** — including
`63ace34`, the very commit the brief cites as the precedent for how the rail's foot gets decided. On that
older tree `SidebarRail`'s foot was still the duplicate `+` (`onNewSession`), not `onOpenTeam`, so the brief's
description of the code read as wrong until I fast-forwarded. The brief's first line was load-bearing.

## The defect is bigger than the report, and the extra half is the worse half

`availableUpdate` (`DashboardView.tsx:2459`) had **exactly one consumer in the app**: `Sidebar`'s `update`
prop. And `Sidebar` renders only when `contentMode !== 'gallery' && !sidebarCollapsed`. So the footer was
missing in **two** states:

1. **Sidebar collapsed** — what the user reported.
2. **The gallery — for everyone, collapsed or not.** The collapsible wrapper is `width: 0` and renders
   `null` there.

(2) is the one nobody had noticed. The gallery is the launcher, project home, and the **first-launch screen**:
the single screen a new user lands on had no preferences, no theme, no version, and no way to install an
update. The stranded-update argument in the brief is therefore stronger than stated — it wasn't only a
collapsed-sidebar user who couldn't see a new version, it was anyone sitting at the launcher.

The ⌘K back door is thinner than assumed too: the palette has `check-update` (`:2889`) but **no install
entry**. `runUpdateCheck` raises a toast carrying "Install & Restart", but a toast is transient — once it
goes, the only persistent installer was the button that wasn't rendered.

## What I chose: the ProjectRail's foot, not the SidebarRail's

The codebase had already written the rule, at `ProjectRail.tsx:256-263`:

> *"All three belong here: the rail is the only strip present in every state, including the gallery where the
> sidebar is gone."*

That was the argument for moving Agents and Open-folder out of the sidebar footer. It applies verbatim to the
app's own settings, and it was the one case still outstanding. Putting these in `SidebarRail`'s foot would
have fixed the report and left the gallery hole open — and would have been a second copy to keep in step.

**Shape.** One new `RailFootButton` (gear, `data-rail-app`), below a second seam so the foot reads 2 · 2 · 1
(cross-project views · navigation · the app) instead of as six items in a column. It opens the shared
`CardMenu`:

```
Operator v0.13.1          ← the title; the version was also footer-only
Install update 0.13.2     ← only when one exists, and it leads
──────────────────────
Operator preferences
Global Claude files
Switch to light/dark mode
```

An accent **pip** rides the gear whenever an update is pending — the brief's "visible where it exists, not
merely reachable". It is static, not a `StatusWave`: motion in this app means running/compacting only.

**Scope split, confirmed with the user before building:** the app's verbs *moved* rather than being copied.
Adding a gear to the rail while leaving the sidebar's gear in place would have put two gears ~44px apart —
the exact thing this corner has twice been cleaned up to avoid ("two identical + buttons 44px apart is how
you get one that nobody trusts"). The sidebar footer keeps the one control that is **scoped to the project**
(`.claude` files) plus the version string, which is identity rather than a verb and costs no icon.

## What I rejected

- **Five icons stacked in the 64px `SidebarRail`** — parity, not access, and explicitly ruled out.
- **Overloading `onOpenTeam` or `onExpand`** — two verbs never share a glyph.
- **A `⋯` overflow** — the gear is the glyph the user already reads as settings, and moving a control should
  not also redraw it. (`⋯` was free — the rail tile's menu is right-click-only — but that's not a reason.)
- **Gear opens PrefsView directly, everything folded inside** — offered as an option; it makes the theme
  toggle two clicks from every screen and needs a new home for the update inside Prefs.
- **Duplicating instead of moving** — see above.

## Verified

`npm run build` (tsc + vite) passes. `npx vitest run` — **46 files, 515 tests, all pass**.

New driver **`dev/drive-app-menu.mjs`** — 21 assertions, all pass:

| what | result |
|---|---|
| gear exists at **gallery**, **expanded**, **collapsed** | ok (this is the access fix) |
| menu carries prefs · global Claude files · theme, and names the version | ok |
| theme actually toggles from the collapsed state (body bg changes) | ok |
| **expanded: the app verbs exist once, not twice** (`prefs 0, globals 0, theme 0, settings 1`) | ok |
| project-scoped `.claude` control stays in the sidebar | ok |
| update pending → pip at gallery **and** collapsed | ok |
| pip stays inside the button box (cannot move the strip's centre line) | ok |
| menu **leads** with `Install update 0.13.2` | ok |
| no update → no pip, no Install item | ok |
| gear legible ≥3:1 and `opacity: 1` in **all six palettes** | ok — worst 4.16 (`mr-pink-light`) |
| pip paints a real accent in all six | ok |

**Revert test, as the standing practice requires:** setting `onOpenAppMenu={undefined}` makes the driver fail
its first three assertions (`FAIL GALLERY/EXPANDED/COLLAPSED: the gear exists → null`) and then abort.
Restored and rebuilt after.

**Existing drivers re-run, all clean:** `drive-corner-balance` (**baseline delta 0px** — the gear's ink lands
on cy 869, the same line as the sidebar arm; all 5 rail buttons 26×26 r7, all `opacity: 1`),
`drive-rail-invariant` (CLEAN, worst |Δaxis| 0.75px), `drive-rail-team`, `drive-rail-tiles`,
`drive-project-rail`.

**Screenshots eyeballed** at the bottom-left corner in expanded / collapsed / gallery / menu-open, in
Mission Control dark + light and Mr Pink light.

## Two driver-honesty notes

Both are cases where a test would have passed on a lie, per the brief's instruction to fix drivers honestly
rather than around them:

1. **`dev/drive-corner-balance.mjs`** — its `railFootSel` listed four `data-rail-*` hooks while `c.rail` now
   enumerates five, so the probe ran off the end and printed `answers hover: undefined` for the new control
   rather than failing. Added `[data-rail-app]` to the selector; it now reports `true` like its neighbours.
2. **`dev/mock-bridge.ts`** — `checkUpdate` was hardcoded `async () => null`, so the pending-update half of
   this feature was **unreachable in the harness**. It now reads `localStorage['mock.update']` and returns
   `{ version }` or `null`, matching the real bridge's shape. A fixture that can only return null would have
   validated exactly half of what I built.

Also worth recording: `CardMenu`'s rows are `role="menuitem"`, not `role="button"` — `getByRole('button')`
times out on them. And a loose "fixed panel containing 'Operator'" selector matches the **update toast**
("Install and restart Operator."), which is why my first pass mis-read the menu on the one run that mattered.

## Files

- `src/renderer/components/sidebar/ProjectRail.tsx` — `onOpenAppMenu` / `appMenuOpen` / `appMenuActive` /
  `updatePending`; second seam + gear; `RailFootButton` gains `viewBox`, `pip`, and an event-carrying `onClick`.
- `src/renderer/components/sidebar/Sidebar.tsx` — global prefs / gear / theme / update button removed; dead
  `isDark`, `globalPrefsActive`, `prefsViewActive`, `update`, `onInstallUpdate`, `onOpenPrefs`,
  `onOpenGlobalPrefs`, `onToggleTheme` props removed rather than left stale.
- `src/renderer/views/DashboardView.tsx` — `appMenu` anchor state, the `CardMenu`, both call sites rewired.
- `dev/drive-app-menu.mjs` (new), `dev/drive-corner-balance.mjs`, `dev/mock-bridge.ts`.

## Not done

The **⌘K palette still has no "Install update" entry** — only "Check for updates". I left it alone as out of
scope, but it is the same gap one layer down and is a two-line addition if wanted.
