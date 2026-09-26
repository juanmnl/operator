# Infra preset and charter tightening — 2026-09-25

Branch `operator/d91080`. Files: `src/renderer/lib/roster.ts`, `src/renderer/lib/prune-seeded-lanes.ts`, `src/renderer/lib/lane-accents.ts` (comment), `src/renderer/lib/dispatch.ts` (comments), `src/renderer/views/DashboardView.tsx` (migration wiring), plus `roster.test.ts`, `prune-seeded-lanes.test.ts`, `lane-accents.test.ts`.

## Infra preset

Appended last in `rolePresets()`: `{ id: 'infra', name: 'Infra', model: 'opus', effort: 'high', useWorktree: true, accent: '#2dd4bf' }`.

Accent `#2dd4bf` (teal), chosen by measurement across all six palettes:

- Raw: at least ΔE*ab 39.7 from every existing preset accent. The existing six are at least 34.4 apart from each other.
- After the light themes' `--lane-ink-blend` (the colour lane text is drawn in): at least 14.4 from every preset. The existing six are at least 11.4 apart.
- Contrast as text: at least 5.70:1 on every lane surface in every theme. `lane-accents.contrast.test.ts` passes with it.
- At least ΔE 38.9 from every one of the six extra swatches in the picker.

## Charters, old → new

All texts below omit the `NO_COMMISSIONING` suffix, which is unchanged and still appended to every worker charter. The Operator and Research charters were not changed. I found no concrete problem with Research: it runs in the shared checkout and its charter already says "never change code".

### code

Old:

> Implement the task, nothing more. Read the surrounding code first and match its idiom — naming, comment density, error handling; no drive-by refactors. Run the project’s typecheck and tests before calling anything done, and report exactly what changed and why, plus anything you deliberately left out.

New:

> Implement the task, nothing more. Read the surrounding code first and match its idiom — naming, comment density, error handling; no drive-by refactors. Run the project’s typecheck and tests before calling anything done, and state the results with their output. Commit your work on your branch with a message that says why. Report exactly what changed and why, plus anything you deliberately left out.

Why: Code runs in its own worktree, and `worktree_done` refuses uncommitted work, so the charter now says to commit on the branch with a message giving the reason. "Run the tests" did not require showing the result, so it now asks for the results with their output.

### review

Old:

> Review adversarially — find real defects, don’t fix them unless asked. Read the full diff plus enough surrounding code to judge it: edge cases, races, security, regressions, misleading names. Rank findings by severity with file:line and a concrete failure scenario for each. If an area is clean, say what you checked so silence isn’t ambiguous.

New:

> Review adversarially — find real defects, don’t fix them unless asked. You run in the main checkout and cannot see a lane’s worktree, so review the branch, commit or diff your brief names (`git diff main...<branch>`); if it names none, say so rather than reviewing whatever is checked out. Read the full diff plus enough surrounding code to judge it: edge cases, races, security, regressions, misleading names. Rank findings by severity with file:line and a concrete failure scenario for each. If an area is clean, say what you checked so silence isn’t ambiguous.

Why: Review runs in the main checkout with `useWorktree: false` and cannot read a lane's worktree. The old charter said "read the full diff" without saying which one, so Review could end up reviewing whatever `main` held. It now reviews the branch, commit or diff the brief names, using `git diff main...<branch>` (branches are shared across worktrees, so this works from the main checkout), and says so when the brief names none.

### design

Old:

> Own UI/UX quality. Reuse the project’s design system — its variables, spacing, and components — and never hardcode values that tokens already define. Propose the plan (what/where/why) before big visual changes; implement small polish directly. Verify both light and dark themes plus empty, loading, and overflow states.

New:

> Own UI/UX quality. Reuse the project’s design system — its variables, spacing, and components — and never hardcode values that tokens already define. Propose the plan (what/where/why) before big visual changes; implement small polish directly. Verify in the running app (Preview or a screenshot), not only by reading code, across light and dark themes plus empty, loading, and overflow states, and state which themes and states you actually checked.

Why: The old charter said "verify both themes", and that could be satisfied by reading CSS. It now asks for verification in the running app (Preview or a screenshot) and for a statement of which themes and states were actually checked.

### qa

Old:

> Verify behavior, don’t assume it. Reproduce issues first and write down exact steps, then add automated tests that fail before the fix and pass after. Probe what the happy path misses: empty input, rapid repeats, cancellation, restart. Finish with a pass/fail rundown of everything you exercised and precise repros for anything broken.

New:

> Verify behavior, don’t assume it. Reproduce issues first and write down exact steps, then add automated tests that fail before the fix and pass after — in the shared checkout, specify them instead of editing files. Probe what the happy path misses: empty input, rapid repeats, cancellation, restart. Finish with a pass/fail rundown of everything you exercised, saying for each how (tests run, app driven, or code read), and precise repros for anything broken. Never claim GUI verification you did not do.

Why: Two problems. (1) QA claimed passes without saying how it exercised them, so a code read could be reported as verified. It now names the method per item and must not claim GUI verification it did not do. (2) QA runs in the shared main checkout, whose launch note (`SHARED_CHECKOUT_NOTE`) forbids editing tracked files, while the old charter told it to add automated tests. That was a direct contradiction. It now specifies the tests when it is in the shared checkout. This second fix goes slightly beyond the brief's QA bullet. It falls under "wrong for how lanes actually run today" and is flagged here in case you want it reverted.

### infra

Text:

> Own build, CI, release and environment — make it reproducible, never surprising. That covers build and packaging, CI workflows, the release and updater pipeline, dev servers and ports, env vars, dependencies and scripts. Dry-run or read before you change anything. Never push, tag, publish a release, deploy, rotate or regenerate keys, delete remote resources, or take any other outward-facing or irreversible step unless the brief gives the user’s explicit go-ahead for it. Report the exact commands you ran and their output.

Why: New preset. The first sentence is the purpose line the brief specified; `laneSummary` shows it in the coordinator's team list as `"Infra" (id: infra, Opus) — Own build, CI, release and environment — make it reproducible, never surprising.`

## Migration

- `LEGACY_ROLE_CHARTERS` in `roster.ts` freezes the replaced wording for code, review, design and qa. A script comparing it against `HEAD`'s `DEFAULT_ROLE_PROMPTS` matched byte for byte; the script was not committed.
- `migrateStockCharters(project)` replaces a lane's prompt with today's text only when the prompt equals an old stock wording for that same role id, with or without `NO_COMMISSIONING`. Customised charters, custom lanes, lanes with no prompt, and Operator/Research are left alone. It returns the same object when there is nothing to change, like the other hydrate migrations.
- Wired into `DashboardView` in two places. (1) The hydrate `reconciled` chain, so the rewrite of `projects.json` goes through the same backup-first path as `clearSeededRoleFields`. (2) The localStorage first-paint seed, next to `migrateProjectEfforts`.
- `stockPrompts()` in `prune-seeded-lanes.ts` still recognises the old wordings (via `legacyStockCharters`), so the prune reaches the same verdict on a lane before and after the migration. A test covers both.

## Other places that assumed six presets

- `lane-accents.test.ts`: the default accent count is now 7.
- `roster.test.ts`: the `reorderRoles` expectations include `infra`. The note-size ceiling is raised from 3300 to 3400 with a stated reason: the coordinator note went from 3261 to 3374 because its team list has one more line. The guard now covers every preset's note, not only Code's; the longest lane note is Review at 3253.
- `prune-seeded-lanes.test.ts`: the fixture for pre-2026-07-28 seeded projects is now the six ids that were actually seeded. `rolePresets()` now includes Infra, which was never seeded. The prune counts (5 per project) are unchanged.
- Comments saying "six" about the preset set were updated in `roster.ts`, `lane-accents.ts`, `dispatch.ts` and `DashboardView.tsx`. Comments that describe the historical six-lane seeding, and the unrelated six palettes, were left as they are.

## Verification

- `npx tsc --noEmit -p .`: exit 0. `electron/`: `tsc --noEmit -p tsconfig.renderer.json` and `-p tsconfig.json` both exit 0.
- `npx vitest run`: 101 files, 1512 tests passed. The run before these test updates had 7 failures, all from six-preset assumptions.
- Not GUI-verified. I did not launch the app, did not check that Infra shows up in "+ Add agent" or on the board, and did not run the migration against a real `~/.operator/projects.json`.

## Deliberately left out

- The Operator charter, as instructed. The coordinator already routes by each lane's first sentence, so Infra reaches it through the team list with no change to the coordinator charter.
- The Design charter's wording about committing. Design also runs in a worktree, and the launch note (`WORKTREE_DONE_NOTE`) already tells it to commit before `worktree_done`.
