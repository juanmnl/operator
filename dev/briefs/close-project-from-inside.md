# Brief — you cannot close a project from inside it

User: **"i still don't see a way of closing a project either."**

Close-a-project shipped and works. It is wired in **one** place: `ProjectGallery.tsx` — the card's
`⋯` menu (`:634`, via `onCloseProject` from `DashboardView:3401`). `grep` finds no other caller.

So closing the project you are currently in means: leave it → gallery → find its card → open a
menu. **The action exists exactly where you are not.**

That is my fault in the original brief: I wrote *"where the control lives is Design's call — put it
somewhere defensible, the gallery card's ⋯ menu is the obvious home"*, which was true for closing
*some other* project and never considered the one you are inside.

## What to build

**A way to close the current project, from inside it.**

Placement is yours, but it must satisfy: reachable without leaving the project, and obviously about
*this* project rather than about the session or the app.

Candidates, argue one:

- **The project identity in the sidebar** — its name and path already sit at the top of the
  sidebar, and that is the project's representation while you are inside it. A `⋯` there could
  carry Close, Shelve and the project's other verbs together.
- **The rail tile's context menu** — right-click already does something on session orbs
  (the accent picker); check what a project tile does today and whether it is free.
- **The shell header's right zone** — now defined as "chrome and config for the current view".
  Defensible, but check it does not crowd what is already there.

**Audit the project verbs while you are in there.** Close, Shelve, Forget, open folder prefs,
rename, edit description — some are only on the gallery card, some only elsewhere. Report which are
reachable from inside a project and which are not. The user has now hit this twice (Close, and
earlier the missing sidebar toggle); a scattered verb set is the pattern behind both.

## The guardrail that matters most here

⚠️ **Close and Forget must not be confusable.** Close is reversible housekeeping — it ends the
project's agents and shelves it, and its own toast says Undo restores the shelf, not the agents.
**Forget destroys** rosters, tasks and notes.

The recorded rule is *two verbs never share a glyph* — it exists because a `✕` on a live lane card
once meant DELETE LANE and cost real data. If you put Close in a menu that also contains Forget,
they need visible separation and different weight, and Forget keeps its confirm while Close does
not need one.

Do not add a bare `✕` anywhere for this.

## Constraints

- Reuse the existing `closeProject` handler. Do not write a second teardown path — it already ends
  live sessions by id through the per-lane path, then shelves, in that order.
- Reuse `PopMenu` if you need a menu; it is shared and now has a real dismissal contract.
- After closing the project you are inside, you must end up somewhere sensible — the gallery,
  presumably. Say what you chose; do not leave the app scoped to a project that is now shelved.
- No colour-changing border on a radiused element; no browser focus rings.

## Verify

- Close the current project from inside it, with agents running and with none.
- Confirm where you land afterwards, and that the scope is not left dangling.
- Confirm the gallery card's menu still works — this adds an entry point, it does not move one.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `a794840`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/close-project-from-inside-RESULT.md`: where you put it and why, the audit of which
project verbs are reachable from inside vs only from the gallery, how Close and Forget are kept
distinct, and where you land after closing. Then one OPERATOR-REPLY line.
