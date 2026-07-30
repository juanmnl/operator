# RESULT — Shelf step 3: the partition + the gallery

All five parts (A–E) landed, plus the two trap fixes. Sidebar untouched (that's step 4).

---

## A. Archive / restore — `views/DashboardView.tsx`

- `archiveProject` / `restoreProject` sit right under `updateProject`. Archive writes
  `archivedAt: new Date().toISOString()` and pushes an actionable toast
  (`Shelved <name>` · "It moves to Previous. Launching an agent here brings it straight back."
  · **Undo**). No confirm, as specified.
- **Auto-lift**: `archivedAt: undefined` added to `upsertProject`'s existing-project spread,
  with the comment explaining that it covers every revival path at once and that it also fires
  at boot for a surviving pty via the cwd-resolution effect.
- **`handleOpenProject` does NOT unarchive**, and now carries a comment saying so in the terms
  the plan used: *open ≠ revive, launch = revive*.
- Persistence needed no work, as predicted — verified live (see step 7 of the new driver).

## B. `Forget project` — fixed, same change

- `CardMenu` items gained `confirm?: true`: the first click arms the item, relabels it
  `Forget project — click again` and starts a 2500ms disarm timer (the `SessionItem` timing,
  shared as `CONFIRM_MS`); the second fires.
- `forgetProject` now captures `{ project, terminalIds, savedKeys }` **before** any unstamping
  and pushes an Undo toast. `restoreForgottenProject` re-adds the record, re-stamps the
  terminals and saved sessions, and — **the trap** — calls
  `forgottenProjectsRef.current.delete(id)` first, so background cwd resolution stops treating
  it as forgotten.
- To build that snapshot synchronously I needed current state in a callback. `projectsRef` /
  `terminalsRef` already existed 70 lines further down; I **moved them up** to just above
  `forgetProject` and added a matching `savedSessionsRef`. A `setProjects` updater runs too
  late to populate a snapshot the same tick, which is why refs rather than functional reads.

## C. The gallery — `components/dashboard/ProjectGallery.tsx`

- New props `activities`, `onArchiveProject`, `onRestoreProject`. The local sort is gone →
  `partitionProjects`. **`liveByProject` stayed** (renamed out of the dead `ordered` memo) —
  the cards still need real sessions for their lane orbs.
- Header count is `active.length`, in both the `<h2>` and the activity back button.
- **Zero new chrome when nothing is archived** — driver-confirmed: 11 projects, no shelf
  label, no toggle, no rows, and the grid renders through the same wrapper padding as before.
- Previous items are **rows** (`data-previous-row`, h30, `padding 0 10px`, radius 6,
  background-only hover, name at 80% of `--fg`, path + `last ran 7w ago` in 9.5 mono muted).
  Hover reveals `Restore` + `⋯` at `0 → 1` with their boxes always reserved — measured: no
  reflow.
- Filter at `active.length > FILTER_THRESHOLD`, searching **both** shelves; a non-empty query
  force-opens Previous and the headers read `ACTIVE · 2 of 10` / `PREVIOUS · 1 of 1`.
  No match anywhere → one muted `No match.` line.
- `⋯` gained a hairline separator then `Archive project` / `Restore to active`, above the now
  double-click `Forget project`.
- `previousExpanded` is component state seeded to `active.length === 0`. **No reset code was
  needed**: the gallery is conditionally rendered, so it unmounts on every project entry and
  the seed re-runs on arrival — same effect as the `setGalleryTab('projects')` reset, for free.

## D. Orb row suppressed

Rendered only when `live.length > 0`. The queued chip moved to `marginLeft: 'auto'` so it
still sits right when it's the row's only child, and the whole tier is skipped when there's
neither. Card heights stay equal (grid stretch) and footers stay aligned — the existing
`drive-gallery-cards` assertions still pass unchanged.

## E. ⌘K palette

Archived projects get `<path> · previous` as their detail, plus a `Restore <name> to active`
action. `restoreProject` added to the memo's deps.

## Traps

1. **`drive-gallery-cards.mjs` rescoped** to `[data-project-card]` (every selector, not just
   line 13) with a comment saying why. Also rescoped the same three selectors in
   `drive-theme-pass.mjs`.
2. Muted-opacity guard green — the two hover reveals go `0 → 1`.
3. No colour-changing border anywhere new: the row has no border at all (measured
   `border-top-width: 0px` in all six palettes) and hovers on background only.

---

## Decisions I had to make

1. **The Previous row's `⋯` menu is reduced** to Reveal in Finder / Project Claude files /
   Restore to active / Forget project. A 30px row has nowhere to host the rename input or the
   description textarea, and both verbs come back the instant the project does. Commented in
   place.
2. **The card's archive verb reads off `project.archivedAt`, not off which list drew it.** An
   archived project with a live session is auto-lifted onto the ACTIVE shelf and draws as a
   *card*, so a hardcoded "Archive project" there would have been a no-op the user could click
   forever. Driver step 9 pins this.
3. **`ACTIVE` gained a `· N of M` count while filtering** (the brief only specified it for
   PREVIOUS). Without it, "Projects · 10" sits above one visible card with nothing explaining
   the gap.
4. **No `WebkitAppRegion: 'no-drag'` on the filter input.** That's an Electron property and
   Electron is gone; this app drives dragging itself, and `DragRegion.tsx:27` already exempts
   `input` from starting a drag. Verified rather than assumed — the driver types into the field
   and the filter works.
5. **Section labels align with the card grid's left edge; the chevron aligns with the rows'
   right edge** (`padding: '4px 10px 9px 2px'`). Right-aligning the chevron to the container
   while the rows were 10px inset looked like a misprint.

## One concern with the spec, implemented as written

`showFilter` gates on `active.length > FILTER_THRESHOLD`, per the brief. But the brief's own
rationale for the filter is *"how you find something you shelved without building a separate
archive screen"* — and that rule removes the filter exactly when the Previous shelf grows. A
store of 4 active + 15 shelved has no way to search. One-word fix if you want it
(`projects.length > FILTER_THRESHOLD`, which is also what the switcher uses); I left it alone
rather than quietly widening the spec.

## Surprises

- **`previousExpanded` needed no reset wiring** — see C above. The brief expected code at
  `DashboardView.tsx:411`; unmounting already does it.
- **`drive-gallery-cards` never broke** on the `[role="button"]` trap in practice, because the
  fixture has nothing archived, so no Previous rows exist for it to pick up. Fixed anyway — it
  would have broken the first time anyone archived inside a driver, which is exactly what the
  new script does.
- The mock's `saveProjects` is a noop and `loadProjects` always returns the fixture, so
  "archive it, restart, still shelved" was untestable. The new driver wraps both through a
  `harness.projects` localStorage key — a stand-in for `projects.json` — and pads the store to
  11 so the >8 filter threshold is reachable at all (the real store has 19).

---

## Verification

- `npm test` — **258 passed / 34 files**, muted-opacity guard included.
- `npm run build` (`tsc && vite build`) — clean.
- `node dev/drive-gallery-cards.mjs` (rescoped) — all 7 checks pass; heights still equal,
  footers still aligned, hover still shifts nothing.
- `node dev/drive-navigation.mjs` — all 11 checkpoints pass, unchanged.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**. New probes:
  shelf headers 4.16–7.03, previous row name 6.99–11.04, path/last-ran 4.16–7.03 (meta floor
  3.0). Row hover is `border-width 0px` + background only in every palette.
- `node dev/drive-roster.mjs`, `drive-task-lifecycle.mjs`, `drive-contrast-cards.mjs` — pass,
  no contrast regressions.
- **`node dev/drive-gallery-shelf.mjs` (new)** — 9 scenarios, all green:
  zero chrome at rest → archive + undo toast → collapsed Previous → row geometry (h30,
  "last ran 2d ago", no border) → hover reveal 0→1 with no reflow → filter across both shelves
  incl. auto-expand and `No match.` → restore from the row → **archive survives a reload** →
  Forget arms on click 1 / fires on click 2 / undo restores → **auto-lift: all 11 records
  stamped `archivedAt`, the 2 with live sessions still draw as cards**, and that card's menu
  offers `Restore to active`.

## Not verified by a driver

The `NothingActive` block (`active.length === 0 && previous.length > 0`). The fixture always
has two live sessions, so the auto-lift correctly keeps two projects on the active shelf and
the state is unreachable there. It's a static block; worth an eyeball on the real store.

Your remaining manual check from the brief — archive on the real 19-project store, restart the
app, launch into a shelved project — is the one thing the mock can't stand in for.
