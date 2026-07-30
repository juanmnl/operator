# Brief — there is no way to CLOSE a project, and Shelve pretends there is

User: **"still, no way of 'closing' a project."** They're right, and I traced why.

## What exists, and why none of it is closing

| action | what it does | why it isn't "close" |
|---|---|---|
| **All projects** (⌘⇧O, rail foot) | navigates to the gallery | you *left*; the project and every agent in it are untouched and still running |
| **Shelve** (`archiveProjects`, `DashboardView.tsx:710`) | writes `archivedAt` | **does not touch running sessions** |
| **Forget** (`forgetProject`, `:661`) | destructive removal + undo snapshot | that's deleting, not closing |
| per-lane **■** (`onCloseTerminal`) | ends ONE lane's session | no project-wide equivalent exists |

`grep` for a bulk/project-wide session close in `DashboardView.tsx` returns **nothing**. Closing a
project today means clicking ■ on each live lane by hand, then Shelve, and knowing to do it in
that order.

## The bug hiding inside this — Shelve lies when anything is live

`project-shelf.ts:22-24`:

```ts
export function isActiveProject(p: Project, activity?: ProjectActivity): boolean {
  return !p.archivedAt || (activity?.live ?? 0) > 0
}
```

A project with a live session is on the ACTIVE shelf **whatever `archivedAt` says** — and that
rule is correct on its own terms (the comment is right: a running agent must never hide inside a
collapsed section). But `archiveProjects` writes the flag, then pushes a toast reading:

> *"Shelved {name} — It moves to Previous."*

**When a lane is live, it does not move to Previous.** It stays exactly where it was. The user
gets a success toast, an Undo button, and no change. That's the shape of bug that teaches people
the control is broken. Fix the honesty here regardless of what else you build.

## The job

**1 · A real "Close project" action.** One verb: end this project's live sessions, then shelve it.
Data — roster, tasks, notes, worktrees — is untouched and it comes straight back when you launch
into it again (the existing shelve toast already promises exactly that).

- Reuse the per-lane close path (`onCloseTerminal`) across the project's live sessions rather than
  inventing a second teardown route.
- Sequence it: close the sessions, confirm they're gone, **then** write `archivedAt`. Writing the
  flag first re-creates the lie above.
- Report honestly in the toast: how many agents were closed. Undo should restore the shelf state;
  be explicit in your result about whether Undo can or cannot bring the *sessions* back, and say
  which in the toast copy. Do not imply it restores something it can't.

**2 · Fix the Shelve toast** so it never claims a move that didn't happen. If a project has live
lanes and the user picks plain Shelve, either say what actually happened, or offer Close instead.
Your call — but no false success.

## Guardrails — read these, this is where the damage lives

- **Two verbs must never share a glyph.** A `✕` on a live lane card once meant DELETE LANE and
  cost the user real data ([[feedback_two_verbs_one_glyph]]). **Close-project** and
  **Forget-project** are different in kind: one is reversible housekeeping, the other destroys
  rosters, tasks and notes. They must not look alike, sit adjacent without separation, or share an
  icon. Guard proportional to damage: closing needs no scary confirm (it's reversible); forgetting
  already has its undo snapshot.
- **Never orphan the need behind a control you remove.** Don't remove plain Shelve to force Close.
- Closing must **not** delete worktrees or kill anything outside this project. Other projects'
  lanes keep running.
- **NEVER pattern-kill processes.** Close the sessions Operator actually owns, by id, through the
  existing path — never a `pkill`-style sweep.
- Ending a lane mid-turn loses that turn's work. Decide whether Close warns when a lane is
  `running` (as opposed to `waiting`/`idle`) and say what you chose. My instinct: a quiet count in
  the confirm ("2 agents are mid-task"), not a blocking modal.

## Not in scope

Where the control LIVES and what it looks like is Design's call, not yours — Design already has
the Agents-view and config-chip work queued and owns this vocabulary. Wire the action and put it
somewhere defensible (the gallery card's ⋯ menu, beside Shelve, is the obvious home since that's
where Shelve and Forget already are). If you find yourself designing a new affordance, stop and
say so in the result instead.

## Verify

- `npm test` — cover: close with 0 live lanes (pure shelve), with N live lanes (all ended, THEN
  shelved), and that a project with a live lane can't be silently "shelved" into Previous.
- `npm run build` clean.
- **Acceptance is durable state**: close a project with live lanes, then confirm in
  `~/.operator/sessions.json` that those sessions are gone and `archivedAt` is set in
  `projects.json` — and that the project actually appears under Previous, not just claims to.
- Confirm other projects' live sessions are untouched.

## Output

`dev/briefs/close-a-project-RESULT.md`: the sequence you implemented, what Undo does and doesn't
restore, the Shelve-toast fix, how you kept Close and Forget visually distinct, what you chose for
mid-task lanes, and anything you left for Design. Then one OPERATOR-REPLY line.
