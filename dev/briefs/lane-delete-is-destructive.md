# The ✕ on a live lane card DELETES the lane — no confirm, no undo

**Reported 2026-07-28, in the v0.10.0 build:** *"i launched research agent, then on the project i
closed the active agent, it disappeared everywhere, can't add it anymore."*

**Confirmed in durable state.** `~/.operator/projects.json` — the `operator` project's roster is now
`['operator', 'code', 'review', 'design', 'qa']`. **`research` is gone.** Every other project still
carries all six. The user's read was exactly right.

## What actually happened

`RoleCard`'s ✕ calls `onRemove` → `removeRoleFrom(project, id)` (`lib/roster.ts:253`), which:

- deletes the role from `roster`, and
- **unassigns every task that pointed at it** (`roleId → undefined`), dropping them into the
  unassigned backlog.

Three problems compound:

1. **It reads as "close", it means "delete".** The user closed what they thought was a running
   agent. It removed the lane's whole configuration — model, effort, accent, charter — permanently.
   On a **live** card, ✕ is overwhelmingly read as "close this session".
2. **No confirmation and no undo** for a destructive, persisted action. Compare the session close
   affordance, which has a click-again-to-confirm step (`SessionItem`, `confirmingClose`). The more
   destructive control has the weaker guard.
3. **The session keeps running, orphaned.** Removing the role does not stop its pty. The agent
   carries on with no lane in the roster to represent it.

## Why "can't add it anymore" followed

The add path is *mechanically* fine — `research` is in `rolePresets()`, it is not in `roles`, so
`availablePresets` re-offers it. The problem is **where that control lives**: `+ Add agent` is on the
roster board on Project Home, and getting back to Project Home from a session is the known
dead-end (`dev/briefs/back-to-project-view.md`). So the lane vanished from the sidebar, and the one
place to restore it was the screen the user could not reach.

Two separate defects that combine into "it's gone forever". Fixing either alone leaves a bad
experience.

## Fix

1. **Separate the two verbs on a live card.** Closing the session and deleting the lane are
   different actions with different consequences and must not share a glyph. The common one
   (stop/close the session) should be the obvious one; deleting the lane should be deliberate — the
   `⋯` menu, or the lane's own editor.
2. **Confirm before deleting a lane**, and say what is lost — the charter and pinned config, plus
   "N tasks will be unassigned" when the count is non-zero. At minimum match the click-again-to-
   confirm pattern the session close already uses.
3. **Decide what happens to a live session when its lane is deleted.** Orphaning it silently is the
   worst option. Either block deletion while live ("stop it first"), or delete the lane and close the
   session together, saying so.
4. **Restore path.** Even with the above, re-adding a lane should not require reaching Project Home
   — see the navigation brief. This is the second half of the bug.

## Fix the user's data too

The `operator` project is missing its `research` lane right now. Re-adding it from the preset
restores model/effort/accent/charter, but any tasks that were assigned to it are now `roleId:
undefined` in the backlog and will need reassigning.

## Verify

`dev/drive-roster.mjs`: deleting a lane requires a confirm; a live lane cannot be silently orphaned;
close-session and delete-lane are distinct controls; and a deleted preset lane can be re-added and
comes back with its charter intact. Add a unit test that `removeRoleFrom` is never reachable from a
single unguarded click.

## Release impact

**This shipped in v0.10.0** (tag pushed, build running at time of writing). It is a data-loss bug
reachable in one click on a primary surface. It does not corrupt anything unrecoverable — the preset
restores the lane — but it destroys user configuration and orphans a running agent. Strong candidate
for **0.10.1**, and worth telling users about if 0.10.0 is already live.
