# Worktree gutting guard — 2026-09-25

Brief: prevent a repeat of the gutted `mantel-55da80` (Review: `dev/results/mantel-55da80-gutted-2026-09-25.md` in the main checkout). What happened there: a coordinator ran `gh pr merge N --squash --delete-branch` from the main checkout. gh 2.100 then ran `git worktree remove` on the linked worktree where lane t2 had the PR's branch checked out, and a dev server made that fail halfway.

Branch `operator/d91080`, one commit per item. Not merged, not verified in the running app.

## (1) Launch note — 32a6a68

`BRANCH_SAFETY_NOTE` in `src/renderer/lib/roster.ts` is part of the orchestration note built at every launch, so it reaches customised charters too. It is not in `DEFAULT_ROLE_PROMPTS`. Text:

> Git: `gh pr merge --delete-branch` also removes any linked worktree that has that branch checked out, another lane’s included. If another lane may have it checked out, merge without `--delete-branch` and delete only the remote branch (`git push origin --delete <branch>`). Start a new feature branch in a fresh Operator worktree (a new lane), not with `git checkout -b` in an existing one.

Who gets it:
- **The coordinator.** It merges PRs, and it was the coordinator that ran the merge.
- **Worker lanes launched in their own worktree.** They branch; t2's `git checkout -b` inside its home worktree is what put that directory in the merge's path.
- **Not lanes in the shared main checkout.** They are already told not to commit or switch branches.

The note costs about 390 characters. Two size guards were raised for it, each with the reason recorded in the test:
- `roster.test.ts`: 3400 → 3800. The coordinator note goes from 3374 to 3764.
- `lane-workspace.test.ts`: 3300 → 3700. A Code lane with its own worktree comes to 3615.

## (2) Detection — 2f62c9f

The new `electron/src/main/checkout-health.ts` holds a `CheckoutWatcher` in main.

**When it checks:**
- On lane output, at most once per 20 s per lane, because the data sink calls `noteActivity`. That is not per keystroke.
- On the existing ten-minute sweep (`sweepTimer`, next to `sweepAbandoned`). This is what catches a lane that has gone idle: t2 was idle when its checkout was removed.

**What counts as removed:**
- `<cwd>/.git` is a file, but the admin entry it names no longer exists. That is the half-failed removal: git deleted its record, and the directory survived.
- `<cwd>/.git` is missing. This only counts where a linked worktree was known to be: this watcher saw it healthy, or the cwd sits directly in `~/.operator/worktrees`. A lane in a plain directory or a main checkout is never flagged.

**Branch name:** taken from the admin entry's `HEAD` the last time the checkout was seen healthy. The renderer falls back to the branch the tab was launched on.

**What happens then:**
- **Surfaced.** A new entry goes to the renderer over `onCheckoutGone`, as the full list. `checkoutGoneList` returns the current list after a renderer reload.
- **Announced once** as an error toast.
- **Lane header.** The lane's `SessionToolbar` shows the chip "Checkout was removed outside Operator · <branch>", in red ink with no fill. Its tooltip says what was lost and what was not, and that nothing is repaired.
- **Logged** to stderr and to `~/.operator/checkout-gone.log`: `t2: checkout at … was removed outside Operator (branch …): its .git file is missing. Not repaired.`
- **Dropped** when the lane's pty exits, when the lane is no longer live at a sweep, or when the checkout comes back.

**No auto-repair**, as the brief says.

## Tests

- **`electron/src/main/checkout-health.test.ts`** (11 tests; real git, sandboxed `OPERATOR_DIR`):
  - pure `judgeCheckout` and `branchFromHead`
  - **the incident reproduced**: `git worktree remove --force` run from the source repo on a live lane's worktree (gh 2.100's removal) is reported once, with the branch the lane had switched to, and the log line is written
  - the half-failed shape: admin entry deleted, directory left
  - a folder in the worktree root never seen healthy is still reported
  - a main checkout and a plain directory are never reported
  - the entry is dropped on restore, on lane end, and when the lane is no longer live
  - the activity throttle holds at 20 s
- **`src/renderer/lib/checkout-gone.test.ts`** (3 tests): only new entries are announced; branch fallback; the wording.
- **Launch note:** `roster.test.ts` (the coordinator gets it) and `lane-workspace.test.ts` (a worktree lane gets it, a shared-checkout lane does not).

## Verification

- `electron`: `npm run typecheck` exit 0; vitest 42 files, **738 passed**.
- Root: `tsc --noEmit` exit 0; vitest 102 files, **1529 passed**.
- Not verified in the running app: the toast and header chip have not been seen on screen.

## Left out, and recommended

- **Review's other recommendation:** add the live-pty refusal (`ptyClaimOn`) to `mergeBranch` and `discardBranch` (`worktree.ts`). Those paths can rename a live lane's cwd from the review UI. Not in this brief; recommended for Code.
- **Existing mantel lanes:** the mantel coordinator's own memory or recipe (`| tail -1` hid gh's message). The launch note reaches it on its next launch only.
- **Bare `git worktree prune` by lanes** (Review recommendation 4). Not added to the note, to keep the note short.
