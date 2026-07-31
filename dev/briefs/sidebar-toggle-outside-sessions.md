# Brief — no way to collapse the sidebar from the channel (or anywhere that isn't a session)

User: **"channel view doesn't have a way to collapse/expand the sidenav."**

## The gap, and it's wider than the channel

`onToggleSidebar` lives on **`SessionToolbar`** (`:70`, rendered at `:130`), and `SessionToolbar`
is drawn for the *session* content mode only. `channel` is its own `contentMode`
(`DashboardView.tsx:2769`), so in the channel there is no toggle at all — and once collapsed
elsewhere, no way back either.

**Check the other non-session modes before you design anything**: `agents`, `prefs`,
`globalPrefs`, `folderPrefs`, `gallery`. I expect several have the same hole. Report which do.

The existing rationale is recorded and was reasonable: the rail and the collapsed sidebar
deliberately do *not* carry their own copies, because "SessionToolbar's is the single persistent
one — it works in both states, so a second copy here was the same control twice." **That argument
only holds where SessionToolbar is rendered.** It isn't, in half the app.

## What I want

One way to collapse and expand the sidebar that is available **everywhere it makes sense**, without
ending up with four copies of the same button.

Options, argue one:

- **A keyboard chord, as the primary.** Global, mode-independent, nothing to place. Note the trap:
  a new chord must be added to `lib/key-routing`'s `isAppChord` or the terminal swallows it — that
  bit `⌘⇧O`/`⌘⇧P`. A chord alone may not be discoverable enough to be the *only* answer.
- **Put it in the channel header**, matching however SessionToolbar presents it. Solves the
  reported case; leaves the other modes if they share the hole.
- **Move it out of the content area entirely** — onto the rail's foot, or wherever is present in
  every state. The rail is explicitly the one surface that never goes away, which is an argument
  for it; the counter-argument is that the rail's foot is navigation and this is view chrome.

**⚠️ Coordinate with the two briefs already in flight on this exact header:**
`channel-header-alignment.md` (the channel header must stop moving relative to other views) and
`composer-proportions.md`. If your answer is "put a button in the channel header," it has to be the
same answer the alignment brief lands on. Say explicitly how the two fit together, or do them in
one pass.

## Constraints

- Do not add a second control that duplicates SessionToolbar's in the session view. One concept,
  one control per surface.
- The collapsed sidebar is the 64px `SidebarRail`; the persistent 44px `ProjectRail` is a different
  thing and is not what collapses. Don't conflate them.
- Whatever you add needs a visible keyboard focus state (no browser focus rings).
- If you add a chord, it must be shift-gated or otherwise safe, and registered in `isAppChord`.

## Verify

- Collapse and expand from the channel, and from every other mode you find has the hole.
- Confirm the session view still has exactly one toggle, not two.
- If a chord: confirm the terminal does not swallow it, in a live session.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `2269209`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/sidebar-toggle-outside-sessions-RESULT.md`: which modes had the hole, the mechanism you
chose and why, how it composes with the header-alignment work, and confirmation there's no
duplicate control. Then one OPERATOR-REPLY line.
