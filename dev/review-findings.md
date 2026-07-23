# Adversarial review — complete uncommitted diff on `main`

Date: 2026-07-23 · Reviewer: Review lane (Opus)
Scope: 8 modified files + untracked `AgentsHubView.tsx`, `terminal-registry.ts`
(`dev/drive-audit.mjs`, `dev/garble-triage.md` = out of scope, not reviewed)

Verification: `npx tsc --noEmit` clean. Findings are read-only; nothing was fixed.

---

## Findings (ranked)

### 🔴 HIGH — Duplicate session spawn: no in-flight guard on the launch path

**Root:** `DashboardView.tsx:943` `handleLaunchRole` → `DashboardView.tsx:853`
`handleLaunchSession` — neither has an in-flight / already-live guard. The only
dedup is UI-side filtering keyed on `liveRoles` / `sessions`, which update **only
after** the async spawn (`worktreeCreate` + `terminalSpawn`) resolves and the new
terminal materializes as a live session.

**Reachable from three new/changed surfaces, all routing to the unguarded path:**
- `RosterPanel.tsx:467` per-card **Launch →** (`onLaunch` → `onLaunchRole` →
  `handleLaunchRole`, wired at `DashboardView.tsx:1999`).
- `RosterPanel.tsx:124` batch **Launch N / Launch all** (`launchTargets.forEach(onLaunchRole)`).
- `AgentsHubView.tsx:143` **PassiveCard** click (`onLaunchRole`, wired at
  `DashboardView.tsx:1976`).

**Failure scenario:** user double-clicks an idle lane's Launch button (or the
PassiveCard). First click begins `worktreeCreate` (disk I/O, easily >100ms, often
seconds) then `terminalSpawn`. The card/button is still shown because `liveRoles`
hasn't changed yet, so the second click fires a second `handleLaunchRole` →
**two git worktrees, two ptys, two `claude` processes for one lane.** If the lane
had queued tasks, `markTasksRunning` claims them on the first call
(`DashboardView.tsx:953`), so the second terminal spawns with an empty prompt — an
orphan worktree the user must clean up manually and may not notice.

**Contrast:** `dispatchToRole` (`DashboardView.tsx:992`) *does* guard with
`terminals.find(... roleId === role.id)` before acting. The launch path has no
equivalent. Fix would be a guard in `handleLaunchRole` (focus/bail if a live tab
for `project.id:role.id` exists) or disabling the control after first click.
Not fixed per instructions.

### 🟡 LOW — Buffer-dump reports success even when the write failed

**`DashboardView.tsx:457-465` + `src-tauri/src/folderprefs.rs:120`**

`handleDumpBuffer` toasts `'Terminal buffer dumped'` on resolve and relies on its
`catch` for failure. But `save_md_file` does `let _ = std::fs::create_dir_all(...)`
and `let _ = std::fs::write(...)` — **every fs error is swallowed** — and the Tauri
command returns `()`. So `folderPrefsSaveMd(...)` always resolves; the `catch` can
only fire on an IPC-layer error, never a real disk-full / permission-denied write
failure. User sees "dumped → /path" pointing at a file that isn't there.
Debug-only tool, so low, but the success toast is dishonest.

---

## Areas checked and clean

### (1) TerminalPane.tsx hardRepaint rework — CLEAN
- **Leak / cleanup:** the settle timer (`refreshTimerRef`, cleared at `:481`) and
  the 1Hz `healInterval` (`clearInterval` at `:482`) are both released in the
  effect cleanup. The terminal-creation effect deps are
  `[terminalId, onTitleChange, handleResize]` (`:503`) — **not** `active` — so a
  session switch (which toggles `active`, read via `activeRef`, pane stays mounted)
  does **not** create a new interval. No per-switch leak.
- **termRef guard race (disposed mid-rAF):** `hardRepaint` sets the transform
  synchronously then schedules `requestAnimationFrame(() => { if (termRef.current
  === term) el.style.transform = '' })` (`:346`). On dispose, cleanup runs
  `term.dispose()` + `termRef.current = null` *before* the rAF fires, so the guard
  is false and the callback never touches the (removed) element. On an effect
  re-run the guard compares against the new term instance → also false for the old
  closure. No disposed-element access.
- **Transform sticking non-empty:** the only value ever set is
  `translate3d(0, 0.02px, 0)` — sub-device-pixel, invisible, fully opaque. Even in
  the one path where the reset rAF is deferred (window hidden → rAF paused → fires
  on re-show) or skipped (element already disposed/removed), the residual value is
  invisible on a live element and irrelevant on a removed one. No visible stick.
- `forceRepaint`/`hardRepaint` both early-return on `!activeRef.current` and wrap
  `term.refresh` in try/catch (`/* disposed */`). The chosen sub-pixel-translate
  mechanism (vs the burned opacity/visibility nudges) is well-reasoned in the
  in-file comment and consistent with the WKWebView repaint rules in memory.

### (2) RosterPanel.tsx card-grid rework — CLEAN (aside from the shared HIGH launch guard)
- **Drag-reorder:** `reorderByIds` (`lib/reorder.ts`) recomputes the target index
  *after* removing the dragged item (`:11-14`), so downward drags land on the drawn
  drop line, not one slot short. Traced before/after edges — correct. Self-drop
  guarded (`dragId === role.id` early-returns in `onDragOver`; `reorderByIds`
  returns input unchanged for `dragId === targetId`). Drop in a grid gap / on the
  "add" card is a no-op (no drop handler there → `onDragEnd` resets). `onDrop` +
  `onDragEnd` double-reset is idempotent.
- **Coordinator:** identity is id-based (`isCoordinator`), not position — dragging
  Operator out of first place is cosmetic and violates no runtime invariant (only a
  *test* asserts `roster[0]`). Coordinator is un-removable (no ✕, `:390`).
- **Select:** `picked` is **derived** (`selected.filter(id => roles.some(...) &&
  !isLive(id))`, `:83`) — a selected lane that's removed or goes live drops from the
  selection with no stale-state sync. Clicking the grip / inner controls doesn't
  select (`closest('button,input,textarea,select,a,[draggable="true"]')` guard,
  `:302`).
- **Remove:** `removeRole` uses the functional updater
  (`onUpdateProject(id, cur => removeRoleFrom(cur, id))`, `:108`) → no stale-snapshot
  clobber; `removeRoleFrom` also unassigns the role's queued tasks. Accent picker
  handles a removed target (`if (!target) return null`, `:250`). `patchRole`
  likewise uses the functional updater (`:100`).
- `checkCommand` input is `key={project.id}` so `defaultValue` re-reads on project
  switch (`:156-157`).

### (3) AgentsHub + DashboardView wiring — CLEAN (aside from the shared HIGH launch guard)
- Wiring typechecks. `ActiveCard` → `onFocusSession` (focus, not spawn — safe).
- Stale-session handling: `live = sessions.filter(s => s.status !== 'ended')`
  (`AgentsHubView.tsx:32`); ended sessions leave the active set and their lane
  returns to idle. Orphan/name-keyed groups (`:53-56`) handle sessions whose
  project isn't in `projects` (disabled header, no path).
- **Minor edge (not a defect):** `liveKeys` requires `s.projectId && s.roleId`
  (`:33`). A live session with a `roleId` but no `projectId` is keyed by
  `name:` and grouped as an orphan; a roster project matched only by name would
  still list that role as an idle lane. Requires projectId-less role sessions —
  unusual; left unranked.

### (4) Toast / StatusWave / SessionItem / Sidebar / AgentLibraryView — CLEAN
- **Toast.tsx:** the `beginExit` `setTimeout` is not cleared on unmount, but it's
  benign — it calls `onDismissRef.current()` → `onDismiss(m.id)`, an idempotent
  `filter`-by-id, and ids are `Date.now()-random` (`DashboardView.tsx:290`) so
  there's no id reuse to prematurely dismiss a re-created toast. `leavingRef`
  prevents double-exit. The `onDismissRef` pattern is actually a **fix**: the old
  `[onDismiss, message.action]` deps re-armed the 3.5s auto-dismiss on every parent
  render; the ref + stable `beginExit` makes the effect run once.
- **StatusWave.tsx:** adding `accent` to the dots memo deps (`:347`) is necessary
  and correct — `restFill` now reads `accent`. Resting states no longer set
  `--tw-fill`/`--tw-fill-peak`; dots fill from inline `restFill`. Consistent.
- **SessionItem.tsx:** lane-name color logic (accent only when `active`, else
  neutral `--fg`/80%) is a pure style change; `showPhase` adds `waiting` back as a
  quiet word — matches the design note. No defect.
- **Sidebar.tsx:** cosmetic — version-tag centering, tooltip text, and the
  `font: 'inherit'` → `fontFamily: 'inherit'` fix (the `font` shorthand was
  resetting size/weight, per the comment). Correct.
- **AgentLibraryView.tsx:** `embedded` prop with a default suppresses the duplicate
  header when hosted in the hub. Typechecks; both call sites valid.
- **terminal-registry.ts:** register on create / unregister-then-dispose in cleanup
  (`TerminalPane.tsx:188, :516`). Effect deps mean terminalId change unregisters the
  old id (closure) before registering the new — no leak. The dump's buffer read
  (`DashboardView.tsx:436-443`) is fully synchronous *before* any `await`, and the
  term comes from the registry (which drops disposed terminals), so it can't hit
  `.buffer` on a disposed xterm.

---

## Summary

- **1 HIGH:** unguarded launch path allows duplicate lane spawns via double-click
  from RosterPanel (per-card + batch) and the Agents hub. Same root
  (`handleLaunchRole`/`handleLaunchSession`); `dispatchToRole` shows the guard
  pattern to copy.
- **1 LOW:** buffer-dump toasts success even on a failed disk write (Rust swallows
  fs errors).
- TerminalPane hardRepaint, RosterPanel drag/remove/select, and the remaining
  cosmetic diffs are clean under the checks above.
