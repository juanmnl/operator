# Brief: "Diff unavailable" on a repo-root lane (Research lane) — 2026-09-05

The operator lane (cwd = repo root on `main`, only untracked files) shows in its right panel:
"Diff unavailable / Couldn’t read the git diff — it will retry on the next change".
Screenshot: /tmp/operator-shots/diff-unavailable-2026-09-05.png. Running app: /Applications/Operator.app
0.20.0, pid 55647, up 3.5 days. It has been happening "for a bit now" (Juan).

Facts established by the coordinator: that copy is NOT in `src/` on main, NOT in any ref
(`git log --all -S`), and NOT in the installed bundle (asar extracted; grep for "unavailable"
hits only out/main/index.cjs). `worktreeDiff` is electron/src/main/worktree.ts:156; the renderer
callers are CanvasDiffPanel.tsx:17 (swallows errors, 3s poll), DiffPanel.tsx:36, lib/task-diff.ts:33.

Answer, with file:line:
1. Where does the copy come from? (Check the electron main bundle out/main/index.cjs, the
   preload, `worktree_diff` error mapping in ipc.ts, and whether the window loads a DEV_URL.)
2. Why does the diff read fail for a repo-root lane? Reproduce by calling the same git commands
   worktreeDiff runs in /Users/juanmnl/Developer/operator and in ~/.operator/worktrees/operator-7d9000;
   note timing (the repo has ~40 worktrees; is `git status` slow enough to hit a timeout?), and
   the 16MB maxBuffer.
3. Which panel is this — the session Diff tab or a task diff card fed a task cwd?
Report only. Write `dev/results/diff-panel-unavailable.md` and call `mcp__operator__report`.
