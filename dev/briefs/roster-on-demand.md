# No auto-seeded lanes — the roster starts empty and grows on demand

**User, 2026-07-28:** *"no agents should be added automatically to the roster (sidenav waiting to be
launched) but on demand."*

**Deliverable: the change, plus the decisions recorded in `dev/roster-on-demand-notes.md`.**

## This reverses an earlier explicit decision — deliberately

`lib/roster.ts:130` `defaultRoster()` seeds six lanes (Operator/Research/Code/Review/Design/QA) into
every new project. The 2026-07-27 agents-board work looked at this and concluded *"`defaultRoster()`
still seeds 6 lanes; that's fine now that idle lanes are cheap, so don't 'fix' the seed."*

**The user has now overridden that.** Cheap-to-render was the wrong test: the problem isn't pixel
cost, it's that a brand-new project arrives pre-populated with six agents nobody asked for, all
sitting in the sidebar looking like they are waiting for something. Do not re-argue the earlier
position — it was answering a different question.

## What to build

1. **A new project starts with an empty roster.** `+ Add agent` is the only thing in the list.
2. **Keep the six definitions as templates.** They are good defaults with tuned models, efforts,
   accents and charters (`DEFAULT_ROLE_PROMPTS`) — the objection is to auto-*seeding*, not to their
   existence. `+ Add agent` should offer them as one-click presets, plus a blank custom lane. Adding
   Code should take one click, not a form.
3. **Existing projects keep their rosters.** This is a change to seeding, not a migration. Do not
   retroactively empty anyone's board.
4. **Design the empty state.** It is now the first thing every new project shows, so it has to teach
   what a lane is and make adding the first one obvious. This is the most important screen in the
   change and currently does not exist.

## The consequence that needs a decision

**`OPERATOR-DISPATCH [code] …` addresses a lane by id.** With no seeded roster, a dispatch can name a
lane the project does not have. Today `dispatchToRole` needs a `Role`, and `startProjectTasks` skips
tasks whose `roleId` has no matching role — so a dispatch to a non-existent lane silently goes
nowhere. That is already a latent bug (see `queued-tasks-no-trigger.md` defect 3: the only genuinely
queued tasks in the store are unassigned ones nothing can pick up), and an empty default roster makes
it the *common* case rather than an edge case.

Settle it and write it down. Options worth weighing:

- **Auto-create the lane from its template** when a dispatch names a known preset id. Keeps the
  dispatch loop working out of the box; slightly at odds with "on demand", though arguably a
  dispatch *is* the demand.
- **Reject and surface it** — the dispatch fails visibly with "no Code lane in this project", offering
  to create it. Honest, but it breaks an unattended orchestration run.
- Something better.

Whatever is chosen, **a dispatch must never silently vanish.** That is the current behaviour and it
is the worst of the options.

## Verify

`dev/drive-roster.mjs` plus `dev/mock.html?empty=1` (which already boots a virgin app). Assert: a new
project shows zero lanes and a usable empty state; a preset adds in one click with its model, effort,
accent and charter intact; an existing project's roster is untouched; and the dispatch behaviour
chosen above is exercised, including the no-such-lane path. Theme-pass the empty state across all six
palettes.
