# Brief — Shelf step 3: the partition lands, and the gallery reorganises

Full approved plan: `/Users/juanmnl/.claude/plans/operator-the-research-lane-crispy-fox.md`

**Depends on step 1+2 (`dev/briefs/shelf-1-foundations.md`) being merged** — `lib/project-shelf.ts`
and `Project.archivedAt` must already exist.

This is the big one. Four things ship together, and the third is non-negotiable.

---

## A. Archive / restore in `DashboardView.tsx`

```ts
const archiveProject = useCallback((id: string) => { /* updateProject(id, { archivedAt: new Date().toISOString() }) + undo toast */ }, [...])
const restoreProject = useCallback((id: string) => { /* updateProject(id, { archivedAt: undefined }) */ }, [...])
```

- **Archive gets no confirm, but an undo toast.** Confirming a one-click-reversible action just
  teaches people to click through confirms — which is how you lose the confirm that matters.
  `Toast.tsx:9` already supports `action?: { label, run }` and **suspends auto-dismiss while an
  action is present** (`:72`), so the undo toast is free and doubles as discovery for the verb:
  `pushToast({ text: \`Shelved ${p.name}\`, action: { label: 'Undo', run: () => restoreProject(p.id) } })`
- **Auto-lift — the correctness keystone.** In `upsertProject`'s existing-project branch
  (`DashboardView.tsx:461`) add `archivedAt: undefined` to the spread. Because `upsertProject` is
  the single mutation point, this one line covers *every* revival path: session launch (`:1069`),
  `handleRestoreSession` (`:1268`), `openFolderAsProject` (`:511`), and background cwd resolution
  (`:911`). Without it a running agent can hide inside a collapsed section.
  Note in a comment: this also fires at boot for a pty that survived a restart, via `:911`. That
  is correct — it's live — but it looks like a mystery write if nobody wrote it down.
- **`handleOpenProject` must NOT unarchive** (`:385`). Browsing a shelved project is not a
  decision to un-shelve it. **Open ≠ revive, launch = revive** — that asymmetry is the whole
  ergonomics of the feature. Comment it so nobody "fixes" it later.
- Persistence needs no work: `archivedAt` is *not* in the omit-list at `DashboardView.tsx:1614`,
  so every archive/restore mutates `ser` and forces both the localStorage write and
  `saveProjects`. Rust is opaque `serde_json::Value` — zero backend changes.

## B. Fix `Forget project` — MANDATORY, same commit

`forgetProject` (`DashboardView.tsx:484-494`) is today a persisted delete of the project's roster,
tasks, dispatches, notes and defaults, **with no confirmation and no undo**. That is already the
filed house rule (`dev/briefs/lane-delete-is-destructive.md:46`), and the v0.10.0 lane-delete data
loss is the precedent. You are adding a new menu item **directly above it** — doing that while it
stays armed is how the second data-loss report gets written.

- **Click-again-to-confirm**, mirroring `SessionItem`'s `confirmingClose` (`SessionItem.tsx:82-92`):
  first click swaps the label to `Forget — click again`, arms a ~2500ms timer, second click fires.
- **Undo toast.** `forgetProject` captures a snapshot before destroying:
  ```ts
  type ForgottenSnapshot = { project: Project; terminalIds: string[]; savedKeys: string[] }
  ```
  then `restoreForgottenProject(snap)` re-adds the record and re-stamps the terminals/savedSessions.
- **TRAP:** `restoreForgottenProject` **must** call `forgottenProjectsRef.current.delete(id)`. That
  set is read at `:910` to suppress re-adoption during background cwd resolution; a restored
  project left in the set gets its terminals silently unstamped again and the undo half-works.

## C. The gallery — `components/dashboard/ProjectGallery.tsx`

```
┌ Projects · 6      [ 3 agents at work ]   [filter…]   + Open folder ┐  ← count = ACTIVE length
├────────────────────────────────────────────────────────────────────┤
│ ACTIVE                                    ← section headers ONLY when previous.length > 0
│ ┌─────────┐ ┌─────────┐ ┌─────────┐       ← card unchanged
│ PREVIOUS · 11                          ⌄  ← collapsed by default
│   uwazi_web     ~/Developer/uwazi_web     last ran 7w ago   ← rows, NOT dimmed cards
```

- Gains an `activities: Record<string, ProjectActivity>` prop (DashboardView already computes it at
  `:1433-1444` for the switcher). The local sort at `:71-84` dies → `partitionProjects`.
  **Keep the `liveByProject` map** — it does two jobs, and only the *sorting* job moves out; the
  cards still need it to give each orb its real `sessionWaveStatus`.
- **Header count reads the ACTIVE length**, both in the `<h2>` (`:105-107`) and the activity-tab
  back button (`:102`). The store total is no longer the honest headline.
- **Zero new chrome when nothing is archived** — if `previous.length === 0`, no section headers at
  all, and the gallery renders byte-identical to today.
- **Previous items are ROWS, not receded cards.** The house rule forbids receding a card with group
  `opacity` (it compounds and can't be overridden per-child), so a "quiet card" means hand-tuning
  every child's ink across 11 cards — the same wall of grey that produced "the gallery is awful".
  A row recedes *structurally*. Row spec: h30, `padding: '0 10px'`, hover `background:
  var(--overlay-subtle)` (background-only, `borderRadius` 6 — **no colour-changing border on a
  radiused element**, WKWebView freeze rule). Name 11.5px at
  `color-mix(in srgb, var(--fg) 80%, transparent)` (the `LaneRow` treatment, `Sidebar.tsx:584`);
  `tildePath(p.path)` 9.5 mono `--fg-muted`, flex, ellipsis; right `last ran 7w ago` 9.5 mono
  `--fg-muted`. Hover reveals `Restore` + `⋯`. Click = `onOpenProject`.
  Tag it `data-previous-row={p.id}` — **not** `data-project-card`.
- **Filter at `active.length > FILTER_THRESHOLD`** — slim input in the header row between the
  rollup chip and `+ Open folder`. It lives inside a `DragRegion`, so it needs
  `WebkitAppRegion: 'no-drag'`. **The filter searches BOTH shelves**: while the query is non-empty
  Previous auto-expands and its header reads `PREVIOUS · 3 of 11`. That is how you find something
  you shelved without building a separate archive screen — and why archiving is safe to do liberally.
- `⋯` menu (`:454-461`) gains a hairline separator then `Archive project` (or `Restore to active`),
  above the now-confirmed `Forget project`. `CardMenu` needs `separator?: true` and `confirm?: true`.
- `previousExpanded` = component state seeded to `active.length === 0`, and **resets on every entry
  to the gallery**, same reasoning as the existing `setGalleryTab('projects')` reset at `:411` —
  the launcher should look the same every time you arrive.
- **Empty states:** `projects.length === 0` → `EmptyGallery` unchanged. `active.length === 0 &&
  previous.length > 0` → a compact block where the grid would be ("Nothing active right now. Open a
  folder to start something, or bring one back below.") + the existing `Open a folder` button, and
  Previous defaults to expanded. Filter matches nothing → one muted `No match.` line, same copy as
  `ProjectSwitcher.tsx:91`.

## D. Suppress the meaningless orb row

~18 of 19 cards render an identical 6-lane dot strip because nobody has customised a roster
(`dev/research-chat-pipeline-audit.md` §1-2). Partitioning does **not** fix this — the 8 remaining
active cards still show the same 6 dots.

Render the orb strip **only when `live.length > 0`**. When nothing is running, the roster is
already stated in words by `projectActivityLabel` ("6 lanes") up in the headline; the dots are a
duplicate that differentiates nothing. Cards get shorter and more uniform, and the orbs regain
meaning: *dots on a card mean something is running here.*

## E. ⌘K palette

`DashboardView.tsx:2003-2010` lists archived projects under "Open X workspace" with no indication.
Append `· previous` to the `detail` line, and add a `Restore <name>` action for archived projects
only — so a mis-archive is recoverable from anywhere, not just the gallery.

---

## Traps

- `dev/drive-gallery-cards.mjs:13` selects `[role="button"]` across the whole document and asserts
  every match has equal height and an aligned footer. Previous rows are `role="button"` for a11y
  and **will break it** — scope the script to `[data-project-card]` in this same commit.
- The muted-opacity guard (`lib/muted-opacity.guard.test.ts`) fails the build on
  `color: var(--fg-muted)` + partial opacity. Hover reveals must go `0 → 1`, never `0.4 → 1`.
  Copy `ProjectCard`'s `+ Add a description` pattern (`:364`).
- Do not touch the sidebar in this step — that's step 4.

## Done when

- `npm test` + `npm run build` green.
- `node dev/drive-gallery-cards.mjs` (with the fixed selector) passes.
- `node dev/drive-theme-pass.mjs` — all 6 palettes + contrast table, for the new Previous rows and
  section headers.
- Archive a project, restart the app, confirm it's still shelved. Launch a session in a shelved
  project, confirm it lifts back to Active by itself.

## Write your result to

`dev/briefs/shelf-2-partition-gallery-RESULT.md`. There is no other way for me to see your output.
