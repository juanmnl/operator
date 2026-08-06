# THREE LIVE BUGS: a forgotten project resurrects itself; ⌘B restarts the app; agents reshuffle

User, 2026-08-05, in order of severity:
1. *"a whole project that i marked as forget, is launching by itself"*
2. *"app is restarting when toggling the sidebar"*
3. *"…which makes agents randomly move positions"*

Fix #1 first — it spawns processes and worktrees without consent, and is almost certainly a
contributor to the 33-worktree pile documented in `dev/briefs/2026-08-05-worktree-architecture.md`.

---

## Bug 1 — `archivedAt` is cleared as a SIDE EFFECT (diagnosed, high confidence)

`src/renderer/views/DashboardView.tsx:703` — inside the project-upsert spread:

```ts
? { ...p, path: r.path, name: p.name || r.name, lastActiveAt: now,
    defaults: p.defaults ?? opts?.defaults, archivedAt: undefined }
```

and its own comment at :706-707 states the consequence plainly:

> **AUTO-LIFT: launching, restoring, opening a folder and background cwd resolution all funnel
> through here, so clearing `archivedAt` in this one spread un-shelves a project**

Meanwhile :837 asserts the opposite invariant for the write side:

> *"Shelving: `archivedAt` is a DECISION, so it is only ever written from here"*

**That asymmetry is the bug.** Setting `archivedAt` requires explicit user intent; clearing it
happens as a byproduct of four paths, one of which — **background cwd resolution** — involves no
user at all. So a project the user deliberately forgot silently returns, and once un-shelved its
saved sessions become eligible to restore, which is the "launching by itself".

**Fix the asymmetry, don't special-case the symptom.** Clearing `archivedAt` must be as deliberate
as setting it:
- The upsert spread must **not** touch `archivedAt`. Un-shelving belongs only in the explicit
  restore/un-shelve action (`:842` already exists for exactly this) plus any path where the user
  genuinely opened the project by hand.
- Distinguish **user-initiated** upsert (opening a folder, launching a lane) from **background**
  upsert (cwd resolution, rehydration). Only the former may lift a shelf, and even then say so — an
  automatic lift with no trace is what made this invisible.
- Audit every caller of that upsert for which category it is. The comment names four; verify by
  grep rather than trusting the list.

**Then check for damage already done:** projects whose `archivedAt` was cleared by a background path
are indistinguishable from deliberately-restored ones now. Report how many projects in
`~/.operator/projects.json` currently lack `archivedAt` but have no recent user activity — do not
mass-edit that file (it has been clobbered before), just report.

---

## Bug 2 — ⌘B appears to restart the app

`toggleSidebar` (`:370-374`) only sets state and writes `localStorage`, so the handler itself cannot
restart anything, and there is **no `location.reload` anywhere in `src/renderer/`** (checked). So
"restarting" is a symptom, not an action. Establish which it actually is before fixing:

- **A renderer crash and WKWebView reload.** Most likely candidate. There is precedent in this
  codebase for WKWebView dying on specific CSS — the standing rule is *never a colour-CHANGING
  border on a border-radius element*. The rail animates `width` over 260ms on toggle
  (`ProjectRail.tsx`), so look for anything transitioning alongside it that trips that class of bug.
  Check the console and `ps`/`sample` on the WebContent pid at the moment of toggle.
- **A remount cascade mistaken for a restart.** If ⌘B unmounts and remounts a subtree that re-runs
  hydration, everything downstream re-derives — which would explain bug 3 *and* possibly bug 1's
  trigger, since rehydration is a restore path. **If this is what's happening, bugs 1–3 are one
  bug**, and that is the most valuable finding available here. ⌘B has form: v0.13.7 fixed a case
  where it unmounted the sidebar foot and *deleted* the theme toggle.

Say which it is, with evidence, before writing a fix.

## Bug 3 — agents reshuffle

Suspect the ordering introduced tonight in `e87cef7`: `orderByRoster()` in `roster.ts` performs a
"stable partition" where lane members are filled into the slots they already occupy in roster order,
while ad-hoc members keep position. Its own doc-comment flags the edge case: *"a member whose
`roleId` is not in the roster (a lane deleted while its agent still runs)"*.

Two things to verify:
- Is the partition stable across a **remount**, or does it depend on the incoming `sessions` array
  order — which may itself vary between hydration passes (a `Map`/`Set` iteration, or
  `sessions.json` order)? An order that is stable within a render but not across a rehydrate looks
  exactly like "randomly moves".
- What happens when `roleId` is absent from the roster, and when two live sessions share a `roleId`
  (duplicates should not exist but have before).

If bug 2 turns out to be a remount cascade, fix that first and re-test this — it may vanish.

---

## Bug 4 — closing a project is slow, and sometimes doesn't stick (SAME SUBSYSTEM as bug 1)

User: *"when closing a project and its agents, it takes a while to get removed from the sidenav, if
it gets removed."*

`closeProject` (`:894`) — its own comment states the design:

> *"SEQUENCE MATTERS… the sessions are ended and awaited FIRST, and only then is `archivedAt`
> written. Writing the flag first re-creates the lie, because the project is still lifted onto
> Active while the lanes are alive."*

The sequencing rationale is sound, but it produces both halves of what the user sees:

- **"takes a while"** — the shelf flag is written only after **every** lane's pty is confirmed dead.
  With several lanes that is seconds of nothing happening: no optimistic state, no "closing…"
  affordance, the project just sits there looking ignored.
- **"if it gets removed"** — if any `handleCloseSession` hangs or rejects, the await never resolves
  and **`archivedAt` is never written at all**. The project silently stays. Combine that with bug 1's
  AUTO-LIFT and there is also a race: a background upsert can clear the flag between the kill and
  the write.

**Fix both without losing the invariant the comment protects.** The lie it guards against is a
project appearing on *Active* while its lanes are alive — that is a rendering question, not a reason
to withhold the write. So: introduce an explicit intermediate state (closing) that the sidebar
renders immediately, make the teardown resilient so one hung lane cannot block the shelf (bound it,
and report what didn't die rather than hanging), and write `archivedAt` even on partial failure with
the failure surfaced. Never leave "user asked to close" recorded nowhere.

Treat bugs 1 and 4 as one workstream: **`archivedAt` is written last and cleared casually.** Both
directions of that need to become deliberate.

## Constraints

- Do **not** mass-edit `~/.operator/projects.json`.
- Don't regress lane reordering (`e87cef7`) or the rail work merged tonight.
- House rules: colours via CSS vars, no focus rings, no colour-changing border on a radiused element.

## Verify

- A shelved project stays shelved across: app restart, background cwd resolution, opening a *different*
  project, and a lane launch in another project.
- Explicitly restoring a shelved project still works and still lifts the shelf.
- ⌘B toggles the sidebar with no reload — 20 consecutive toggles, console clean.
- Agent order is identical before and after a ⌘B toggle, and after a full app restart.
- `npm test` green (624 on `main` = `a6cd39e`), `npm run build` clean.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-05-forget-and-sidebar-restart-RESULT.md`
(absolute path, main repo). Lead with whether bugs 1–3 share one root cause.
