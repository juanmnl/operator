# Brief — right-click commands, consistently, on the things that have commands

User: **"add right-click commands on elements that could use them."**

## What exists today — five sites, three different meanings

```
SessionItem          right-click → accent picker
RosterPanel  (×2)    right-click → accent picker
ProjectGallery card  right-click → the ⋯ menu          ← the only one that behaves like a context menu
SidebarRail badge    right-click → navigates to the gallery   ← right-click as a NAVIGATION shortcut
```

Three meanings for one gesture. The `SidebarRail` one is the odd one out and probably wrong:
right-click should open a menu, not move you somewhere. Reconsider it.

`PopMenu` cannot serve as a context menu as-is — it is positioned `absolute` against its parent
(`left: 12, right: 12, bottom: calc(100% - 6px)`), i.e. anchored to a control, not to a cursor.
**Give it a cursor-anchored mode** rather than writing a second menu; it already has the dismissal
contract (`lib/use-dismiss`) that a context menu needs, and a second implementation is how an app
ends up with two menus that drift.

## The rule I want established first

**Right-click is an accelerator, never the only way to reach a command.** Anything in a context
menu must also be reachable by a visible control. Otherwise we ship features nobody can find —
which is exactly the bug the user has now hit twice: the sidebar toggle, and Close-a-project
existing only on a gallery card.

State that rule in the code, and audit against it: for each menu you add, name the visible path to
the same command. **If there isn't one, that's a finding** — report it rather than letting the
context menu paper over it.

## Where to add them

Yours to decide and prioritise, but these are the candidates, roughly by value:

- **Rail project tile** — the project's verbs while you're inside it: Close, Shelve, open folder,
  Forget. ⚠️ **This overlaps `dev/briefs/close-project-from-inside.md`**, which is also queued. Do
  them together or make one defer to the other; do not solve the same gap twice.
- **Sidebar lane row** — launch, close the session, rename, jump to its roster card. Note this row
  already right-clicks to the accent picker; decide whether the picker becomes a menu item or
  stays the gesture.
- **Channel message** — copy text, copy the brief path it mentions, approve/decline when held.
  There is already a hover copy action; the menu should agree with it.
- **Gallery card** — already correct. Use it as the reference behaviour.
- **Agents-hub card**, **task in the queue**, **moodboard image** — smaller, obvious ones.

Don't do all of them if some don't earn it. A menu with one item is worse than no menu.

## Constraints

- **Reuse `PopMenu`** with a cursor-anchored mode. One menu implementation.
- The dismissal contract must hold: outside pointer-down, Escape with focus returned, tab-out.
  Also handle **a second right-click elsewhere** — it should move the menu, not stack two.
- Keep it inside the window: a menu opened near the right or bottom edge must flip rather than
  clip.
- Destructive items (Forget, delete a lane) need visible separation and must not sit adjacent to
  reversible ones — the *two verbs never share a glyph* rule applies to menus too, and a `✕` in a
  menu once cost real data.
- Keyboard: a context menu is a focus trap while open, and every item needs a visible focus state
  (no browser focus rings).
- No colour-changing border on a radiused element.

## Verify

- Every menu: outside click, Escape, tab-out, second right-click elsewhere, near a window edge.
- For each command in each menu, the visible non-right-click path — as a table. That table is the
  deliverable as much as the menus.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs`.

## Where to work

`main` is at `ec16365`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/context-menus-RESULT.md`: the cursor-anchored `PopMenu` mode, which elements got menus
and which you rejected and why, the command→visible-path table, what you did about the
`SidebarRail` navigate-on-right-click oddity, and how this composes with close-project-from-inside.
Then one OPERATOR-REPLY line.
