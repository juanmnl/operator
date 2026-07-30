# Prune seeded idle lanes — RESULT

**Status: built, typechecked, unit-tested, and driven end-to-end in the harness.**

> ⚠ **The brief `dev/briefs/prune-seeded-idle-lanes.md` does not exist** — not in this worktree, not
> in the main checkout, not in git history. I built from the one-line dispatch ("one-time prune of
> never-launched unmodified seeded lanes from existing projects, with undo") plus
> `roster-on-demand.md`, which is the change this finishes backwards. Every judgement call I had to
> make in the brief's absence is written down below under **Decisions**. If the brief said something
> different, the pure predicate is one file and the wiring is ~20 lines.

## What landed

| File | |
|---|---|
| `src/renderer/lib/prune-seeded-lanes.ts` | **new** — the whole predicate, pure |
| `src/renderer/lib/prune-seeded-lanes.test.ts` | **new** — 16 tests |
| `src/renderer/views/DashboardView.tsx` | hydrate wiring, one-shot flag, undo toast |
| `src/renderer/lib/roster.ts` | `NO_COMMISSIONING` exported (+ why) |
| `dev/mock-bridge.ts` | `?prune=` fixture + flag, `backupProjects` stub |
| `dev/drive-prune-lanes.mjs` | **new** — harness driver |

A lane is removed only if **both** hold:

- **No history in this project** — no saved session launched against it, no task ever assigned to it
  at any status, no dispatch to or from it in the project's log.
- **Still exactly what the seeder wrote** — name, model, effort, accent, permission mode, agent
  name, worktree posture and charter all match the preset (absent counts as stock, since absent
  means "inherit"). Anything else the user touched, and a lane with no preset at all (a custom
  lane), is kept.

It runs **once per install** on hydrate, right after the existing `clearSeededRoleFields`
migration, behind the same "no backup, no write" rule, and raises an **Undo** toast that stays until
acted on.

## What it does to the real store

Dry run of the actual hydrate chain (`migrateLegacyCoordinator` → `clearSeededRoleFields` →
`pruneSeededIdleLanes`) against `~/.operator/projects.json` + `sessions.json`:

```
operator           operator·used  research·used  design·used  code·used  review·used  qa·used
Operator-landing   operator·used  research·DROP  code·DROP  review·DROP  design·DROP  qa·DROP
fastrack           operator·used  research·used  code·used  review·used  design·used  qa·used
Fastrack-landing   operator·DROP  research·DROP  code·DROP  review·DROP  design·DROP  qa·DROP
el-encanto         (all six used)
uwazi_app          (all six used)
web27              operator·used  research·used  code·used  review·DROP  design·used  qa·used
walter             operator·DROP  research·DROP  code·DROP  review·DROP  design·DROP  qa·DROP
visual language    (all six DROP)
Mise-landing       (all six DROP)
website-2025       (all six DROP)
mantel             operator·used  research·used  code·used  review·DROP  design·used  qa·DROP
mantel-landing     operator·used  research·used  code·used  review·DROP  design·used  qa·used

→ 39 lanes from 9 projects · second run drops 0 (idempotent)
→ projects still holding a roster: 8 of 19
```

**Not one lane in the real store is classified `edited`** — every lane is either used or stock. Four
projects (`Fastrack-landing`, `visual language`, `Mise-landing`, `website-2025`) empty completely;
they are exactly what a project created today looks like. The four busiest projects lose nothing.

## Decisions (made without a brief)

**1. "Unmodified" had to mean *any charter the seeder ever wrote*, not *today's charter*.**
This is the crux and it nearly sank the feature. Every seeded lane in the real store carries a
`prompt`, and **none of them equals today's preset** — the charters were rewritten over time (the
`NO_COMMISSIONING` clause was appended to all five worker roles; the coordinator charter was
reworded twice). Matching today's text only would have pruned 18 lanes across 3 projects and left
`walter` and `Fastrack-landing` sitting on six untouched lanes each — i.e. it would have failed the
actual purpose.

So I walked `roster.ts` through git history, evaluated `DEFAULT_ROLE_PROMPTS` at every revision, and
collected the distinct charters. **All 60 persisted charters in the real store are covered by that
set** — no user has ever edited one. The module recognises them as:

- today's preset text, and
- today's text minus the `NO_COMMISSIONING` suffix (**derived**, so it can't drift — this is why
  that constant is now exported), and
- two frozen literal strings for the retired coordinator wordings (those were rewrites, not suffix
  additions, so they can't be derived).

That list is history and never grows — nothing seeds a roster any more.

**2. Three independent history signals, not one.** The saved-session list is pruned over time, so
its silence is not proof a lane was never launched. Tasks and dispatches live in `projects.json` and
persist. Checked: deleting the saved-session evidence entirely changes the verdict on exactly **one**
lane out of 78, so the predicate does not hinge on the fragile signal.

**3. The one-shot flag (`localStorage: operator.seededLanePrunedAt`) is correctness, not speed.**
The predicate cannot distinguish a leftover seeded lane from one the user just added via "+ Add
agent" and hasn't launched yet. Without the flag, every added lane would be silently removed at the
next launch. The flag is set even when the scan finds nothing, and **stays set after Undo** — undo
means "keep them".

**4. Undo restores state, and does not re-arm the migration.** Same toast+snapshot shape as
`forgetProject` / `archiveProjects`. The projects-file backup that `clearSeededRoleFields` already
takes covers this write too; a failed backup aborts both.

**5. An explicit `useWorktree: false` counts as *modified*.** No preset sets the field, so `false`
can only have come from the user turning it off. Same reasoning `model-config`'s `setBool` uses.

**6. Harness fixtures needed a flag.** `MOCK_PROJECTS` contains lanes the prune would legitimately
remove (`uwazi_app`'s two), so an unguarded migration would have quietly emptied a roster that
`drive-roster.mjs` asserts on — the first driver run of the day would pass and the second would
fail. Every boot without `?prune=` now marks the flag done. Verified `drive-roster.mjs` is unchanged.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **429 passed / 42 files**, including 16 new.
- `node dev/drive-prune-lanes.mjs` (WebKit, real renderer, `?prune=` fixture covering all six
  verdicts) — all four groups pass:
  - fires on hydrate, drops exactly the two unused stock lanes, keeps launched/tasked/edited/custom
  - toast reads `Tidied 2 unused lanes from 1 project` with an UNDO button
  - Undo restores all six; flag stays set
  - a flagged boot of the same fixture touches nothing and shows no toast
- `node dev/drive-roster.mjs` — unchanged, no regression.
- Screenshots: `/tmp/operator-shots/prune-toast.png`, `prune-undone.png`.

## Deliberately left out

- **No manual re-run.** There is no button to prune again — one-time means one-time, and the
  "+ Add agent" collision above is why. If a manual verb is wanted it belongs in Agents settings
  next to `resetPinnedRoleFields`, with a named count from `seededIdleLaneCounts` (already exported
  and tested for exactly that purpose).
- **The toast detail line is short by necessity.** `Toast.tsx` clamps it to one ellipsised line and
  the action button eats into it — about 40 characters land. Measured, not guessed.
- **Not theme-passed.** Nothing new is drawn; the toast is an existing component with existing
  tokens.
- **`dev/roster-on-demand-notes.md` not updated** — that file belongs to the earlier brief and I
  didn't want to edit another lane's record.
