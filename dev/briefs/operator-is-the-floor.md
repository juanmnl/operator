# Brief — Operator is the default lane, and the floor. Amend the prune BEFORE it merges.

User: *"the concept of having just Operator as a default agent — when opening a project, and on
the sidenav."*

**Target state:** open any project and the sidenav shows **exactly one lane, Operator.** Not six.
Not zero. Everything else is added on demand from the roster board.

## Where we actually are — I checked, don't re-derive

| | today |
|---|---|
| New project | `roster: []` — **zero lanes** (`DashboardView.tsx:594`) |
| Existing seeded project | six lanes |
| After your prune runs | **zero** for any project whose six are all stock-and-unused |

`pruneSeededIdleLanes` (`prune-seeded-lanes.ts:106-121`) is:

```ts
const kept = roster.filter((r) => !(isStockLane(r) && !laneHasHistory(p, r.id, saved)))
```

**There is no floor.** Nothing protects Operator. On the real store that means six projects —
`walter`, `visual language`, `Mise-landing`, `website-2025`, `mantel`, `Fastrack-landing` — go to
an empty roster.

So the product currently offers six or none, and never the one thing the user asked for.

## Why zero is not merely "tidy" — it's a dead end

`OPERATOR-DISPATCH [lane] …` addresses a lane **by id**. `roster-on-demand.md` already recorded the
consequence: with no lane of that id, a dispatch names something that cannot pick it up, and the
task sits unassigned. Operator is the coordinator — the lane that receives an intent and routes it.
A project with an empty roster has no entry point at all: nothing to talk to, and nothing that can
create the others.

An empty roster is defensible as a *blank canvas*. It is not defensible as the **result of a
migration the user did not ask for**, which is what the prune currently makes it.

## The change — two parts, both small

1. **Operator is the floor in the prune.** Never remove the Operator lane, even when it is stock
   and has no history. Simplest correct rule: exempt `operator` by id. If you'd rather express it
   as "never leave a roster empty — keep Operator, or the first lane if Operator is absent," argue
   for that; I prefer the explicit id exemption because it's predictable and says what it means.
   - A project that legitimately reaches zero *by the user deleting lanes by hand* must still be
     allowed to be empty. This floor applies to the **migration**, not to user action.
   - Update `seededIdleLaneCounts` so the preview count matches what the prune will actually do —
     a toast that promises 49 and removes 43 is worse than no toast.

2. **A new project is born with exactly one Operator lane.** `DashboardView.tsx:594` currently
   writes `roster: []`. Give it the Operator preset from `rolePresets()` instead.
   - This **partly reverses** `roster-on-demand.md`, which specified an empty roster. That brief
     was right about the real objection — six lanes nobody asked for — but overshot to zero. Note
     the reversal explicitly in your result and in a code comment, so the next person doesn't
     "restore" the empty default as a regression fix.
   - The empty state that brief added is still needed: a user can still delete their way to zero.
     Do not remove it.

## Check the sidenav actually reads right at one lane

The user's ask is about what they SEE. `Sidebar.tsx:16` renders "every roster lane, live or idle".
With a single idle Operator lane the AGENTS section is one row. Confirm that looks deliberate
rather than broken — and that the `+ Add agent` affordance is discoverable, since it is now the
only way to grow the team. If it reads badly, say so and stop; that's Design's call, not a thing
to restyle here.

## Sequencing — this is why it's urgent

The prune is **built but unmerged**. Land this amendment before it runs, so the migration never
produces an empty roster even once. If it has already run anywhere, say so and state exactly what
it did.

## Verify

- `npm test` — extend `prune-seeded-lanes.test.ts`: an all-stock six-lane project prunes to
  **exactly one (Operator)**, never zero; a project whose Operator has history is unchanged; a
  user-emptied roster stays empty.
- **Against the real store**: run the predicate over `~/.operator/projects.json` +
  `sessions.json` and paste the per-project before/after table. Expect the six all-stock projects
  at `6 → 1`, and `operator`/`el-encanto`/`fastrack`/`uwazi_app` untouched at 6.
  ⚠️ I tried this and burned two minutes on a vitest root-scan; run it from inside the worktree
  with a scoped path, not `--root /`.
- `npm run build` clean.

## Output

`dev/briefs/operator-is-the-floor-RESULT.md`: the floor rule you chose, the real-store before/after
table, confirmation the toast count matches the action, how you recorded the `roster-on-demand`
reversal, and how the one-lane sidenav looks. Then one OPERATOR-REPLY line.
