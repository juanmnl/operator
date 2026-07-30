# RESULT — Shelf step 6: the assisted tidy pass

Plan build-order row 6 — *stale bar → pre-checked review → shelve, bulk undo*. There was no
brief for this one (the plan gives it one table row and one sketch line: `12 projects haven't
run in over two weeks. · Review →`), so the interaction below is designed, not transcribed.
Everything it stands on already existed: `staleProjects` / `STALE_DAYS` from step 1-2, the
shelf from step 3.

---

## What landed

### 1. One bulk write path — `views/DashboardView.tsx`

`archiveProjects(ids: string[])` replaces the single-project write; `archiveProject(id)` is now
a one-line wrapper over it. Consequences worth knowing:

- **Every project in a batch gets the SAME `archivedAt`.** That's exactly the tie the Previous
  shelf's `lastActiveAt` tiebreak was built for in step 2 — it now has a real caller.
- **One toast, one undo, scoped to the ids this call shelved** — not "everything archived", so
  an undo can't unshelve something you put away last week. The toast reads `Shelved 5 projects`
  in bulk and keeps the named `Shelved <name>` form for a single card.
- Restoring is a single `setProjects` pass over the captured id set.

### 2. The tidy bar — `ProjectGallery.tsx`

A quiet strip above the shelves, `1 project hasn't run in over two weeks.` / `N projects
haven't…`, with `Review →` and a dismiss `✕`. `--overlay-subtle` background, muted ink, the
`Review` affordance in `--fg` (accent stays reserved for activity).

- Shown only when `staleProjects(active, activities)` is non-empty — so it inherits the
  library's rules for free: **nothing live is ever offered, and nothing already shelved is.**
- **Hidden while filtering** — a query means you're looking for one thing, not tidying.
- It only ever *offers*. Staleness stays computed and is never written, per the plan.

### 3. Dismissal that neither nags nor disappears forever

`localStorage['operator.tidyDismissed']` holds `{ at, ids }` — a new key, not one of the
orphaned ones the plan warned about. The bar shows iff some currently-stale project is either
**not in `ids`** *or* **has `lastActiveAt > at`**. So:

- dismiss it and it stays gone across restarts;
- a *twelfth* project going quiet brings it back;
- a project that has since run, and gone quiet again, counts as un-asked rather than being
  silenced forever by a dismissal that predates its last run.

Dismissal isn't in the plan at all — I added it because an advisory bar that can't be silenced
is a nag, and the store this feature exists for has 10 of 19 stale, i.e. the bar would
otherwise be permanent furniture.

### 4. The review sheet

Scrim + centred card, built on the `CommandPalette` idiom (`--bg-sidebar`, 1px border, radius
10, `rgba(0,0,0,0.4)` backdrop). Scrim-click and Esc (capture phase) both cancel.

- Every stale project, **pre-checked**. Unchecking is how you keep one — an opt-*out*, because
  shelving the quiet ones is what you asked for by opening the sheet, and twelve empty boxes
  would make the assisted pass no faster than doing it by hand.
- Rows wear the **Previous shelf's own treatment** (name at 80% of `--fg`, path + `last ran …`
  in 9.5 mono muted), so you can see where they're going before you agree to send them.
- Checkbox is `RosterPanel`'s existing one (11px, accent fill + `--fg-on-accent` tick when on,
  `1px solid var(--fg-muted)` when off).
- Footer: `N of M selected` · `Cancel` · `Shelve N`, the affirmative as a `--btn-bg` surface
  button (never an accent fill), disabled at zero.

---

## Decisions I had to make

1. **Shelving from the sheet also records the dismissal.** If you uncheck two of twelve and
   shelve ten, the bar returning immediately with the two leftovers reads as the review not
   having worked. You told it what to do with that set; it doesn't ask again.
2. **Undo does NOT re-open the bar.** Undoing means "not those" — putting the prompt straight
   back would be arguing. Driver-pinned, since it's the behaviour most likely to look like a bug.
3. **`archiveProject` became a wrapper rather than staying its own write.** Two paths to the
   same field would have drifted; the toast copy is the only thing that varies, and it varies
   on `ids.length`.
4. **The sheet sits at `z-index: 800`, below the toasts (900)** — the undo that follows a
   shelve must never be behind its own scrim.
5. **"two weeks" is hardcoded** with a comment tying it to `STALE_DAYS`, rather than derived. I
   had a `STALE_DAYS === 14 ? …` ternary first; TypeScript types the constant as the literal
   `14`, so the other branch was unreachable — dead code pretending to be flexible.

## Surprises

- **The theme pass could never have seen this.** Every project in the fixture ran minutes ago,
  so the stale set is always empty there. I added a small `loadProjects` wrapper to
  `drive-theme-pass.mjs` that ages `uwazi_app` to 40 days, so the bar and the sheet now get
  probed in all six palettes like every other surface. Same reason the new tidy driver ages its
  own fixture — a harness that can't reach a state can't verify it.
- `relativeTime`'s step-1 ladder is visibly doing its job here: the review rows read
  `3w ago / 4w ago / 1mo ago / 2mo ago`, which is the whole reason step 1 shipped first.

---

## Verification

- `npm test` — **258 passed / 34 files** (the muted-opacity guard covers the new styles; the
  two hover reveals in this change are background/colour swaps, no opacity stacking).
- `npm run build` (`tsc && vite build`) — clean.
- **`node dev/drive-gallery-tidy.mjs` (new)** — 6 scenarios, all green:
  1. bar counts the 6 stale pads only — **a live project aged 40 days is not offered**;
  2. `Review →` opens the sheet with **6 of 6 pre-checked**, `Shelve 6`; Escape closes it and
     shelves nothing;
  3. dismiss → bar gone → **survives a reload**, and `{ids: 6, at}` is what got remembered;
  4. drop one id from the stored set → **the bar comes back**;
  5. uncheck one → `5 of 6 selected` / `Shelve 5` → shelve → `Previous · 5`, the unchecked one
     stays active, toast `Shelved 5 projects` + Undo, bar gone;
  6. Undo restores all 5 to ACTIVE and does **not** re-open the prompt.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**, now including
  `tidy bar text` 3.73–5.89, `tidy bar · Review` 11.63–15.13, `tidy row name` 6.58–11.22,
  `tidy row path` 3.80–7.38, `tidy footer count` 3.80–7.38, `tidy shelve button` 10.26–15.53
  (body floor 4.5, meta floor 3.0). Screenshots at `theme-pass/<key>-1b-tidy-review.png`.
- `node dev/drive-gallery-shelf.mjs`, `drive-gallery-cards.mjs`, `drive-navigation.mjs` — all
  still pass unchanged; the fixture has nothing stale, so none of them ever see the bar.

## Not covered

The real 19-project store is the only place the count in that sentence has ever been true.
Worth one look at whether "10 projects haven't run in over two weeks" feels like help or like
an accusation the first time it appears — that's a judgement the mock can't make for you.
