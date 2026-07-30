# Review the uncommitted working tree before Code lands on top of it

**Why now:** the tree holds ~1600 changed lines across 42 files, spanning **three unrelated
features**, none of it reviewed or committed. Five Code tasks are queued to land on top. If any of
them regresses something, bisecting a tangle of three features plus five fixes will be painful.

State as of dispatch: `tsc --noEmit` clean, `npm test` 28 files / 200 tests green. So this is not a
"does it compile" pass — it is a defect hunt.

## What is in the tree

1. **Project-first navigation** (shipped in-tree 2026-07-27) — `ProjectGallery`, `ProjectSwitcher`,
   scoped `Sidebar` (rewritten, ~900 lines changed), `DashboardView` (~420), `project-status.ts`
   + tests, `SessionItem`, `SidebarRail`, `key-routing`. Spec: `dev/project-first-navigation.md`.
2. **Settings `PageShell` pass** (2026-07-28) — new `components/settings/PageShell.tsx` adopted by
   `PrefsView`, `FolderPreferencesView`, `AgentsHubView`, `AgentLibraryView`; `UsageView.tsx`
   deleted. Spec: `dev/settings-page-template.md`.
3. **Toolbar + composer polish** — `SessionToolbar`, `SidebarRail`, and `ChatComposer`'s free-typed
   "Other…" model id. Harness: `dev/drive-toolbar.mjs`.

## Where to look hardest

These are the seams where this particular tree is most likely to be wrong — not a generic checklist:

- **Hydration order in `DashboardView`.** `activeProjectId` must be validated against the store only
  AFTER `savedHydrated`; checking earlier drops a valid scope while `projects.json` is still the
  localStorage seed. Confirm that ordering actually holds in the committed code, including on the
  pty-re-attach path after a webview reload (the "focus implies scope" backstop effect).
- **`UsageView.tsx` is deleted.** Verify nothing references it, no dead route or menu entry remains,
  and that deleting it was intentional rather than collateral from another lane. It is staged `D`
  while everything else is unstaged, which is itself worth a look.
- **`PageShell` adoption.** Four views were converted at once. Check they genuinely share the shell
  rather than each keeping a private variant, and that the full-width-scroller / inner-measure-box
  split survived (a `maxWidth` on the scrolling element parks the scrollbar mid-window).
- **The muted-opacity rule.** Stacking `opacity` on `var(--fg-muted)` measures 1.8–2.9:1 and is
  invisible on the three light palettes. The settings spec says these pages violated it in ~8 places
  and that the template fixes rather than cements it. Verify that actually happened.
- **`ChatComposer` "Other…"** — a free-typed model id goes to the pty as `/model <id>` with no
  local validation. Check the draft-clearing effect covers every close path, and that an empty or
  whitespace id cannot be submitted.
- **Duplicated hover-card logic** in `SessionItem` / `SidebarRail` — a known live defect
  (`dev/briefs/hover-card-stuck.md`). Do not fix it; just confirm the review's picture matches.

## Constraints

- **Do not fix anything.** Report defects; Code owns the fixes. If something is a one-line obvious
  correctness bug, say so and let it be scheduled.
- Rank by severity and say plainly which findings should block committing versus which can follow.
- Write to `dev/review-working-tree.md`.
- If the tree changes under you (Code is working in parallel), note what you reviewed —
  `git stash list` / a `git diff` hash beats "the tree as of now".

## The actual question to answer

**Can this be split into three clean commits and landed as-is, or is something in here broken?**
That is the decision this review exists to unblock.
