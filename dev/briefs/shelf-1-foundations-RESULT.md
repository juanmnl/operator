# RESULT — Shelf steps 1+2

Both steps landed. Zero user-visible behaviour change, as intended. Stopped at the line the
brief drew: no `archivedAt` writer, no gallery work, no UI.

## What landed

**`src/renderer/lib/format.ts`** — `relativeTime` ladder extended past days:
`< 7d → Nd` · `< 5w → Nw` · `< 12mo → Nmo` · else `Ny`. Every shorter branch and the
`subMinuteSeconds` option are byte-identical; `format.test.ts:25`'s `2d` still passes.

**`src/renderer/lib/format.test.ts`** — one new `it` covering each new rung and both hand-off
boundaries (6d→`6d`, 7d→`1w`, 31d→`4w`, 32d→`1mo`, 350d→`11mo`, 365d→`1y`), plus the
`127d ago` case from the brief, which now reads `4mo ago`.

**`src/shared/types.ts`** — `archivedAt?: string` added to `Project` after `contextNotes`
(field only, nobody writes it). `lastActiveAt` gained the corrected doc comment: "last time an
agent RAN or was restored here — *not* last opened."

**`src/renderer/lib/project-shelf.ts`** (new) — `FILTER_THRESHOLD`, `STALE_DAYS`,
`isActiveProject`, `byActivityThenRecency`, `partitionProjects`, `matchProject`,
`staleProjects`, exactly as specified. One-way dependency: it imports the `ProjectActivity`
*type* only, so `project-status` still knows nothing about shelves.

**`src/renderer/lib/project-shelf.test.ts`** (new, 12 tests) — all six cases from the brief.

**`src/renderer/components/sidebar/ProjectSwitcher.tsx`** — local `FILTER_THRESHOLD` deleted,
the sort+filter `useMemo` collapsed to
`projects.filter(p => matchProject(p, query)).sort(byActivityThenRecency(activities))`.
Same comparator expression, same stable sort, same fresh array — a pure move.

## Decisions I had to make

1. **`matchProject('')` returns `true`.** The switcher used to branch (`q ? filter : projects`)
   to avoid a pointless pass. Making the empty query match everything lets callers filter
   unconditionally, which is what makes the one-liner above possible. Documented on the export.
2. **`staleProjects` uses `<=` against a `now − 14d` cutoff**, so exactly 14 days *is* stale —
   that's the reading of "hits the 14-day boundary exactly" I took. Test pins both sides
   (14d in, 14d−1ms out).
3. **`staleProjects` re-checks `!p.archivedAt`** even though it takes the already-partitioned
   active list. Without it, an archived-but-live project would be offered for shelving a second
   time; with it, the function is correct on any input.
4. **Month/year rungs round the DAY count, not the rung below it** (`d/30.44`, `d/365.25`, not
   `w/4.3`). Rounding a rounded value is how you get a `0mo ago`; this way no rung can print a
   zero — 32d is the first day the month rung can be reached and it yields `1mo`.
5. **No `?? ''` guard on `lastActiveAt` in `byActivityThenRecency`.** The switcher's original
   line would throw on a record missing the field, and the brief asked for identical behaviour,
   so I copied it as-is rather than quietly hardening a shared module.

## Surprises / things worth knowing

- **`NaNd ago` is now `NaNy ago`.** `dev/review-working-tree.md:285` records that a bad/absent
  `lastActiveAt` renders `NaNd ago`. `NaN` fails every `<` comparison, so it used to fall out of
  the days branch and now falls to the years branch instead. Same bug, same class, new suffix —
  I did **not** add a guard, because that would change the shorter branches the brief said to
  leave alone. Worth folding into whatever fixes the real cause.
- The drive script wants its own vite server on `MOCK_PORT` (default 1440). Operator's live
  server on **1432** serves `/dev/mock.html` fine, so I ran it there rather than binding a
  second port.
- The mock store has only 3 projects, so `showFilter` (>8) never turns on during the drive —
  the threshold is covered by unit test, not by the drive.

## Verification

- `npm test` — **258 passed / 34 files**, including the new `project-shelf.test.ts` (12) and
  the grown `format.test.ts` (15). The muted-opacity guard is green.
- `npm run build` (`tsc && vite build`) — clean; only the pre-existing >500 kB chunk warning.
- `MOCK_PORT=1432 node dev/drive-navigation.mjs` — **all 11 checkpoints pass**, every
  `(expect …)` annotation matched. Confirms the switcher refactor changed nothing: gallery
  heading, scoped sidebar, switcher footer, Esc-closes-without-leaving, ⌘⇧O, back chevron,
  rail badge, idle-lane launch.

## Explicitly not done (next steps' scope)

`ProjectGallery.tsx` untouched — its sort still carries the local copy, and moving it needs the
new `activities` prop from step 3. Nothing writes `archivedAt`; `upsertProject`'s auto-lift, the
archive/restore verbs, and the gallery sections are all still ahead.
