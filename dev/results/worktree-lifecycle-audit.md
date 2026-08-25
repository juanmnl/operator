# Worktree lifecycle audit — Electron shell

**Scope:** research only, nothing changed, nothing deleted. Traced
`electron/src/main/worktree.ts` (full file, 399 lines), `ipc.ts`'s worktree section, `store.ts`,
and the renderer's only caller of removal (`DashboardView.tsx`). Cross-referenced against a live
snapshot of `~/.operator/worktrees` (`du`, `git` per directory via a throwaway Python script,
deleted after use — nothing in the repo or `~/.operator` was modified), `~/.operator/sessions.json`,
`~/.operator/worktree-provenance.json`, and a `ps` check of what's actually running right now.

**Baseline today:** 107 directories (the brief said 106 — one more now, consistent with growth
between the brief being written and this audit running), **34.0 GB**, up from 66 dirs/21 GB on
2026-08-11. Operator.app is currently running (pid 93190) with 13 live `claude --settings`
processes, one of which is this very research session (`operator-7d8780`, confirmed showing up
correctly as `claimed-live-flag` in the classification below — a working sanity check on the
method).

## (1) Create path

`createWorktree(sourceCwd, reuseBranch?, laneId?)` (`worktree.ts:116-142`):

1. `inspectRepo` resolves the real repo root via `git rev-parse --show-toplevel`; refuses if the
   repo has zero commits.
2. **Reattach path** (when `reuseBranch` is given, e.g. resuming a suspended task-scoped lane):
   `reattachWorktree` (`worktree.ts:104-114`) prunes stale admin state (`git worktree prune`) and
   re-adds a worktree directory on the *existing* branch — this is how a suspended lane gets its
   directory back without losing its committed work.
3. **Fresh path:** name = `operator/<shortId>` where `shortId` is a 6-hex-digit slice of the
   current timestamp (`worktree.ts:47`); directory = `~/.operator/worktrees/<repo-basename>-<shortId>`.
   Base branch is resolved via `defaultBase()` (`worktree.ts:64-71`) — `origin/HEAD`'s name, or
   `main`/`master` fallback, preferring the **local** ref over `origin/<name>` deliberately (this
   project merges lane branches locally before pushing, so the local branch is often ahead).
   `git worktree add -b <branch> <path> <baseRef>`.
4. **Provenance is recorded** (`recordProvenance`, `worktree.ts:82-91`) — appended to
   `~/.operator/worktree-provenance.json`: `{path, createdAt, createdBy, sourceRepo, branch, laneId}`.
   This is the ONLY durable record tying a worktree directory back to the repo it came from,
   and it's what any future reaper would need to prove it may touch a directory.

**What gets copied/installed: nothing.** `git worktree add` does exactly what git does — a fresh
checkout sharing the object store, no `node_modules`, no `target/`, no dependency install step
anywhere in this file or in `ipc.ts`'s `worktreeCreate` wrapper. Every worktree directory starts
truly empty of build artifacts; **the whole disk cost is accrued later**, by whatever the agent
running inside it does (typically an `npm install`/`cargo build` in its first turn) — Operator's
own code contributes zero bytes at creation time. This matters for the size numbers in § 4: every
`node_modules`/`target` byte counted there was put there by an agent's own actions, not by the
create path, and no amount of fixing `createWorktree` would change that.

## (2) Every close path, and whether `worktreeRemove` is called

`removeWorktree` (`worktree.ts:326-336`) is exported from `worktree.ts`; `ipc.ts:116-118` wires it
as `worktreeRemove`. **Grepped the entire renderer for callers: there is exactly one call site**,
`DashboardView.tsx:2747`, inside `handleCloseSession`.

| Path | Calls `worktreeRemove`? | How |
|---|---|---|
| **Lane close** (user clicks ■ / Cmd+W on a live tab) | **Yes** | `handleCloseSession` (`DashboardView.tsx:2707-2779`): kills the pty, lets `completeTerminalTasks` finish (diff capture + verification check), then — **unconditionally**, whether or not this is a `suspend` — commits any uncommitted changes (`worktreeCommit`, "WIP preserved before reaping this worktree") and calls `worktreeRemove`. The branch always survives; only the directory goes. |
| **Project close** | **Yes, via the same function.** `closeProject` (`DashboardView.tsx:1051` on) explicitly "Reuses `handleCloseSession` per lane — the same path the ■ button takes" (comment at `1045-1048`). **This supersedes the old `project_close_project_noop.md` project-memory finding** (`closePlan` reading the raw session list and ending nothing) — that bug is fixed here; project close does route every live lane through the real removal path today. Worth updating that memory entry. |
| **App quit** | **No.** `teardown()` (`index.ts:114-123`, run on `will-quit`) calls `transcript.stop()`, `terminals.killAll()`, `chat.close()`, `artifacts.close()`, tray teardown — **nothing about worktrees at all**. Every worktree-backed lane still open when the user quits Operator is abandoned with its directory intact, forever, by design (there is no code path that would ever touch it again). |
| **Lane ends by itself** (the `claude` process exits on its own — natural stop, crash, `/exit`) | **No.** `onTerminalExit` (`DashboardView.tsx:461-474`) explicitly does the opposite of a close: it marks the tab `ended: true` and **leaves it mounted** (so the final terminal output stays visible), and the handler's own comment says "Intentional closes (`handleCloseSession`, worktree merge/discard) still remove the tab" — i.e. this path is deliberately *not* one of them. The worktree directory is only ever removed if the user later manually dismisses that ended tab, which routes back through `handleCloseSession` (harmless `terminalKill` on an already-dead pty, same unconditional removal branch). If the user doesn't dismiss it before quitting or before the next launch, `terminals` state is in-memory only and does **not** survive a restart — the ended tab, and with it the only remaining code path that could have removed the directory, is simply gone on the next launch. |
| **Renderer respawn under memory pressure** (documented elsewhere in project memory: WebKit kills and restarts this renderer, measured hourly around ~1.1–1.2GB) | **No — and this can also interrupt a removal already in progress.** `handleCloseSession`'s cleanup is `void finishTasks.then(async () => {...worktreeRemove...})` — an **un-awaited promise chain living entirely in renderer JS memory**, with no main-process equivalent and nothing durable backing it. If the renderer is killed and respawned at any point between the close click and that `.then()` firing — during the verification check, during the WIP commit, or simply because the removal was queued but hadn't started — the continuation is gone. Nothing resumes it. This is the *same* mechanism the `onTerminalExit` gap above ends in: a directory that was correctly scheduled for removal, half-cleaned-up-or-less, and then permanently orphaned by something outside the worktree code entirely. |

## (3) Reap / dry-run logic — not ported, not reachable, does not exist

Grepped `electron/src/` and `src/renderer/` for `reap`/`Reap`: the only hits are (a) the doc
comment on `recordProvenance` describing what a *future* reaper would need (`worktree.ts:79-81`,
already quoted above) and (b) two renderer comments describing the coordinator's *conceptual*
responsibility to "reap worktrees" (`roster.ts:236`, `model-config.ts:96`) — neither is executable
code. **There is no `reapDryRun`/`worktreeReapDryRun` function anywhere in the Electron port, no
IPC method for it, and no boot-time reconciliation of any kind** (`index.ts` has zero worktree
references outside a comment about dev-port allocation).

This is a step backward from what the prior Rust-era finding described. That finding
(`project_worktree_reap_current_state.md`, 2026-08-11) was "the classifier exists, reports
`reapable=0` because of a policy gap, and no frontend calls it" — i.e. present but unreachable and
too conservative. In the Electron port, **the classifier itself was never carried over** — not
unreachable, *absent*. The only thing that removes a worktree today is the one, single,
renderer-JS-only call site described in § 2, with the failure modes described there and no
fallback of any kind.

## (4) Classifying the 107 directories

Method: `~/.operator/worktree-provenance.json` for `sourceRepo`; for each directory, `git
rev-parse --abbrev-ref HEAD` + `git status --porcelain` run *inside* it; `git worktree list
--porcelain` run against its resolved source repo to check registration; `git branch --merged
<default-branch>` against the source repo to check merge status; `~/.operator/sessions.json`
entries with a `worktreeBranch` matching the directory's path for the "claimed" signal.

**Honest limitation on "claimed by a live session":** `sessions.json`'s `terminalId` field is the
best available *durable* signal ("this was live as of the last save"), and it did correctly flag
this very session's own worktree. But per-process cwd can't be verified against the currently
running `claude` pids without per-pid `lsof` — which the project has an explicit standing rule
against, for the TCC-prompt reason documented elsewhere in project memory. So "claimed-live" here
means "sessions.json says so as of its last write," not "independently re-verified against the
live process table right now." Treat the count as a reasonable floor, not a cross-checked fact.

### Classification

| Class | Dirs | Size | Definition |
|---|---:|---:|---|
| **Unclaimed but git-registered** | 71 | **28.42 GB** | `sessions.json` has no record at all (no live *or* suspended entry), but `git worktree list` in the source repo still lists it. This is the dominant class by a wide margin — direct disk evidence for the close-path gaps in § 2: a directory that survives despite its session record being forgotten (a normal, non-suspend close explicitly forgets the session) is a directory whose `worktreeRemove` call either never got to run or failed silently. |
| **Claimed — live flag** | 23 | 5.14 GB | `sessions.json` entry with a `worktreeBranch` and a `terminalId` set. |
| **Unregistered stray** | 13 | 0.46 GB | Neither a session record nor a `git worktree list` registration. Two sub-flavors, both confirmed: (a) leftover partial-create artifacts — `.tmpIBNq7t-d96ee0` (contains one stray `a.txt`), `operator-ac9328` (empty but for a `.vite` cache dir — a dev-port reservation that outlived a worktree that apparently never got created) — junk from an interrupted create, not real work; (b) **4 `uwazi_2026-*` directories (471 MB) whose `.git` file points at `~/Documents/Claude/uwazi_2026/.git/worktrees/...` — and that source repo no longer exists on disk at all** (confirmed: `ls` fails, `git worktree list` against it fails). These are permanently unreachable by any git-based reap logic; nothing can ever `git worktree remove` them because the repo that would run that command is gone. Only a raw directory delete (through the existing `dangerousRemovalReason` path-safety check, which doesn't require git) can ever clear these. |

**13 directories are git-corrupt** (`git rev-parse --abbrev-ref HEAD` fails inside them) — a
distinct, cross-cutting problem from the classification above (a corrupt dir can be in any of the
three classes by registration status). Nine of these are 0 MB (dead husks from a failed
`worktree add`); the 4 `uwazi_2026-*` ones above account for the remaining 471 MB. None are
git-registered, so `git worktree prune` in a *live* source repo wouldn't find them either — see
the point above.

### Per-project breakdown (by directory-name prefix)

| Project | Dirs | Size |
|---|---:|---:|
| operator | 17 | **16.10 GB** |
| el-encanto | 32 | 9.73 GB |
| mantel | 21 | 4.78 GB |
| uwazi_app | 8 | 0.95 GB |
| web27 | 5 | 0.67 GB |
| mantel-landing | 13 | 0.66 GB |
| everything else (9 dirs: stray `uwazi_2026-*`, `operator-26b80`, `fastrack`, `Operator-landing`, `darkmatter`, `.tmp*`, `uwazi_app-qa`) | 9 | ~1.1 GB |

**operator itself is the single biggest offender by volume despite having the fewest dirs of the
top three** — 17 dirs averaging ~950 MB each, nearly 3x el-encanto's per-dir average. Cause,
confirmed by `du`:

### Top 10 by size, and what's heavy inside

| Size | Dir | Heaviest contents |
|---:|---|---|
| 4.0 GB | `operator-63cc58` | `src-tauri/` **3.8 GB** (stale Cargo `target/` from before the Tauri→Electron migration) + `node_modules` 159 MB |
| 3.7 GB | `operator-c25838` | `src-tauri/` 2.4 GB + `electron/` **1.0 GB** (its own nested `node_modules`+build output) + `node_modules` 159 MB |
| 3.1 GB | `operator-808fe8` | `src-tauri/` 2.9 GB + `node_modules` 152 MB |
| 2.1 GB | `operator-8ad620` | `src-tauri/` 1.4 GB + `electron/` 475 MB + `node_modules` 152 MB |
| 1.3 GB | `operator-d143b8` | `electron/` 1.1 GB + `node_modules` 152 MB (no `src-tauri` — created after the Rust removal) |
| 1.1 GB | `operator-3b4cb8` | `src-tauri/` 935 MB + `node_modules` 160 MB |
| 646 MB | `operator-26b80` | `electron/` 477 MB + `node_modules` 159 MB |
| 636 MB | `operator-a30080` | `electron/` 475 MB + `node_modules` 152 MB |
| 550 MB | `el-encanto-bb3510` | `node_modules` **486 MB** (a monorepo — `apps/`+`packages/` together are only ~60 MB) |
| 544 MB | `el-encanto-df90b0` | `node_modules` 486 MB, same shape |

Confirms and sharpens the prior Rust-era finding (Cargo `target/` + duplicated `node_modules` are
the worst offenders): **it's actually three compounding offenders now**, not two. The
pre-migration `operator-*` worktrees are still carrying multi-gigabyte `src-tauri/target/`
directories nobody will ever build again (Rust/Tauri was fully removed from the live codebase —
`electron ^43.4.1` is the only shell now), and the newer `operator-*` worktrees pay a second,
separate `node_modules` tax inside `electron/` on top of the root one, because the repo now
carries two `package.json`s (root + `electron/`) during the migration period. Every
`el-encanto`/`mantel` worktree pays a flat ~340–540 MB `node_modules` tax per directory, full stop
— that repo has no stale build-artifact problem, just plain duplication across dozens of
directories that were never reclaimed.

## (5) Merged-branch worktrees safe to remove

Of the 94 git-valid worktrees: **74 branches are already merged into their source repo's default
branch, 20 are not.**

- **Merged AND clean (no uncommitted changes) AND not live-flagged: 24 directories, 11.85 GB.**
  This is the immediately, unambiguously safe set — same branch state a `git worktree remove` +
  `git branch -d` would accept with zero force flags.
- **Merged but with uncommitted changes: 35 directories.** Inspected several of the largest by
  hand rather than trusting the raw "dirty" count: most of the biggest ones (multiple
  500 MB-class `el-encanto-*` dirs) show **exactly one changed line — `M CLAUDE.md`** — almost
  certainly routine doc upkeep, not unsaved work at risk. A couple (`operator-63cc58`,
  `el-encanto-998868` with 29 changed paths) carry real untracked content (e.g. `dev/briefs/*.md`
  planning notes) that a blind delete would lose. The existing `commitAll`/`worktreeCommit`
  function (`worktree.ts:340-346`, already wired at `ipc.ts:122-124`) is exactly the tool for
  this — it already handles "commit everything, no-op if already clean" — but nothing calls it as
  part of a reap flow; today it's only called from the one lane-close path in § 2.
- **Not merged (20 directories):** real, unlanded branches. Some are stale abandoned experiments,
  some may be exactly the "unwatched worktree from a still-useful branch" this audit was asked to
  avoid — merge status alone can't distinguish those, and this audit doesn't attempt to (that
  needs the actual content/commit history read, out of scope for "change nothing, delete
  nothing").

## Lifecycle defects, ordered by severity

1. **[Critical] No worktree cleanup on app quit.** `teardown()` never touches worktrees. Every
   session the user has open when they quit — which, given the app is used for hours-long agent
   runs, is a routine, expected way to stop the app, not an edge case — permanently orphans its
   worktree directory. Given 71 of 107 directories (28.4 GB) are already in the "no session record
   at all" state, this is very likely the single largest contributor to the 21 GB → 34 GB growth
   since 2026-08-11.
2. **[Critical] Worktree removal lives entirely in un-awaited renderer JS with no durability.**
   `handleCloseSession`'s `void finishTasks.then(...)` chain has no main-process counterpart, no
   persisted "removal pending" record, and no retry. The renderer's own documented failure mode
   (WebKit killing and respawning it under memory pressure, roughly hourly) can interrupt this
   chain at any point after a close was requested and before the directory is actually gone,
   with nothing left behind to resume it. This turns an already-fragile single-attempt cleanup
   into one that can fail silently even when the user *did* close the lane correctly.
3. **[High] A lane that ends on its own never gets its worktree removed**, by design —
   `onTerminalExit` explicitly does not call the close path, and the only thing that can trigger
   removal afterward (the user manually dismissing the now-"ended" tab) is renderer-only UI state
   that doesn't survive an app restart. A crash, a natural `/exit`, or the agent simply finishing
   and stopping all silently convert into a permanent leak unless the user notices and dismisses
   the tab before the next quit or respawn.
4. **[High] No reap/dry-run logic exists in the Electron shell at all** — not unreachable, absent.
   There is no way, today, to even *audit* the 107 directories from inside the app, let alone
   clean them; this very report had to be built by shelling out to `git`/`du` directly. Contrast
   with the create path, which is fully ported and correct.
5. **[Medium] No boot-time reconciliation.** Nothing at launch cross-references
   `~/.operator/worktrees` against `sessions.json` or `git worktree list`. A directory orphaned by
   defect #1–3 is never revisited by anything, ever, regardless of how many times the app is
   subsequently opened and closed cleanly.
6. **[Medium] Provenance coverage is incomplete.** `worktree-provenance.json` has 70 entries for
   107 directories — 37 directories (including some multi-hundred-MB ones) have no provenance
   record, meaning even a reaper that respects "only remove what Operator can prove it made"
   (the documented design intent, `worktree.ts:79-81`) would refuse to touch them by construction.
   Some of this gap is explained by genuinely un-reapable directories (the 4 dead-source-repo
   `uwazi_2026-*` ones can't have meaningful provenance since Operator likely didn't create them
   in the current scheme), but not all of it.
7. **[Low] ~9 directories (a few hundred KB–MB each) are inert creation debris** — empty except a
   stray `.vite` cache or a single unrelated file, from interrupted `worktree add` calls. Trivial
   in size but noise in every future audit/reap pass.
8. **[Low] The "dirty" signal a reaper would naturally reach for is too coarse on its own.** A
   worktree with a single `M CLAUDE.md` line is functionally identical to a clean one for reap
   purposes, but a blunt "any porcelain output = don't touch" rule (which is what a literal port
   of the removal guard's spirit would produce) would quarantine 35 directories, most of which
   the existing `commitAll` step already knows how to make safe.

## Recommended reap policy

Given the failure modes above are almost all "nothing runs a removal that should have," not "the
removal logic itself is wrong" (the actual `removeWorktree`/`dangerousRemovalReason` guard is
careful and well-tested — see the extensive path-safety logic at `worktree.ts:226-336`), the fix
is mostly about **adding the missing trigger points**, not rewriting the guard.

**Never touches, under any policy:**
- Anything with a live `terminalId` claim (currently-open lane).
- Anything `dangerousRemovalReason` already refuses (repo itself, `$HOME`, filesystem root,
  a path containing a nested registered worktree or an unrelated `.git` checkout) — keep this
  guard exactly as-is; it's the one piece of this system that's already solid.
- The 4 `uwazi_2026-*` directories whose source repo is gone, and similar future cases — these
  cannot be reasoned about via git at all and need a human decision (delete the directory
  directly, or first confirm the source repo really is gone rather than moved), never an
  automatic pass.
- Anything without a provenance record, in the automatic tier — surface it as "unattributed,"
  reviewed manually, not silently skipped forever (today's silent-forever is defect #6).

**Auto-removes (no confirmation needed), run at three trigger points — app boot (reconciling the
full directory list against `sessions.json`/`git worktree list`/provenance, closing the defect-#5
gap), app quit (closing defect #1, moved into `teardown()`'s main-process code so it survives a
renderer respawn — closing defect #2 for the quit case specifically), and periodically while
running:**
- Merged into the source repo's default branch, clean (`git status --porcelain` empty), not
  live-claimed, git-valid, and provenance-attributable. This is the 24-directory/11.85 GB set
  measured above — exactly the numbers a first real reap pass would recover today.
- Before removing: run `commitAll` first regardless of whether `status --porcelain` was already
  empty (it's a no-op on a clean tree per its own doc comment) — this is what closes defect #8,
  turning the 35 "merged but dirty" directories into candidates for the same auto-remove tier
  rather than a permanent manual-review pile, since almost all of that dirt turned out to be
  trivially committable.
- Pure creation debris (git-invalid, 0 bytes or near-0, no provenance, not registered) — the
  `.tmpIBNq7t-d96ee0`/`operator-ac9328`-shaped cases. Zero risk, zero value in asking.

**Asks first (surface in Settings/a review list, one confirmation covers the batch):**
- Merged, clean or auto-committed, but **not** provenance-attributable — the 37-directory gap in
  defect #6. Same disk-safety profile as the auto-remove tier, but the codebase's own stated
  design principle ("the reaper may only remove what Operator can prove it made") means these
  need a human standing in for that missing proof, not silent removal.
- **Not** merged into the default branch, regardless of dirty/clean state — an unlanded branch may
  still be wanted; only the person who'd know can say so. Show branch name, last-activity
  timestamp (from provenance `createdAt` or the file mtimes), and size to make the decision easy.
- Git-corrupt but registered or provenance-attributable (none found in this snapshot, but the
  policy should cover it) — something is wrong with these that a script shouldn't paper over
  silently.

**What this buys, measured against today's snapshot:** the auto-remove tier alone reclaims
**11.85 GB now**, and — critically, since this audit's own numbers show the leak is dominated by
directories that never got a chance to go through *any* removal path — wiring the auto-remove
sweep into app boot and app quit (not just lane/project close, which already mostly works) is what
stops the 28.42 GB "unclaimed but git-registered" bucket from being the fast-growing majority
class it currently is.
