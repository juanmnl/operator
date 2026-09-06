# "Diff unavailable" panel — trace

Brief: `dev/briefs/diff-panel-unavailable.md` (main, `f1836e6`). Report only, no code changes.

## Summary of the finding up front

The exact copy **"Diff unavailable / Couldn't read the git diff — it will retry on the next
change" does not exist anywhere** — not in current `src/` (either worktree checked), not in any
reachable git commit in this repo's history (verified beyond the coordinator's own check: I
re-ran `git log --all -S` with the curly-apostrophe variant Operator's copy style actually uses,
and walked the full commit history of all three diff-consuming components file-by-file), and not
in the currently-installed `/Applications/Operator.app` 0.20.0 bundle (re-extracted the asar
myself and grepped it directly). None of the three live diff surfaces render this text on
failure today — see §3. The most consistent explanation, laid out in §4, is that the running
process (pid 55647, up 3.5 days) is showing an in-memory renderer bundle that has since diverged
from what's on disk — not a live bug in the current code path.

---

## 1. Where does the copy come from?

**It doesn't come from anywhere in the current app.** Concretely, ruled out:

- **`src/` on both `main` and this worktree**: `grep -rn "unavailable"` across `src/renderer`,
  `src/shared`, and `electron/src` returns no match for this text (only unrelated hits: a
  code-signing tray-icon fallback log line, an MCP artifact-store error, etc.).
- **Git history, all refs**: `git log --all -S"Diff unavailable"`, `git log --all
  -S"Couldn't read the git diff"` (straight apostrophe), and `git log --all -S"Couldn't read the
  git diff"` (curly apostrophe, Operator's actual house style — see `CanvasDiffPanel.tsx`'s own
  "session's working tree") all return exactly one commit: `f1836e6`, the commit that added
  *this investigation's own brief file* quoting the string as prose. That's a self-reference, not
  a source hit. I also walked the full commit-by-commit history of every file that has ever
  implemented a diff-error state — `CanvasDiffPanel.tsx` (7 commits, `b5d1405` through `9525a28`),
  `DiffPanel.tsx` (4 commits, `261d6c5` through `a22568d`) — and none of them, at any point in
  their history, ever rendered this text. `CanvasDiffPanel.tsx` has swallowed its fetch error
  with a bare `.catch(() => { if (!cancelled) setLoaded(true) })` since the file was introduced.
- **The installed bundle**: extracted `/Applications/Operator.app/Contents/Resources/app.asar`
  directly (`npx asar extract`) and grepped the whole tree, including `out/main/index.cjs` and
  `out/renderer/*` — no match for "unavailable" anywhere. `package.json` inside confirms
  `"version": "0.20.0"`. Checked `DEV_URL`/`OPERATOR_ELECTRON_URL` handling in the main bundle
  (`out/main/index.cjs:27908`) — it's `null` unless that env var is set, and a packaged
  `/Applications/Operator.app` launch wouldn't set it, so this is genuinely loading from its own
  asar, not a dev server.
- **The preload bridge**: `electron/src/preload/index.ts:20` is a flat generic proxy
  (`ipcRenderer.invoke(channel(method), ...args)`) — no error-text injection happens there either.

So the copy is not synthesized anywhere in the current pipeline, on either shell.

## 2. Why does the diff read fail for a repo-root lane?

Reproduced the exact commands `worktreeDiff` (`electron/src/main/worktree.ts:156-198`) runs, in
both locations named in the brief:

**`/Users/juanmnl/Developer/operator`** (repo root, 30 registered worktrees via `git worktree
list`):
```
git status --porcelain     0.020s total
git diff HEAD --no-color   0.017s total
git diff HEAD --numstat    0.014s total
git rev-parse --abbrev-ref HEAD   0.010s total
```
All four calls `worktreeDiff` makes are sub-25ms. **No timeout risk from worktree count** — 30
registered worktrees don't slow `git status`/`git diff` measurably; those commands don't scan
sibling worktrees at all, they operate on the current worktree's index and HEAD.

Also notable: **the repo root is currently clean** (`git status` → "nothing to commit, working
tree clean", `git status --porcelain` → 0 lines). The brief describes the operator lane's cwd as
having "only untracked files" as of the 2026-09-05 screenshot — that state doesn't match what's
on disk right now, so either it was resolved between the screenshot and this check, or the lane
in question wasn't actually root at `/Users/juanmnl/Developer/operator` at screenshot time.

**`~/.operator/worktrees/operator-7d9000`** (this worktree) — same four commands, same result:
all sub-20ms, no untracked files, clean tree relative to its own branch.

**The `maxBuffer: 16 * 1024 * 1024` (`worktree.ts:25`)** is not implicated by anything
reproducible here — a clean or small-diff repo never approaches it, and `execFileAsync` would
throw `ENOBUFS`-style errors distinctly (not silently) if it were hit, which the current
`git()` wrapper (`worktree.ts:21-30`) surfaces as a rejected promise with `stderr`/`message` —
that rejection is exactly what `CanvasDiffPanel.tsx:19`'s `.catch()` swallows today, and exactly
what would need to happen for *any* current-code error state to fire, empty or otherwise.

**Conclusion for this part:** I could not reproduce a slow or failing `worktreeDiff` call against
either path today, at current repo state. The timeout/worktree-count hypothesis in the brief
isn't supported by measurement — these commands are fast regardless of how many worktrees are
registered against the same repo.

## 3. Which panel is this?

**The session's right-panel "Diff" tab — not a task diff card.**

- `CanvasPanel.tsx:15,17` defines the tab set `'plan' | 'diff' | 'chat' | 'files'` with label
  `diff: 'Diff'`, and `CanvasPanel.tsx:107` renders `mode === 'diff' && <CanvasDiffPanel
  path={session?.workingDirectory} />` — this is the surface a repo-root session shows under its
  "Diff" tab.
- `CanvasDiffPanel.tsx:21` polls `worktreeDiff` on a 3-second `setInterval` — this matches the
  brief's copy "it will retry on the next change" far better than either alternative: `DiffPanel`
  (the separate Review surface, reached via the footer's Review button) fetches once with no
  polling (`DiffPanel.tsx:35-39`), and `TaskDiffCard` (the inline expander under a task row on
  the TaskBoard, fed a *task's* `cwd`/branch provenance rather than a live session's) also fetches
  once on mount (`TaskDiffCard.tsx:18-22`) and shows its own distinct copy on failure — "No diff
  to show — no changes, or the worktree and branch are gone" (`TaskDiffCard.tsx:56-59`) — which
  doesn't match the screenshot's text either.
- So by elimination and by the "retry" language matching only the polling surface: **this is the
  session Diff tab (`CanvasPanel` → `CanvasDiffPanel`), fed the session's own `workingDirectory`
  — i.e. the operator lane's repo-root cwd directly, not a task's provenance.**

## 4. What's actually going on, given the copy doesn't exist in current code

Three independent facts point the same direction:
1. The string is absent from all reachable git history, ever, in any commit.
2. The string is absent from the app currently installed on disk (0.20.0).
3. The one component whose behavior best matches the brief's description (a 3-second poll,
   `CanvasDiffPanel`) has *always* swallowed its fetch error silently, at every point in its own
   git history — it never had a rendered error state to lose.

That combination means the process actually showing this text is not executing anything that's
ever existed in this repository's source. The most consistent explanation: **pid 55647 is
running a renderer bundle already loaded into memory before the on-disk app was last replaced**,
and that in-memory bundle's `CanvasDiffPanel` (or an ancestor/experimental version of it) once
had this error copy, in a version whose source never made it into the surviving git history —
plausible if it existed transiently in a lane's uncommitted worktree state that a release build
picked up from a dirty checkout, or in a branch that was later squashed/rebased away before
merging. Electron never re-reads its asar into an already-open, never-navigated SPA window, so a
background auto-update replacing files on disk would leave a long-running process exactly like
this: reporting whatever version string it always has, indefinitely running whatever JS it
already loaded, until the app is fully quit and relaunched. Uptime (3.5 days) lands right around
when 0.20.0 published (`electron-v0.20.0`, 2026-09-01), which is consistent with a launch near
that release followed by some on-disk change since that the running process never picked up.

This is inference from elimination, not something I can directly prove without the specific
binary pid 55647 loaded from (already overwritten on disk). It is not a live bug in the diff-tab
code as it stands today; the code as it stands today has a *different*, smaller bug instead: on a
failed `worktreeDiff` call, `CanvasDiffPanel` shows "No changes" (a false negative) rather than
any error, because `diff` stays `null` and the empty-array fallback in `diff?.files ?? []` reads
identically to "fetched successfully, zero files changed" — see `CanvasDiffPanel.tsx:19,25`. That
gap is real and current, independent of whatever pid 55647 is doing.

## Recommendation (reporting, not deciding)

- Quit and fully relaunch Operator.app (not just close the window) to confirm the panel then
  behaves like current source — most likely reverting to "No changes" rather than clearing to a
  correct diff, since that's what today's code actually does on any fetch failure.
- Separately worth a ticket regardless of the above: `CanvasDiffPanel`'s silent swallow means a
  genuine, ongoing `worktreeDiff` failure is indistinguishable from "no changes" — the exact
  false-negative shape the plan-limits work elsewhere in this codebase (`absent is not zero`) was
  built specifically to avoid. Surfacing the error would have made this investigation unnecessary
  in the first place.
