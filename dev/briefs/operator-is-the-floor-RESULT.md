# Operator is the floor — RESULT

**Status: done. `tsc` clean, `npm run build` clean, 484 tests pass.**

**Caught before it merged. The prune has never run against your real store** — it lives only in
this unmerged worktree, and the one-shot flag it keys on is per-install localStorage that the
installed app has never written. `~/.operator/projects.json` still shows every seeded project at
six lanes. Nothing to undo.

## The floor rule

```ts
function isFloorLane(role: Role): boolean {
  return isCoordinator(role.id)   // 'operator' — and its retired alias 'orchestrator'
}
```

I took your explicit-id exemption rather than "never leave a roster empty", for the reason you
gave: it says what it means, and it does not quietly promote whichever lane happens to sort first
in a roster that never had a coordinator. One deviation — it keys on `isCoordinator`, not the
literal `'operator'`, so a roster still holding the pre-rename `orchestrator` id is protected too.
That alias already exists everywhere else in the codebase; leaving it out would have made the
floor fail on exactly the oldest projects, which are the ones most likely to be all-stock.

**Scoped to the migration, not to the user.** `removeRoleFrom` is untouched: deleting your way to
an empty roster is a decision, and this floor exists because nobody asked for the *migration*.
There's a test pinning that.

**The count and the action now read one predicate.** `isPrunable` is the single function both
`seededIdleLaneCounts` and `pruneSeededIdleLanes` call, so a toast promising 49 while 43 go is
structurally impossible rather than merely unlikely. Verified against the real store below.

## Real store — before/after

Full hydrate chain (`migrateLegacyCoordinator` → `clearSeededRoleFields` → `pruneSeededIdleLanes`)
over `~/.operator/projects.json` + `sessions.json`:

```
project            before  after  kept
operator               6      6   operator,research,design,code,review,qa
Operator-landing       6      1 * operator
fastrack               6      6   operator,research,code,review,design,qa
Fastrack-landing       6      1 * operator
el-encanto             6      6   operator,research,code,review,design,qa
uwazi_app              6      6   operator,research,code,review,design,qa
web27                  6      6   operator,research,code,review,design,qa
walter                 6      1 * operator
visual language        6      1 * operator
Mise-landing           6      1 * operator
website-2025           6      1 * operator
mantel                 6      4 * operator,research,code,design
mantel-landing         6      5 * operator,research,code,design,qa

TOAST WOULD SAY : 33 lanes from 8 projects
PRUNE ACTUALLY  : 33 lanes from 8 projects
MATCH           : true
projects left with ZERO lanes:     0
projects left with NO coordinator: 0
second run drops: 0 (idempotent: true)
```

Your six all-stock projects land at **6 → 1**, exactly as predicted, and `operator` / `el-encanto` /
`fastrack` / `uwazi_app` are untouched at 6.

**One difference from your table, and it isn't the floor:** you expected `web27` to lose a lane; it
now loses none. Its `review` lane gained a saved session and a dispatch record — `projects.json` was
written at **15:54 today** by your running app. The store is live, so this table is a point-in-time
snapshot; the predicate is unchanged. Totals moved 39 → 33 lanes and 9 → 8 projects, which is
exactly the six protected Operator lanes plus web27 dropping out of the touched set.

*(Ran with `node_modules/.bin/vite-node` on a scoped path from inside the worktree — no root scan.)*

## A new project is born with one Operator lane

`DashboardView.tsx` `upsertProject` now seeds it. The `roster-on-demand` reversal is recorded **in
the code comment at the seeding site** (where someone about to "fix" it will actually be standing),
not only here — it says the brief was right about the objection and wrong to overshoot to zero, and
that the empty state it added is still needed because a user can still delete their way there.

**One judgement call beyond the brief.** You said "give it the Operator preset from
`rolePresets()`". I seeded `{id, name, accent, prompt}` and deliberately **dropped `model` and
`effort`. A value on a lane is a PIN that beats your global per-role default — that is the whole
cascade in `lib/model-config`, and re-creating "every seeded value looks pinned" is precisely what
`clearSeededRoleFields` exists to undo. It also would have immediately fought the worktree-default
work from earlier today. Absent means inherit, so the lane still resolves to Fable/normal, but a
global default can now reach it. Say the word if you want the pin instead.

## How the one-lane sidenav reads

Driven via a new `?solo=1` fixture (`dev/mock-bridge`), screenshot at
`/tmp/operator-shots/solo-lane-sidebar.png`.

- **Sidenav**: `AGENTS` header with its `+` on the right, then one row — `Operator … IDLE`. It
  reads as a section with one member, not as a failed render: the header, the `+`, and the row's
  own accent orb all sit at the same left edge, so the column still looks like a column.
- **Roster board**: `READY · 1`, the Operator row with `Launch →`, and `+ Add agent` as a dashed
  full-width row directly beneath it — the most prominent thing on an otherwise quiet board, which
  is right now that it's the only way to grow the team.
- **Gallery card**: reads `1 lane`.

I'd call it deliberate. **One pre-existing nit, now much more visible:** an idle row whose model is
inherited renders `· High` — a leading separator with nothing before it. It was always there (the
same string shows for `design` in `drive-roster.mjs` today), but with a single row it's the only
config text on screen. That's Design's call, not something to restyle here.

## Verify

- `npm test` — **484 passed / 43 files**. `prune-seeded-lanes.test.ts` grew a `the coordinator is
  never pruned` block: all-stock six → exactly one (Operator); the legacy `orchestrator` id
  protected; a project whose Operator has history untouched *by reference*; a user-emptied roster
  stays empty; the floor never *resurrects* an Operator into a roster that lacks one; counts match
  the action (10, not 12, for two all-stock projects); still idempotent.
- One pre-existing test was **rewritten, not deleted** — `empties a project whose six lanes were
  all seeded and never used` asserted the floorless behaviour. It now asserts `→ ['operator']` and
  carries a comment naming this brief, so the old expectation can't quietly come back.
- `npm run build` clean.
- `node dev/drive-prune-lanes.mjs` — all four groups pass against the amended contract; the
  fixture's Operator lane is now kept and the toast reads *"Tidied 1 unused lane from 1 project"*.

## Still unprotected

- **A project whose roster has no coordinator at all** can still be pruned to zero (e.g. one
  holding only `code` and `qa`). The floor protects a lane that exists; it does not add one.
  There's a test asserting exactly that, because the alternative — the migration *inventing* a lane
  — is a bigger surprise than an empty board, and the seeding change covers new projects going
  forward. Flagging it as a real gap rather than hiding it: on your store it affects nothing (every
  project with a roster has an Operator).
- **The empty-roster dead end still exists for a hand-emptied project** — a dispatch to a
  non-existent lane goes unassigned, as `roster-on-demand.md` recorded. Unchanged by this work.
