# Worktree default ON for operator + research — RESULT

**Status: built, typechecked, unit-tested, and driven end-to-end in the harness.**

> ⚠ **The brief `dev/briefs/worktree-default-on.md` does not exist** — same as the prune task, not in
> this worktree, not in the main checkout, not in git history. Built from the one-line dispatch
> ("worktree default ON for operator+research, seed AND migration of stored role-defaults.json").
> The judgement calls I had to make without it are under **Decisions**.

## What landed

| File | |
|---|---|
| `src/renderer/lib/model-config.ts` | seed flipped; new `migrateSeededWorktreeDefaults` |
| `src/renderer/lib/model-config.test.ts` | seed assertions updated, +9 migration tests |
| `src/renderer/views/DashboardView.tsx` | migration wired into the role-defaults hydrate, one-shot flag, Undo toast |
| `dev/mock-bridge.ts` | `loadRoleDefaults`/`saveRoleDefaults` implemented (they did not exist), `?worktree=` fixture |
| `dev/drive-worktree-default.mjs` | **new** — harness driver |

**Seed** (`seedGlobalDefaults`) now reads `code:on, design:on, operator:on, research:on, review:off,
qa:off`.

**Migration** matters more than the seed: `seedGlobalDefaults()` only ever runs against an *empty*
store, and anyone who has launched the app already has all six roles on disk — so without a
migration the flip reaches nobody and looks like it did nothing.

## On your real `~/.operator/role-defaults.json`

```
stored : operator:false  research:false  code:true  design:true  review:false  qa:false
after  : operator:TRUE   research:TRUE   code:true  design:true  review:false  qa:false
flipped: ["operator", "research"]        second run flips: []  (returns input by reference)
```

Your stored file is **byte-for-byte the old seed** — you have never touched the global defaults —
so it lands exactly on the new seed.

## Decisions (made without a brief)

**1. I think this change is arguable, and I built it anyway.** The code it replaces carried an
explicit rationale: *"a worktree earns its cost for lanes that WRITE and mostly gets in the way for
lanes that read and coordinate."* Operator coordinates and Research reads, so on that reasoning
they're the two lanes you'd leave in the root. **The case for your version, which I've written into
the comment:** both lanes do write to the repo — a coordinator lands merges and edits notes, and a
research lane's deliverable is a *file* (its chat answer is invisible to every other lane, per
`feedback_dispatch_needs_output_path`). Two unisolated lanes writing into the same checkout while
Code works in a worktree is the collision the posture exists to prevent. **The cost worth knowing:**
an isolated Operator no longer shares a checkout with the lanes it coordinates, so "look at what
Code just did" becomes a cross-worktree question for it too. If that turns out to bite, `operator`
alone is one toggle in Agents → Defaults.

**2. The migration flips only an explicit `false`, per field.** Same crux as `clearSeededRoleFields`
— a seeded value is indistinguishable from a chosen one, and for a boolean it's worse because "off"
has one spelling. So the rule is as narrow as it can be while still working:

- stored `false` (the exact old seed value) → flip;
- **absent → left absent**, because absent means "inherit" and the user had to deliberately choose
  it in the UI;
- already `true` → not touched, not reported;
- the rest of the role's entry (a pinned model/effort) is preserved.

`review` and `qa` are *not* in the migration table at all — their seed never moved, so a stored
`false` for them is left alone.

**3. I did NOT gate on "has the user configured this role at all".** I considered refusing to
migrate a role carrying e.g. a pinned model, on the theory that the user has been in there
deliberately. Rejected: the worktree toggle is its own control, a model pin is not evidence about
it, and per-field is the house idiom. The safety net is the flag + Undo, not extra timidity.

**4. One-shot flag (`localStorage: operator.worktreeSeedMigratedAt`), separate key from the lane
prune.** Without it the migration re-runs every launch and overwrites the user's own choice — turn
Operator's worktree back off and it silently returns. Set even on a first-run seed (that store is
already on the new posture, so it can never have anything to do). **Stays set after Undo** — undo
means keep it.

**5. Toast + Undo, no file backup.** Where a lane *runs* is not something to change silently — an
isolated lane lands its work on a branch, a different answer to "where is my diff?". There is no
`backupRoleDefaults` command and I didn't add one: the change is two booleans, fully named in the
toast, undoable from it, and two clicks to revert by hand. The toast names the path
(`Agents → Defaults`) and the driver walks that path rather than deep-linking, so the copy is
verified to be true.

**6. The mock bridge had no role-defaults store at all**, so the entire global layer — and the seed
that writes it — was unreachable from the harness. Implemented `loadRoleDefaults`/`saveRoleDefaults`
against a live object. Side benefit: `drive-roster.mjs`'s step 9 assertion "…persisted to the
durable store" previously printed `null` and now prints the real persisted object, so it tests
something.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **438 passed / 42 files** (429 → 438; 9 new migration tests).
- `node dev/drive-worktree-default.mjs` — all six groups pass:
  1. migrates the stored file on hydrate; `review`/`qa` untouched
  2. toast reads `Operator and Research now run in their own worktree` with UNDO
  3. the **Agents → Defaults screen agrees with the file** — `operator/research/code/design` pressed, `review/qa` not
  4. Undo restores `false`/`false`; flag stays set
  5. flagged boot of the same store moves nothing, shows no toast
  6. a first-run (`empty=1`) install seeds straight to the new posture, with no migration toast
- `node dev/drive-roster.mjs` — passes, no regression.
- Screenshots: `/tmp/operator-shots/worktree-default-toast.png`, `worktree-default-agents.png`.

## Deliberately left out

- **No per-project migration.** This changes the *global* layer only. A project whose lane pins
  `useWorktree` explicitly still wins over it — correctly, per the tri-state rule
  (`resolveAgentConfig`'s `setBool`). Two lanes in your store pin it (`operator` in `operator` and
  `el-encanto`), both already `true`, so nothing there needs moving.
- **No backup of `role-defaults.json`** — reasoning in Decision 5.
- **Not theme-passed.** Nothing new is drawn; the toast is an existing component with existing
  tokens, and the Defaults rows already existed.
- **Retired-value table is frozen, not extendable.** A future default flip needs its own entry *and
  its own flag* — editing `LEGACY_WORKTREE_SEED` in place would re-run against users already
  migrated. Said so in the comment.
