# Review — uncommitted working tree on `main`

**Date:** 2026-07-28 · **Reviewer:** Review lane
**Reviewed against:** `/tmp/operator-shots/tree-snapshot-5caba7c.diff` (sha1 `3c6e327ae852`, 4510 lines, 28 files),
pinned by `dev/briefs/COORDINATION.md`. HEAD `5caba7c`.

**Drift check:** the snapshot is **byte-identical** to `git diff` at review time — no tracked file moved
under me. Every finding below reproduces against both the snapshot and the live tree.

**Verified green at review time:** `tsc --noEmit` exit 0; `vitest run` 29 files / 215 tests passed
(the brief said 28/200 — the tree gained a file and 15 tests since dispatch).

---

## 0. Two corrections to the brief before the findings

**(a) The snapshot covers ~⅔ of the tree.** It was produced with `git diff`, not `git diff HEAD`, so it
excludes:

- the **staged** `UsageView.tsx` deletion (243 lines), and
- **all 13 untracked new files** (1972 lines) — including `ProjectGallery.tsx` (589),
  `ProjectSwitcher.tsx` (173), `PageShell.tsx` (144), `project-status.ts`, `task-lifecycle.ts` and
  their tests.

Two of the three headline new components are not in the pinned diff. I reviewed those from disk and
have noted it on each finding that touches them — they are the ones most likely to have drifted if
Code is working now.

**(b) There are five work-streams in this tree, not three.** The brief lists project-first navigation,
the PageShell pass, and toolbar/composer polish. The tree also contains:

4. **Task lifecycle** — `lib/task-lifecycle.ts` + tests, the startup reconcile in `DashboardView`,
   `queuedCountsByRole` in `RosterPanel`, the `unconfirmed` row in `TaskQueue`,
   `ProjectTask.reconciledAt` in `shared/types.ts`.
5. **Submit-queue nudge scaling** — `lib/submit-queue.ts` +37 / `submit-queue.test.ts` +135.

**This matters for coordination:** `COORDINATION.md` marks `lib/submit-queue.ts (+test)` as **clean**
and assigns it to Code task 1 ("dispatch split"), and assigns task lifecycle to Code task 2. Both are
**already implemented in the working tree** (`nudgeDelayFor`, `SUBMIT_NUDGE_PER_1K_MS`,
`reconcileStaleRunning`). If Code starts task 1 or 2 from the brief it will either duplicate or
conflict with unreviewed work already sitting here. Worth correcting the ownership table before Code
picks up.

---

## Verdict on the actual question

> **Can this be split into three clean commits and landed as-is, or is something in here broken?**

**It splits cleanly — into five commits, not three — but it must not land as-is.** There is one
crash-class defect (§1) that is reachable through a brand-new UI affordance shipped in this same
tree, and one visually-confirmed layout regression (§2). Everything else can follow.

Suggested split, in dependency order — each is self-contained and the seams are clean:

| # | Commit | Files |
|---|---|---|
| 1 | submit-queue nudge scaling | `lib/submit-queue.ts` + test, `dev/drive-dispatch.mjs` |
| 2 | task lifecycle | `lib/task-lifecycle.ts` + test, `shared/types.ts`, `TaskQueue`, `RosterPanel`, the reconcile block in `DashboardView` |
| 3 | project-first navigation | `ProjectGallery`, `ProjectSwitcher`, `Sidebar`, `SidebarRail`, `SessionItem`, `project-status.ts` + test, `key-routing`, `format.tildePath`, `operator-bridge.revealPath`, `env.d.ts`, most of `DashboardView` |
| 4 | PageShell pass | `settings/PageShell.tsx`, `PrefsView`, `FolderPreferencesView`, `AgentsHubView`, `AgentLibraryView`, `InstructionsSection`, `UsageView` deletion |
| 5 | toolbar + composer polish | `SessionToolbar`, `ChatComposer` |

Commits 1, 2 and 5 are clean as far as I can see. **Fix §1 before landing commit 3, and §2 before
landing commit 4.**

---

# Findings, ranked

## §1 — P0 · Infinite render loop → `Maximum update depth exceeded`

**Blocks committing.** `src/renderer/views/DashboardView.tsx:838-841` and `:847-851`.

Two new effects can drive each other forever. They disagree about what `activeProjectId` should be
whenever a **focused terminal carries a `projectId` that is not in `projects`**:

```
:838  // validation — scope must exist in the store
      if (!projects.some(p => p.id === activeProjectId)) setActiveProjectId(null)

:847  // "focus implies scope" backstop
      if (tab?.projectId && tab.projectId !== activeProjectId) setActiveProjectId(tab.projectId)
```

They alternate: validation clears the scope → the backstop restores it from the tab → validation
clears it again. Neither has a guard against the other, so React hits its 50-nested-update ceiling
and throws. The `localStorage.setItem('operator.activeProjectId', …)` effect at `:828` fires on every
cycle too.

**Concrete failure scenario** — every step is a shipped affordance in this tree:

1. Open a project, launch a lane. Session `t1` gets `projectId: P`.
2. `⌘⇧O` to the gallery. On `P`'s card, `⋯` → **Forget project**
   (`ProjectGallery.tsx:459` → `forgetProject`, `DashboardView.tsx:469`).
   `forgetProject` removes `P` from `projects` and nulls the scope — but it leaves `t1` in
   `terminals` still stamped `projectId: P`. Nothing reconciles that.
3. `t1` is still listed in the gallery's activity view (the rollup chip →
   `ActivityDashboard`, wired at `ProjectGallery.tsx:128`) and in the `⌘K` palette. Click it.
4. `handleSelectSession` (`:1275-1292`) sets `activeProjectId = P` **and**
   `activeTerminalId = t1`. Both effects now have work to do → loop → crash.

**Why it isn't caught today:** at the gallery `activeTerminalId` is always null (`handleShowGallery`
nulls it at `:400`), so the backstop early-returns and step 2 alone looks fine. The loop only arms
once something re-focuses one of the orphaned sessions.

**Root cause, stated separately from the symptom:** `forgetProject` deletes the project record but
not the `projectId` references on `terminals` and `savedSessions` (which persist it — see the
`operatorFields` write at `:1337`). Fixing only the effect ping-pong leaves dangling scope ids in
`sessions.json`.

*(This finding spans snapshot-covered code (`DashboardView`) and untracked code (`ProjectGallery`).)*

---

## §2 — P1 · `AgentLibraryView` inside `PageShell`'s scroller collapses the split pane

`src/renderer/components/agents/AgentsHubView.tsx:149`, `settings/PageShell.tsx:127`,
`agents/AgentLibraryView.tsx:145,167,199`.

`AgentLibraryView` documents this exact constraint in its own comment at `AgentLibraryView.tsx:146-151`:

> *"It wears PageShell's TOKENS rather than PageShell itself: the shell's body is a single scroller
> with a measure box, and this page's body is a two-pane list+editor where each column scrolls on its
> own — **wrapping that in the shell's scroller would break the panes** and re-inset their scrollbars."*

`AgentsHubView.tsx:149` then renders `<AgentLibraryView embedded />` as `PageShell`'s **children**,
i.e. inside `<div style={{...measureBox, padding: '20px 24px 40px'}}>` (`PageShell.tsx:127`) — a plain
**block** container inside the `overflow: auto` scroller. So:

- `flex: 1` on the library's root (`:145`) is inert (no flex parent) → the root gets `height: auto`.
- The two-pane row (`:167`, `flex: 1; minHeight: 0`) therefore has no definite height, so both
  columns' `overflow: auto` never engages — they grow to content and the outer shell scroller
  scrolls the whole thing as one page.
- The empty state's `height: '100%'` (`:199`) resolves against an auto-height parent and collapses,
  so "Select an agent to edit" is no longer centred in the pane.
- The library also inherits the 1100 cap + 24px padding the comment says must not be there.

**Confirmed visually** in `/tmp/operator-shots/pageshell-library.png`: the list column's `borderRight`
divider stops ~318px down instead of running the page height, and the empty-state copy sits at the
top of the right pane rather than centred.

The brief asked whether "the full-width-scroller / inner-measure-box split survived." It survived in
`PageShell` itself (`:88` scroller full width, measure on the inner boxes — correct, and the sticky
header at `:92` shares the containing block, which is the right fix for the 3px scrollbar drift).
It did **not** survive the library's adoption.

*(Untracked file — not in the pinned snapshot.)*

---

## §3 — P1 · The project switcher can't be closed by clicking its own header

`src/renderer/components/sidebar/Sidebar.tsx:238`, `sidebar/ProjectSwitcher.tsx:34`.

The sidebar header is a toggle (`onClick={() => onSwitcherOpenChange(!switcherOpen)}`). The popover
closes itself on any outside **`mousedown`** (`ProjectSwitcher.tsx:34`). The header is outside the
popover's ref, so clicking it while open runs:

1. `mousedown` → popover's outside handler → `switcherOpen = false`. React flushes discrete events
   synchronously, so the header re-renders with `switcherOpen === false`.
2. `click` → header toggle reads the **new** prop → `onSwitcherOpenChange(true)`.

Net effect: the popover flickers closed and immediately reopens. There is no way to dismiss it from
the control that opened it — only Esc, an outside click, or `⌘⇧P`. `⌘⇧P` is unaffected (it goes
through the window keydown handler, and the popover's capture listener only claims Escape).

*(`Sidebar.tsx` is in the snapshot; `ProjectSwitcher.tsx` is untracked.)*

---

## §4 — P1 · `galleryTab` is never reset, so "All projects" can land on a page with no projects

`src/renderer/views/DashboardView.tsx:141` (state), `:400` (`handleShowGallery`).

`galleryTab` is module-lifetime state that nothing resets. Open the gallery, click the rollup chip to
read the cross-project activity view, enter a project — then `⌘⇧O`, the logo, or the switcher's
"All projects…" all return you to `contentMode === 'gallery'` **still on the activity tab**. The
project grid the command names is not shown.

It is escapable (the header's `‹ Projects · N` back button at `ProjectGallery.tsx:101` persists), so
this is a papercut rather than a trap — but "All projects" not showing all projects is the one thing
that command must do. Either reset `galleryTab` in `handleShowGallery`, or treat the activity view as
a push rather than a tab.

---

## §5 — P2 · The muted-opacity rule: page chrome fixed, section bodies untouched, four new violations added

The brief asked whether the template *fixed* rather than *cemented* the ~8 violations. **Partly, and
the count is exact.**

**Fixed** — `PrefsView` (5 section descriptions moved to `sectionDesc`, which carries no opacity),
`AgentsHubView:104`, `FolderPreferencesView`'s header, `AgentLibraryView:455`,
`InstructionsSection:67`. `PageShell`'s tokens (`pageSubtitle`, `sectionDesc`) are opacity-free by
construction, and `sectionHeader` correctly moved from `--fg-muted` to `--fg`.

**Not fixed — exactly the 8 the spec meant.** They live in the *section* components rendered inside
`FolderPreferencesView`'s new shell, none of which this tree touches:

| File | Lines | Stacked opacity |
|---|---|---|
| `preferences/PluginsSection.tsx` | 35, 38, 48, 74 | 0.5, 0.4, 0.6, 0.5 |
| `preferences/HooksSection.tsx` | 23, 28 | 0.7, 0.5 |
| `preferences/GeneralSection.tsx` | 70 | 0.7 |
| `preferences/ListEditor.tsx` | 40 | 0.5 |

The template fixed the page header and left the page body violating the rule — so the *worst* case
(`--fg-muted × 0.4`, the 1.8:1 measurement) is still shipping, one level below the new shell.

**Four new violations added by this tree** (all in the snapshot, all `+` lines):

- `sidebar/Sidebar.tsx:267` — `--fg-muted` × 0.7 on the `⌄` switcher affordance
- `sidebar/Sidebar.tsx:317` — × 0.8 on the roster `+` icon
- `sidebar/Sidebar.tsx:336` — × 0.7 on the *"No agents yet — add one on the roster."* empty state.
  **This is the worst of the four** — it is body copy carrying the only instruction on an empty
  sidebar, held to a decoration-tier contrast.
- `sidebar/SidebarRail.tsx` (snapshot line 3226) — × 0.85 on the project badge

Ironically `Sidebar.tsx:273` carries a comment explaining why the path below it *doesn't* stack
opacity, six lines after `:267` does.

Worth a `dev/drive-theme-pass.mjs` run over the three light palettes before commit 3 and 4 land.

---

## §6 — P2 · `completeTerminalTasks`' widened roleId fallback can close and mis-attribute an unrelated task

`src/renderer/views/DashboardView.tsx:599-615`.

The fallback correctly stopped requiring `!t.terminalId` (that was the leak). But it now matches *any*
running task for the same `roleId` whose stamped terminal isn't live:

```js
t.status === 'running' && (
  t.terminalId === terminalId
  || (!!roleId && t.roleId === roleId && (!t.terminalId || !liveIds.has(t.terminalId)))
)
```

**Failure scenario:** lane `code` runs task A on pty `t1`. `t1` dies mid-run without going through
`handleCloseSession` (crash, or the pty is reaped), so A stays `running` with a dead `t1` and the
startup reconcile has already happened this run. The user relaunches `code` as `t2`, which runs task
B. When `t2` finishes, A matches the fallback and is closed alongside B — and because
`attachTaskDiffStats`/`runTaskChecks` (`:631,633`) are keyed on the matched *set*, **A is stamped with
`t2`'s diff and `t2`'s check result**. A gets a completion record and a `doneAt` (not a
`reconciledAt`), so the `unconfirmed` marker that `TaskQueue` was built to show never appears for it.

Narrow window and much better than the leak it replaces, but the mis-attribution is silent. Scoping
the fallback to a single most-recent match, or stamping `reconciledAt` on fallback-matched tasks,
would both close it.

---

## §7 — P2 · Hover cards: the brief's picture is correct

Confirming only — **not fixed here**, per instruction.

- `sidebar/SessionItem.tsx:73-108` **is** hardened: `syncHover` re-verifies with
  `document.elementFromPoint` after every render and on capture-phase `scroll`, plus a window
  `mousemove` to keep `pointerRef` fresh. That covers rows moving under a stationary cursor.
- `sidebar/SidebarRail.tsx` still holds `useState<{id, top, left} | null>` driven by bare
  `onMouseEnter`/`onMouseLeave` with **no hardening at all**. Same card, same failure.

One efficiency note for whoever takes the fix: `useEffect(syncHover)` at `SessionItem.tsx:96` has no
dependency array by design, so while a row is hovered it calls `elementFromPoint` — a forced layout —
on **every** render of that row, and the sidebar re-renders on every `session:update`. Worth a cheap
rect check before the hit-test.

---

## §8 — P3 · Smaller items

- **`RosterPanel.tsx:547`** — comment states *"the Usage & cost view still reports it."* That view was
  deleted in this same tree. Stale by one commit, in a file Code is about to edit.
- **`UsageView` deletion is otherwise clean.** No dangling import, route, palette action, menu entry
  or `contentMode` branch survives — I grepped `.ts/.tsx/.mjs/.html/.rs/.json` across the repo.
  Two consequences worth a decision rather than a fix: `format.ts`'s `fmtCost`/`fmtTokens` now have
  no production caller (only `format.test.ts`), and `src-tauri/src/usage.rs` + the `UsageSummary`
  types in `shared/types.ts:422` are now backend with no frontend. Intentional-looking (the
  `AgentLibraryView.tsx:33` comment says spend reporting is gone on purpose), just now dead weight.
- **`ProjectSwitcher.tsx:49,141`** call `.localeCompare` / `relativeTime` on `p.lastActiveAt`
  unguarded, while `ProjectGallery.tsx:446` guards the same field (`? … : 'never opened'`). The type
  makes it required, so this is only a latent inconsistency — but if it is ever absent the switcher
  renders `NaNd ago` and the gallery renders correctly, which is a confusing pair to debug.
- **`FolderPreferencesView`** passes the raw `projectPath` as `PageShell`'s subtitle while everything
  else in the tree now runs paths through the new `tildePath` helper.
- **`Sidebar.tsx:234`** — `{ paddingTop: 40, padding: '40px 10px 8px 12px' }`. The shorthand comes
  second and overrides `paddingTop`; the values agree, so it's harmless, but the first key is dead.
- **`isAppChord`** (`lib/key-routing.ts:19`) claims `⌘⇧O`/`⌘⇧P` for the app but keys off
  `metaKey || ctrlKey`, so `Ctrl+Shift+O/P` are also claimed by `DashboardView`'s handler while — per
  that function's own doc comment — the terminal still forwards Ctrl variants to the pty. Neither
  chord is a common readline binding, so this is theoretical.

---

## What I checked and found clean

Stated explicitly so silence isn't ambiguous.

- **Hydration order (the brief's first concern) — correct.** The validation effect at `:838` is
  properly gated on `savedHydrated`, and `setProjects(pList)` / `setSavedHydrated(true)` are in the
  same continuation at `:810,823`, so the store is populated in the render where the gate opens. No
  window exists where a valid scope is dropped against the localStorage seed.
- **The reconcile's dependence on the pty set — correct, including on the re-attach path.**
  `setTerminals` runs in `.then()` (`:896`) and `setReattachDone` in `.finally()` (`:920`); `.then`
  always settles first, so whether or not React batches them, the render where `reattachDone` turns
  true already has the live tabs. The `live.length === 0` early return at `:894` still settles the
  flag. Cold start → empty `liveIds` → everything reconciles, which is the intent. A webview reload →
  surviving ptys keep their tasks `running`. `reconciledRef` correctly makes it once-only.
- **`ChatComposer`'s "Other…"** — both of the brief's questions come out clean. The draft-clearing
  effect keys on `menu !== 'model'` (`:92`) rather than enumerating close paths, and every path (pick,
  outside click, pill toggle, session switch) routes through `setMenu(null)`, so it genuinely covers
  all of them. An empty or whitespace id cannot be submitted: `submitCustomModel` trims and guards
  (`:165`), and the Set button is `disabled={!value.trim()}` (`:388`). `keepOpen` on the "Other…" item
  is the right mechanism — it doesn't leak into the other menus.
- **`PageShell` adoption is genuine.** All four views use the shared component; none kept a private
  header variant. `AgentLibraryView` is the one deliberate exception and says so — its problem (§2) is
  that the hub then wrapped it anyway.
- **`lib/task-lifecycle.ts`, `lib/project-status.ts`, `lib/submit-queue.ts`** — pure, well-commented,
  covered by tests, no state or clock dependencies beyond injected `now`. `reconcileStaleRunning`'s
  identity-preserving return (`:72`) correctly lets callers skip a write.
- **The `RosterPanel` "N QUEUED" fix is real** — `queuedCountsByRole` is the only source of the chip
  and of the `Launch N →` label (`RosterPanel.tsx:260,313,326,598,787`), and it filters on genuine
  `queued` status. The `unconfirmed` / `⋯` treatment in `TaskQueue.tsx:248` is the honest rendering of
  `reconciledAt` and does not claim verification.
- **Sidebar drag/drop** — the `dragRowRef` mirror of `dragRow` (`Sidebar.tsx:102-110`) is the correct
  fix for the fast-drag `dragover`/`preventDefault` race, and `commitDrop` reading the edge from the
  event rather than from state (`:186-190`) is right for the same reason. Lane vs ad-hoc rows are
  correctly prevented from cross-dropping.
- **`revealPath`** (`operator-bridge.ts:214`) swallows its rejection, and the gallery's menu item
  disables itself when the folder is lost — no unhandled rejection path.

---

## Recommended order for Code

1. **§1** — must land with (or before) the project-first-navigation commit. Both the effect ping-pong
   *and* the dangling `projectId` on `terminals`/`savedSessions` that `forgetProject` leaves behind.
2. **§2** — must land with the PageShell commit; it is a visible regression on a shipped screen.
3. **§3, §4** — same commit as (1); both are project-first-navigation defects.
4. **§5** — the 4 new violations with commit 3/4; the 8 pre-existing ones are a separate pass.
5. **§6, §7, §8** — follow-ups, no commit blocked.

**Before any of that:** correct the `COORDINATION.md` ownership table — `lib/submit-queue.ts` and
`submit-queue.test.ts` are modified in the tree, not clean, and Code tasks 1 and 2 are already
substantially implemented here.
