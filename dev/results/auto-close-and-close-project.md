# Two features that exist in code and don't happen in use

Brief: `dev/briefs/auto-close-and-close-project.md` (main, `f1736e1`). Report only, no code
changes. Evidence below is from this machine's real `~/.operator/artifacts.db`,
`~/.operator/projects.json`, and live `~/.claude/projects/**/*.jsonl` transcripts — not fixtures.

---

## A. Auto-close after a report

**The policy and its driver are both correct and mounted.** `laneCloseDecision`
(`src/renderer/lib/lane-lifecycle.ts:84-121`) is a strict ladder — keep-warm disabled → coordinator
→ focused → `openWork > 0` → phase `busy`/`waiting`/unknown → only then does it look at
`reportedDoneAt`. `DashboardView.tsx:2898-2951` runs `planLaneCloses` every 30s via a real
`setInterval`, gated only on the app being hydrated. `getKeepWarmMinutes()` (`lane-lifecycle.ts:176-192`)
falls back to a shipped default of 10 minutes — confirmed **not** overridden to `0` on this
machine (`operator.lane.keepWarmMinutes` is absent from the app's LevelDB local storage entirely).
`openWork` (`DashboardView.tsx:2909`) counts only `ProjectTask`s with `status==='running'`; across
this whole machine's `projects.json` there are currently **2** such tasks total, so this guard is
essentially never the blocker either.

**The guard that actually blocks it in practice:** `reportedDoneAt` is populated from exactly one
source — `doneReportsRef`, stamped only by the poll at `DashboardView.tsx:2180-2226`, which reads
`window.operator.artifactPendingStatus()`, itself sourced from rows in the `task_status` SQLite
table (`~/.operator/artifacts.db`). It is **not** stamped by a `report` call, by design (the
file's own header comment says so).

Live evidence from `~/.operator/artifacts.db`:
```
task_status: 5 rows total, spanning 2026-08-06 → 2026-09-01, all status='done'
reports:     643 rows, spanning 2026-08-06 → 2026-09-06 (today)
```
A ~130:1 ratio. Grepping every transcript that even mentions `mcp__operator__task_status` (63
files): only **1 of 63** actually called it as a tool. The other 62 — including a QA lane active
as recently as today — loaded the schema for both `report` and `task_status` via `ToolSearch`,
then called `report` three times and never called `task_status` once. That's not an edge case,
it's the norm: lanes are told to call `report` unconditionally, but `task_status` only applies
"when a task you were given is finished" (`src/renderer/lib/roster.ts:154-167`), and most
dispatched work never carries a formal task id to begin with (only 2 `running` tasks exist
machine-wide right now).

**Consequence:** virtually every lane takes the "never reported" branch of `laneCloseDecision`
and falls to the `quietMs` backstop (`DEFAULT_QUIET_MINUTES = 120`, i.e. 2 hours) instead of the
10-minute keep-warm path — and even that backstop only fires if the lane's phase genuinely stays
`idle` (not `waiting`) for the full two hours, a much narrower condition than "reported done."
This is why Juan sees lanes sit open indefinitely after they've clearly finished and reported:
the signal the close policy is designed around almost never gets set.

### Should a `report` alone count as done?

Given the 130:1 ratio and the observed pattern of lanes loading both tool schemas and choosing
only `report`, the practical answer is **yes, for this policy's purposes** — trying to get every
lane to reliably call a second tool it currently skips ~99% of the time is fighting the grain of
how the charter actually reads to a lane in practice. The cost: the `quietMs` backstop currently
exists specifically to catch lanes that never call anything at all (crashed, wedged, forgot) —
if `report` becomes a "done" signal, that backstop's remaining value narrows to exactly that
"went totally silent, no report either" case, which is a strictly smaller and more defensible set
of lanes to leave on the slow 2-hour path. The backstop should stay for that reason, just no
longer be the primary path for the common case.

### Recommended fix (sized)

**Small.** Feed `doneReportsRef` from `reports` rows in addition to `task_status` rows — the
poll at `DashboardView.tsx:2180-2226` already reads from `artifactPendingStatus()`; add a
sibling read (or extend that one call) to also surface the most recent `reports` timestamp per
lane, optionally gated on the report not being immediately followed by further tool activity from
that lane (to avoid closing a lane that reported an intermediate result and kept working — worth
a look at whether `report` calls in practice are terminal or not, since "reported back" per the
brief implies terminal-report intent). No changes needed to `laneCloseDecision`'s ladder itself,
`planLaneCloses`'s cadence, or the keep-warm default — only the source feeding `reportedDoneAt`.

---

## B. Close project from the rail with 3+ sessions

**The close mechanics themselves are sound and already hardened for the multi-session case.**
`closeProject` (`DashboardView.tsx:1079-1168`) closes every live lane in parallel
(`Promise.all`, line 1114), each racing `handleCloseSession` against a 4000ms timeout
(`KILL_TIMEOUT_MS`, line 1101). A lane that hits the timeout is rechecked against the live
terminal list (lines 1108-1112) — if the pty is already dead it's counted as fine; only a
genuinely-still-alive pty is reported `stuck`, and that's surfaced as a toast, not a block on the
rest of the close. The `closing…` flag is cleared unconditionally right after `Promise.all`
settles (line 1143) — there is no code path that leaves it stuck. **Worktree removal is not in
the timed path at all** — it's fired-and-forgotten after `terminalKill` resolves (lines
2837-2856, by explicit design per its own comment, "so close stays snappy"), so a slow `git
worktree remove` (this machine: 29 registered worktrees, `git worktree list` itself ~15ms)
cannot trip the 4s timeout regardless of worktree count. `terminalKill` itself is bounded well
under 4s on both shells (Electron: SIGTERM + 1.5s grace + SIGKILL, reaped concurrently across
lanes; Tauri: a single synchronous kill with no grace period).

**None of the brief's candidate mechanical failures reproduce in the code as written**: not the
confirm never firing, not the 4s timeout eating the close, not a stuck lane pinning the project
to the rail, not the chip failing to clear.

**What's actually broken is UX, not a race — two real gaps:**

1. **No in-progress feedback on the rail itself.** The `closing…` chip exists only on
   `ProjectGallery.tsx`'s card (`closing={closingIds?.has(project.id)}`, line 251,
   `data-card-closing` at 469-477). `ProjectRail.tsx` has zero occurrences of "closing" —
   no chip, no spinner. A user who right-clicks a rail tile, confirms "Close project · end 3
   agents," and stays on the rail sees the menu close and then **nothing visibly change** for up
   to ~1.5s while lanes tear down in parallel — tiles only disappear one at a time as each
   `setTerminals` filter actually lands. With 3+ sessions, that gap reads exactly like "closing a
   project with multiple sessions doesn't work," when it's silently succeeding a beat later.
2. **Discoverability: right-click only, no visible affordance on the rail tile.**
   `ProjectRail.tsx:672-706` wires the project-actions menu only to `onContextMenu` — there is no
   `⋯`/kebab button anywhere on the rail tile, unlike the gallery card, which has a real `⋯`
   button. This directly matches project memory's `project_close_project_affordance` note: a
   rail `⋯` was designed and never shipped. A gesture with zero visual cue on the tile is very
   plausibly never found at all — this alone could fully explain "I can't close a project from
   the rail," independent of anything about session count.

**A third, narrower finding**: the confirm mechanic (`CardMenu.tsx:104-134`) is a two-click
arm/re-click pattern keyed on the menu label text, which embeds the live session count
(`Close project · end ${live} agents`, `DashboardView.tsx:4135`). If that count changes between
the arming click and the confirm click — e.g. the 30s auto-close tick from part A closes one lane
mid-interaction — the label changes, the identity check fails, and the second click silently
re-arms instead of firing, needing an unexplained third click. Narrow window, but plausible with
3+ long-running sessions.

**Reproduction via the qa-real bridge — not executed, and here's why.** `dev/drive-close-project.mjs`
exists and was read in full. It drives `dev/mock.html` (an in-memory fake-bridge fixture, not a
"qa-real" driver — no dedicated qa-real script for this scenario exists), which would have been
safe to run, but it wasn't standing up (no dev server on the port it targets) and running it was
out of scope for a research-only pass. More importantly, **it's stale relative to current code**:
it drives the gallery card's `⋯` button, not the rail's right-click menu the brief is actually
about, and its own acceptance check asserts the old fused close-writes-`archivedAt` behavior —
`closeProject` explicitly no longer does that (`DashboardView.tsx:1055-1071,1140-1142`:
`archivedAt` is now written from exactly one place, `archiveProjects`, not from close). Running
it would exercise the wrong control and fail on an assertion that's now correctly false, so the
rail/`closeProject`/`handleCloseSession` paths were traced directly in code instead.

### Recommended fix (sized)

**Small, two independent pieces, do both:**
1. Add a `closing` state to the rail tile (mirroring the gallery card's existing pattern) so the
   tile itself shows a spinner/dim state the moment the confirm fires, not just when each lane's
   terminal disappears one at a time.
2. Ship the `⋯` affordance on the rail tile that `project_close_project_affordance` already
   designed — this is very plausibly the actual root cause of "I can't close a project from the
   rail," independent of session count, since right-click has no visual invitation at all.

**Not worth fixing on its own, but worth knowing:** the label-identity re-arm edge case in
`CardMenu.tsx` — could be addressed by keying the armed-state check on the menu item's action
identity rather than its rendered label text, but only worth doing alongside the two fixes above,
not as a separate pass.

**Also worth doing, out of scope for this brief:** retire or rewrite `dev/drive-close-project.mjs`
— it currently tests a control surface and a data-write behavior that no longer exist, so it's
silently not covering the thing it's named for.
