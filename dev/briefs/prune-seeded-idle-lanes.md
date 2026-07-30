# Brief — existing projects are still prepopulated with never-launched seeded lanes

User, restating a request they already made once: **"the sidenav is not prepopulated with the
idle (unlaunched) agents."**

## What actually shipped, and what didn't

The on-demand roster change **landed for NEW projects only**. `DashboardView.tsx:589-594` now
creates projects with `roster: []`, and `Sidebar.tsx:380` has a real empty state. Good.

**Nothing ever cleaned up the projects that were already seeded.** Measured just now against
`~/.operator/projects.json` + `~/.operator/sessions.json` (durable state, not the UI):

```
19 projects, 33 session records
  operator           roster=6  ever-launched=6  never=0
  el-encanto         roster=6  ever-launched=6  never=0
  fastrack           roster=6  ever-launched=6  never=0
  uwazi_app          roster=6  ever-launched=6  never=0
  web27              roster=6  ever-launched=3  never=3
  Operator-landing   roster=6  ever-launched=1  never=5
  mantel-landing     roster=6  ever-launched=1  never=5
  Fastrack-landing   roster=6  ever-launched=0  never=6
  walter             roster=6  ever-launched=0  never=6
  visual language    roster=6  ever-launched=0  never=6
  Mise-landing       roster=6  ever-launched=0  never=6
  website-2025       roster=6  ever-launched=0  never=6
  mantel             roster=6  ever-launched=0  never=6
  (6 more projects already at roster=0)

TOTAL roster lanes = 78,  never-launched = 49
```

**Six projects carry a full 6-lane roster and have never launched a single agent.** That is the
untouched seed, verbatim, and it's what fills the sidenav and the Agents hub. The "76 idle lanes"
headline the user complained about in the Agents hub is this same data.

## The job

A one-time prune of the never-launched seeded lanes from already-existing projects, so the
on-demand behaviour is true of the whole store and not just of projects created after the fix.

**This deletes user-visible data, so the guard must be proportional.** Rules:

1. **Only prune a lane that is BOTH never-launched AND still identical to its preset.**
   Never-launched = no session record in `~/.operator/sessions.json` has that
   (`projectId`, `roleId`) pair. Unmodified = its `name`/`model`/`effort`/`accent`/`prompt`/
   `useWorktree` still match `rolePresets()` (`src/renderer/lib/roster.ts:167`) — a lane the user
   retuned is a lane they chose, even if they never launched it. Prune neither if either test fails.
2. **Never prune a lane with queued tasks.** Tasks carry `roleId`; a lane holding queued work is
   in use. Check `project.tasks`.
3. **Never prune a lane that is live right now.**
4. **Run once.** Flag it in localStorage the way the removed `operator.rosterDefaults.v2` top-up
   did. A trimmed roster must never regrow, and this migration must never re-run and eat lanes
   the user has since added.
5. **Undo.** Follow the existing forget-project pattern (`DashboardView.tsx:643-686`): capture a
   snapshot, show a toast with an `Undo` action that restores precisely the ids removed. Do not
   ship a silent bulk delete of 49 things.
6. Report the count in the toast — "Removed N unused lanes from M projects" — so the user sees
   what happened rather than noticing later that something is gone.

## Also fix while you're in there

`DashboardView.tsx:2187-2190` is a **stale comment** that now contradicts the code: it says
"new projects seed the full defaultRoster() at creation — see upsertProject", but upsertProject
creates `roster: []`. It also points at "RosterPanel's seed-if-absent", while
`RosterPanel.tsx:80-82` explicitly no longer seeds. Correct it — a comment that describes the
behaviour you just removed is how the seed comes back.

Check whether `defaultRoster()` (`roster.ts:183`) still has any live caller. If it doesn't, say
so in your result rather than deleting it unasked.

## Not in scope

- Do **not** change what the sidebar renders. Listing a project's idle lanes is deliberate —
  `Sidebar.tsx:16` ("its list is the project's TEAM ... whether or not it's live"). The complaint
  is that the team was auto-populated with agents the user never asked for, not that idle lanes
  are shown. Once the data is right, the sidenav is right.
- Do not touch `ProjectRail.tsx` or `AgentsHubView.tsx` — Design is actively working in both.

## Verify

- `npm test`, `npm run build` clean.
- **Acceptance is the durable state**: after the migration, re-run the count above against
  `~/.operator/projects.json` and paste the before/after table. The six 0-launch projects should
  come out at `roster=0`; `operator`/`el-encanto`/`fastrack`/`uwazi_app` should be untouched at 6.
- Restart the app and confirm nothing regrows and the migration doesn't re-run.
- Confirm Undo actually restores, including tasks and any per-lane settings.

## Output

Write `dev/briefs/prune-seeded-idle-lanes-RESULT.md`: the before/after count table, the exact
predicate you used, where the run-once flag lives, how Undo works, and anything you refused to
prune and why. Then one OPERATOR-REPLY line.
