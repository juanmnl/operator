# Brief — collapsing the sidebar strands Settings, theme and the UPDATE button

Base everything on `main` (`ce86232`), not on an older worktree.

## The report
User: *"when collapsed, i can't access settings, toggle, etc."*

## What's true today (verified on `main`)

The expanded `Sidebar` footer (`src/renderer/components/sidebar/Sidebar.tsx:~440-485`) carries five controls:

| control | prop |
|---|---|
| Folder/project prefs | `onOpenFolderPrefs` (`:449`) |
| Global prefs | `onOpenGlobalPrefs` (`:457`) |
| Prefs | `onOpenPrefs` (`:467`) |
| Theme toggle | `onToggleTheme` (`:478`) |
| App version + **Install update** | `version` / `update` / `onInstallUpdate` (`:70-74`) |

The collapsed `SidebarRail` (`src/renderer/components/sidebar/SidebarRail.tsx:75`) accepts **none of them**.
Its whole prop list is `project, sessions, projects, activeSessionId, customNames, shortcutIndices,
onSelectSession, onOpenTeam, onExpand, onShowGallery, accentOf, onPickAccent` — and `DashboardView`'s
`<SidebarRail>` call site passes exactly that set and nothing more. So the footer isn't restyled for the
64px rail, it simply **does not exist** there. Collapsing is a one-way door out of app configuration.

## Why this is worse than it looks

**The update button lives only in that footer.** A user who works with the sidebar collapsed has no surface
anywhere in the app that tells them a new version exists, let alone installs it. That is not hypothetical —
it just cost a real debugging round: the user was running a locally-built **v0.13.0** while the fix they were
chasing had already shipped in **v0.13.1**. A stranded update button is how a user ends up reporting a bug
that is already fixed.

Note also that ⌘K has a `toggle-sidebar` entry (`DashboardView.tsx:~2812`) — so the palette is technically a
back door to everything. It is not an answer: the user's complaint is that the controls are gone, and
"collapse the thing you deliberately collapsed" is not access.

## The call to make (yours — you own this surface)

The rail is 64px and already spends its bottom corner on `onOpenTeam` (recently changed from a duplicate `+`,
see the note at `SidebarRail.tsx:22` — read it, it's the precedent for how this corner gets decided, and it
argues the foot control must belong to the rail it sits in).

Constraints that are already settled and must not be re-litigated:
- Don't stack five icons vertically in a 64px rail just to reach parity — parity isn't the goal, *access* is.
- **Two verbs never share a glyph** (`feedback_two_verbs_one_glyph`): whatever you add must not overload
  `onOpenTeam` or `onExpand`.
- The update affordance must be *visible when an update exists*, not merely reachable. A pip/dot on a
  collapsed control is the kind of thing the rail already does for other state — look at how the tile pip
  works before inventing something.

Plausible shapes, none of them mandated: a single overflow/`⋯` foot control opening the existing `CardMenu`
(`components/CardMenu.tsx` — already extracted and reused, see the rail context-menu precedent) with the five
items; or a gear that opens Prefs directly with the rest folded into Prefs; or promoting the update to a
distinct badge and menu-ing the rest. Propose before you build — this is the bottom-left corner of every
screen.

## Guardrails
- Verify at both sidebar states in **all four themes**, and with `update` both null and present.
- `npm run build` (tsc) must pass. If a driver in `dev/` asserts on the collapsed rail's foot, update it
  honestly rather than around it.
- Standing practice: once it works, **revert your change and confirm the driver FAILS**, then restore.

## Output
`dev/briefs/collapsed-rail-strands-the-footer-RESULT.md` — what you chose and why, what you rejected, what
you verified and in which themes/states.
