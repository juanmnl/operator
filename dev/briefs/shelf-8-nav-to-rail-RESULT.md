# RESULT — project navigation moves out of the sidebar

The sidebar header is identity only; the two project verbs live at the rail's foot. Screenshot:
`/tmp/operator-shots/nav-stripped.png`.

---

## `components/sidebar/Sidebar.tsx`

**Header row — identity only.** The `role="button"` switcher trigger is gone (no click handler,
no keydown, no `⌄` chevron, no open-state background) and so is the `LogoMark` → gallery button.
What's left is the project name, the path under it, and the `previous` chip. Tagged
`data-sidebar-project` / `data-sidebar-project-name` for the harnesses that used to key off
`data-switcher-trigger`.

The path line lost its `paddingLeft: 28`, which existed to clear the logo; it now aligns under
the name.

**`<ProjectSwitcher>` removed** from the tree, and with it the `switcherOpen` /
`onSwitcherOpenChange` props. That cascaded: `projects`, `activities`, `onShowGallery`,
`onOpenProject` and `onNewSession` were all props the sidebar held *only* to feed the switcher,
so the component's interface lost five entries and two imports (`ProjectSwitcher`, `LogoMark`,
plus the now-unused `ProjectActivity` type).

**Footer lost its `+`.** "Open another folder as a project" is project navigation, and it now
sits at the rail's foot — two identical `+` buttons 44px apart is how you get one nobody
trusts. With five icons instead of six the row has slack again, so I **restored the 2px of icon
padding** I'd tightened in the footer-fix purely to make room for the version. The version now
renders whole rather than ellipsised (`identityTruncated: false`).

## `components/sidebar/ProjectRail.tsx`

The foot gained **Open folder** beside **All projects**, both via a new `RailFootButton` —
icon-only at 44px, with the name and the chord in the title (`All projects (⌘⇧O)`,
`Open folder (⌘N)`), which is what the switcher popover's footer used to spell out.

## `views/DashboardView.tsx`

- Passes `onOpenFolder={handleNewSession}` to the rail; drops the five props the sidebar no
  longer takes.
- `switcherOpen` state removed.
- **⌘⇧P removed.** It existed only to open the popover. I did not repoint it at another
  surface — that would be inventing a binding you didn't ask for. ⌘⇧O still reaches the full
  gallery, and the rail switches between open projects in one click.

## Deleted

**`components/sidebar/ProjectSwitcher.tsx`** (192 lines). Nothing rendered it once the trigger
and the chord were gone. Same call as `otherActiveProjects` in shelf-7 — flagging it plainly
rather than burying it, since it's the second file this sequence has deleted outright.

---

## A pre-existing contrast defect this surfaced — fixed

The theme pass's step 3 used to open the switcher popover and probe *its* rows. With the
popover gone I repointed it at the header itself, and it immediately failed:

```
sidebar project name   mission-control-light 2.69   1984-light 2.22    ✗ (floor 4.5)
```

The project name is accent-inked while Project Home is the active view, and at 13px bare
`var(--accent)` is **under half the body floor** on two light palettes. It had simply never
been measured — the old probe pointed at the popover, not the header underneath it. Same defect
class as the ALSO ACTIVE collapsed tail in shelf-4, same fix:
`color-mix(in srgb, var(--accent) 55%, var(--fg))`, chosen from a computed table rather than
guessed. Now **4.98–13.74 across all six palettes**, hue intact.

## Harness changes

- **`dev/drive-navigation.mjs`** — steps 4/5/7 drove the popover. Step 4 now asserts the rail
  foot carries both controls *and* that the sidebar header has no interactive element left;
  step 5 leaves via `[data-rail-gallery]`; step 7 became "a rail tile switches project in
  place" (`operator → el-encanto`), then switches back so the later steps see the project they
  always did.
- **`dev/drive-roster.mjs`** — its two project switches went through switcher rows. Repointed
  via the gallery, because `uwazi_app` is idle and therefore has no rail tile (the rail shows
  what's *open*) — worth knowing as a behaviour change: **you cannot reach a quiet project from
  the rail, only from the gallery.**
- **`dev/drive-theme-pass.mjs`** — switcher probes replaced with `sidebar project name` and
  `sidebar version`.
- `dev/drive-sidebar-chip.mjs`, `dev/drive-project-rail.mjs` still read the scoped project name;
  both keyed off `[data-switcher-trigger] > span`, which resolves to the same element now that
  it's `[data-sidebar-project-name]` — I left their selectors pointing at the new attribute.

## Verification

- `npm test` — 268 passed / 34 files. `npm run build` — clean.
- `node dev/drive-navigation.mjs` — all 11 checkpoints; rail foot reports
  `["All projects","Open folder"]` and `sidebar header carries no navigation: true`.
- `node dev/drive-sidebar.mjs` — nothing overflows the 220px sidebar; footer checks pass and
  the version is no longer truncated.
- `node dev/drive-roster.mjs`, `drive-sidebar-chip.mjs`, `drive-project-rail.mjs`,
  `drive-gallery-cards.mjs`, `drive-layout-shift.mjs` — pass.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**.

## Two things to weigh

1. **A quiet project is now reachable only through the gallery.** The rail shows open projects
   (shelf-5's amended membership) and the switcher listed *all* of them with a filter. So the
   fastest path to a project with nothing running got one step longer: ⌘⇧O, then click. If that
   bites, the gallery's filter is where to invest, not a resurrected popover.
2. **⌘⇧P is now unbound.** Muscle memory will hit it for a while and get nothing. Repointing it
   at ⌘⇧O's gallery would be a one-liner if you want the chord to keep meaning "go to
   projects".
