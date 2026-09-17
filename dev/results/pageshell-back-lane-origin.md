# The lane origin: a back control that works on the route people actually take

Branch `operator/ba0200`, on top of `348a38b`. `npm test` green (100 files, 1488 tests),
`tsc --noEmit` clean, `npm run build` clean. Not GUI-verified — that is the user's.
Touches three files: `lib/nav-origin.ts`, `lib/nav-origin.test.ts`, `views/DashboardView.tsx`.
`EnvironmentSection.tsx` and `FolderPreferencesView` are untouched in this round.

## The gap that is now closed

`describeOrigin` returned `null` for `contentMode === 'localTerminal'`, so opening a settings page
from the rail's foot while a lane was focused rendered no back control at all. That is the
commonest path in daily use, so the door-less room survived on exactly the route people take most.

## What a lane origin holds

```ts
export interface LaneOrigin { terminalId: string }
```

The terminal id and nothing else, carried on `NavOrigin.lane` alongside `mode: 'project'` — the
lane's project is still the scope to restore, and `contentMode` ranks a live lane above the
project home, so the lane wins on arrival. Presence of `lane` is what separates "the lane" from
"the project's home", the same way `folderPrefs` separates the two pages that both report
`mode: 'prefs'`.

**No session id and no name are recorded.** Both are resolved at the moment the control renders or
is pressed:

- **The name** comes from `sessionLabel` (`lib/session-label`) — the app's one label ladder: a user
  rename, then the lane it was launched on, then its own first prompt, then the model it runs. The
  same words the rail, the command palette and the Activity Dashboard use, built the same way
  `paletteActions` already builds them in this file. A rename made while the user sits in settings
  shows up on the control. Never a raw terminal id.
- **The session id** is resolved in `applyView` from `sessionsRef`, exactly as `handleOpenProject`
  already does (`?? \`local-${terminalId}\``). A recorded one could be replaced while the user is
  away.

The terminal id is a per-run counter that repeats every launch — the same reason
`SavedSession.terminalId` documents itself as stale after a restart. So the chain stays in memory
and stays capped at 8; a lane origin is a reason **not** to persist it, not a reason to.

## The existence guard

`backLanes` in DashboardView builds a one-element list for the lane the top of the chain names,
**filtered against `terminals`** — the same test `contentMode` uses to decide a lane is on screen,
so the control and the router cannot disagree about what exists. `originLabel` treats absence from
that list as "the lane is gone" and returns `null`; `pageBack` then returns `null` and **no control
renders**.

It never falls back to the lane's project. A control labelled with a lane's name has to land on
that lane or not be there at all — the same rule already applied to a forgotten project.

Three ways a lane stops existing, all handled by the one filter: it ends and its tab is closed, the
user closes it, or its worktree is reaped. (A lane that has *ended* but whose tab is still open is
still a place: `contentMode` still routes to it, the EndedOverlay is what you see, and returning
there is what the user asked for.)

There is a one-frame race left: the lane could vanish between the render that drew the control and
the press. `contentMode`'s own `terminals.some(...)` test is the backstop — a dead terminal id
falls through to the project home or the gallery rather than a blank screen. That behaviour is
pre-existing and unchanged.

## `applyView`, and the clear it must not undo

`applyView` hard-cleared `activeSessionId` and `activeTerminalId`. That is now conditional: when
the target names a lane it restores both, otherwise it still clears them. The clear is what stops a
stale terminal id pulling a `'project'` landing into `localTerminal`, and the `else` branch keeps
it for every other origin, including the launch plan's `ContinueTarget` (which never names a lane).

## The comment that was wrong

The note above `applyView` explained the bug as "`activeFolderPrefs` outranks every flag below in
`contentMode`". That invites the wrong reading, and the correction is right: in `contentMode`,
`activeFolderPrefs` is the **lowest** of the five page flags. The bug is real for the opposite
reason — `localTerminal`, `project` and `gallery` rank **below** it, so a stale `activeFolderPrefs`
pinned you to the settings page when `applyView` tried to send you to the gallery. The comment now
says that, and names the rung below it too. The fix itself was correct and is unchanged.

## Origins now covered

Everything in the previous result file, plus:

| Origin | Label | Restores |
|---|---|---|
| A focused lane | the lane's display name | that pty, its session, and its project scope |
| A lane in no project | the lane's display name | that pty, with no scope |

`originKey` for a lane is `lane:<terminalId>`, so two lanes of one project are two places, and
neither is `project:<id>`. A chain of lane A → a settings page → lane B is three places, not a
loop, and `pushOrigin`'s unwind still fires when you genuinely return to a page in the chain.

## Still not covered

- **Nothing is persisted.** A reload still starts with an empty chain and no control, by design
  (rule 5), and a lane origin makes persistence less attractive rather than more — terminal ids
  repeat across runs, so a restored chain would name last run's lane.
- **Going back does not leave a forward trail.** Popping an entry does not let you go forward
  again.
- **The one-frame race above**, bounded by `contentMode`'s own liveness test.
- **A lane with no session object and no role** labels as `Session` — the palette's existing
  fallback. It names a lane that really is open, so the control still lands where it says; it is
  just a thin name. Reachable only for a terminal whose session has not been observed yet.

## Tests

`src/renderer/lib/nav-origin.test.ts` — 31 tests (was 25). New:

- a focused lane is described, with its project scope and terminal id;
- a lane belonging to no project is described with `projectId: null`;
- `localTerminal` with no terminal id is null;
- a lane is labelled with its **display name**, from the caller's live list;
- a lane that is gone renders **no** control — absent from the list, a different lane in the list,
  and a live lane with a blank name are all `null`, and none of them falls back to the project;
- a project home is still labelled by its project, so the `lane` field is what changes the rule;
- two lanes of one project have different keys, and neither equals the project's key;
- a source guard: the back control's lane list must be filtered against `terminals` and named with
  `sessionLabel`, so a refactor that names a lane from a stale list or a second naming rule fails.

The chevron guard and `muted-opacity.guard.test.ts` both re-run green.
