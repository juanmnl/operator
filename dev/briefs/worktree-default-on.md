# Brief — worktree should default to ON for the writing lanes

User: **"i guess worktree should be on by default."** Decision taken (user confirmed):

| lane | today | wanted |
|---|---|---|
| code | true | **true** (unchanged) |
| design | true | **true** (unchanged) |
| operator | false | **TRUE** |
| research | false | **TRUE** |
| review | false | **false** (unchanged) |
| qa | false | **false** (unchanged) |

Review and QA stay OFF deliberately — see the hazard below. Do not "helpfully" flip them.

## The hazard, so nobody flips review/qa later

Worktrees are **per-session, not per-project**. `~/.operator/worktrees/` currently holds
`operator-367340`, `operator-1cf818`, `operator-c48bd8` — three separate checkouts of the SAME
project. A Review or QA lane given its own worktree therefore gets a clean checkout that does
**not** contain the uncommitted work it was launched to verify. Turning worktrees on for those
two would silently destroy their reason to exist. Put this in a comment next to the defaults so
the next person doesn't have to rediscover it.

## The trap — changing the seed alone does NOTHING

`seedGlobalDefaults()` (`src/renderer/lib/model-config.ts:128`) only runs on FIRST RUN:
`DashboardView.tsx:184` reads `stored` and falls back to the seed **only when stored is empty**.
This user already has `~/.operator/role-defaults.json`:

```json
{ "code": {"useWorktree": true}, "design": {"useWorktree": true},
  "operator": {"useWorktree": false}, "qa": {"useWorktree": false},
  "research": {"useWorktree": false}, "review": {"useWorktree": false} }
```

So editing the seed function would look correct in code and change nothing on any existing
install. **This is the same trap the roster seed had.** You need both:

1. **The seed**, for new installs.
2. **A one-time migration** for stored defaults, so existing installs actually move.

### Migration rules

- Flip `operator` and `research` to `useWorktree: true` **only if their stored value still equals
  the OLD seed value (`false`)**. If the user has since set either one deliberately, leave it —
  we cannot distinguish "never touched" from "set back to false" without this test, so the old-seed
  match is the closest honest proxy. State that limitation in your result.
- Do not touch `code`, `design`, `review`, `qa`.
- **Run once**, behind a flag, the way the removed `operator.rosterDefaults.v2` top-up was. A
  posture the user changes back must never be re-flipped on the next launch.
- No undo toast needed here (this is a settings default, not data deletion) — but the change
  should be visible: the Defaults screen must show the new values immediately, not after a restart.

### Per-lane pinned values — leave alone

Measured across all rosters: every `code`/`design`/`research`/`qa`/`review` lane has
`useWorktree: undefined` (inherit), and exactly **2 `operator` lanes are pinned `true`**.
Pinned values are user choices. The migration touches globals only, never `role.useWorktree`.

## Verify

- `npm test` (`model-config.test.ts` exists — extend it), `npm run build` clean.
- **Acceptance is the durable file**: after launch, `~/.operator/role-defaults.json` shows
  operator+research `true`, review+qa `false`, code+design `true`. Paste before/after.
- Relaunch: confirm the migration does not re-run. Then manually set `research` back to false,
  relaunch again, and confirm it STAYS false.
- Check a lane card in the roster shows the new inherited value (it renders "inherited" state,
  not pinned — `RosterPanel.tsx` `origins.useWorktree`).

## Not in scope

Do **not** restyle the worktree control itself. It's the tri-state chip in `RosterPanel.tsx:730-759`
and Design owns it — see `dev/briefs/roster-config-chips-visibility.md`, which has been amended
to cover it. You change the VALUES; Design changes how they're drawn.

## Output

Write `dev/briefs/worktree-default-on-RESULT.md`: before/after of the stored file, where the
run-once flag lives, the exact migration predicate, and confirmation that the
set-back-to-false-then-relaunch test passes. Then one OPERATOR-REPLY line.
