# Sidebar toggle outside sessions

Answers `dev/briefs/sidebar-toggle-outside-sessions.md`.

---

## The survey — which modes had the hole

Measured, by counting `[data-sidebar-toggle]` in each content mode:

```
mode           before   after   sidebar present?
session           1       1     yes   ← the only one that had it
channel           0       1     yes   ← the reported case
projectHome       0       1     yes
agents            0       0     yes   ← still open (page family)
prefs             0       0     yes   ← still open (page family)
globalPrefs       0       0     yes   ← same component as prefs
folderPrefs       0       0     yes   ← same component as prefs
gallery           0       0     NO — sidebar animates to width 0; nothing to collapse
```

Your expectation that several modes shared the hole was right: **six of eight**, of which seven
have a sidebar to collapse at all.

## The mechanism

**⌘B already existed and already worked.** It is bound in `DashboardView` (`e.key === 'b'` →
`toggleSidebar`) *and* registered in `lib/key-routing`'s `isAppChord`, so the terminal does not
swallow it. The chord was never the gap — **discoverability was**, and a chord alone was never
going to be the whole answer, as the brief anticipated.

So the change is a visible control, extracted rather than copied: **`components/SidebarToggle.tsx`**,
now rendered by all three toolbar headers. `SessionToolbar`'s inline button became the shared
component — so the session view keeps exactly one toggle, and it is the same one, not a lookalike.

**Rejected: moving it to the rail's foot.** It would cover every mode with one control, but the
brief's counter-argument holds — the rail's foot is *navigation* (all-projects, open-folder, the
agents hub) and this is *view chrome*. It would also mean removing the control from a place users
already know it, to solve a problem in places they don't yet look.

**Rejected: a new chord.** There is already one.

## How it composes with the header-alignment pass

Directly, and this is why the two belong together. That pass established the canonical toolbar
header as **44 tall / 16 inset** and moved `SessionToolbar` onto it, so `SessionToolbar`,
`ProjectChannel` and `ProjectView` now share one header box.

The toggle goes in the **same position in all three** — leading control, left cluster. So switching
between a session, the channel and Project Home now moves neither the header nor the toggle inside
it. Had the headers still differed by 8px vertically, adding the button to each would have produced
three buttons at three heights, which is worse than one button and two holes.

## What is still open, deliberately

The four `PageShell` views — agents, prefs, globalPrefs, folderPrefs — have no visible toggle.
⌘B works there. I did not add one because `PageShell` is the **page** family, not the toolbar
family, and `dev/settings-page-template.md` records that the two must not be flattened into one
thing: its header is a title over a measured column, with no control strip to put this in. Adding a
floating chrome button to a page header is a different design decision than reusing an existing
toolbar slot, and it deserves to be made deliberately rather than as a side effect of this fix.

If you want it there too, the honest options are a control strip in `PageShell` (which changes the
page family) or the rail's foot (which changes what the rail's foot means). Both are real; neither
is this brief.

## Verified

- **Collapse and expand from the channel**: `operator.sidebarCollapsed` goes `null → "1" → "0"`,
  driven entirely from the channel's own header.
- **Exactly one toggle per mode** — the session view has 1, not 2.
- The control has its own focus state (inset `box-shadow` ring, no browser focus ring), a hover ink
  change, and `aria-pressed` reflecting the state.
- `npm run build` clean. `npm test` **562/562**.
- The 44px `ProjectRail` is untouched — it is not what collapses; the 64px `SidebarRail` is.
