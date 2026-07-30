# There is no way back to Project Home from a session

**User, 2026-07-28:** *"going back to project view is difficult, that's why i missed the moodboard
access."*

This is the real cause of the earlier moodboard confusion. The moodboard is correctly
project-scoped and always was — it is simply **unreachable once you are in a session**, which is
where you spend all your time. A feature you cannot navigate to is indistinguishable from one that
does not exist.

## Why it is hard

1. **`contentMode` is derived, not set** (`DashboardView.tsx:1880-1894`). There is no
   "go to Project Home" action anywhere. Line 1889: any live `activeTerminalId` wins and yields
   `localTerminal`. Project Home appears **only as a side effect of unfocusing the session.**
2. **The one control that does it reads as something else.** The sidebar's project name is the
   affordance (`Sidebar.tsx:262` colours it accent when `projectHomeActive`), but it sits beside a
   `⌄` chevron and presents as a *project switcher*. Nothing says "this also takes you back".
3. **The obvious target is inert.** `SessionToolbar.tsx:163` renders `{projectName}` as a plain
   `<span>`. Clicking the project name in the header of the thing you are looking at — the first
   thing anyone tries — does nothing.
4. **The navigation is asymmetric.** Project Home has an explicit `‹` back control to the gallery
   (`ProjectView.tsx`). The session view has no equivalent back to the project. You can always go
   up one level *except* from the level you are usually on.

## What to fix

The minimum is **one obvious, labelled way back from a session to Project Home**, and it should be
where people look: the project name in the session toolbar is the natural candidate, and making that
inert span a control is nearly free.

Beyond that, decide the model and record it:

- Is the relationship **gallery → project → session**, a real hierarchy with consistent up-navigation
  at every level? If so, the session view is missing its rung and a breadcrumb is the honest
  expression of it.
- Should the sidebar project name keep doing double duty as switcher *and* home? Two behaviours on
  one control, one of them signalled by a chevron that means the other, is why this was missed.
- Is there a keyboard route? `⌘⇧O` clears scope to the gallery and `⌘⇧P` switches project, but there
  is no chord for "up to Project Home". If one is added it must go in `lib/key-routing`'s
  `isAppChord` or the terminal swallows it — see `project_project_first_navigation`.

## Weight

**This should block the release.** It is not a polish item: the moodboard and the roster board are
both behind this door, the user hit it and drew a wrong conclusion about how the app was built, and
the fix is small. Shipping project-first navigation whose project screen is hard to return to
undercuts the release's headline feature.

## Verify

`dev/drive-navigation.mjs`. Assert: from a focused session there is a visible control that lands on
Project Home; it is reachable without touching the sidebar (which may be collapsed to the rail —
check the rail case too); and it does not disturb `activeProjectId`. Theme-pass whatever is added.
