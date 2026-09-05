# Brief: simplification audit (Research lane) — 2026-09-05

Direction from Juan (2026-09-05): Operator narrows to what the landing
(`~/Developer/Operator-landing/index.html`, read the Tuning/Scope/Why sections)
now says the app is: open a project, launch agent sessions for specific work,
hand work between agents, and above all TUNE each lane's model and effort so the
plan runs close to its limit and never past it. Chat and Files views are unused
and go. Settings that don't do much go. Localhost port allocation must improve.

Report only. Do not change code. Write the result to `dev/results/simplify-audit.md`
AND call `mcp__operator__report` with a summary.

## 1. Removal map: Chat + Files
- MainView is `'terminal' | 'chat' | 'preview' | 'files'` (src/renderer/lib/pane-visibility.ts,
  DashboardView.tsx, SessionToolbar.tsx). List every file, store, IPC handler, electron main
  module, SQLite table (`~/.operator/chat.db`), keybinding (⌘J), test, and dev/drive-*.mjs
  harness that exists ONLY for chat or files (src/renderer/components/files/*,
  session/CanvasConversation.tsx, ChatComposer.tsx, CanvasPanel.tsx, etc).
- Flag shared dependencies: what do Plan/Diff/Comms log/TaskBoard/report rendering
  (ReportBody, CommsLog) import from the chat code that must survive? The transcript
  tailer must survive (tasks, dispatch sentinels, usage all depend on it).
- Estimate LOC removed and list tests that would be deleted vs. rewritten.

## 2. Settings that don't do much
- Inventory every setting in src/renderer/components/preferences/*, prefs/PrefsView.tsx,
  and any per-session settings (session-settings work, S4–S7). For each: where it is
  read, what behavior it changes, whether it is wired at all. Produce a table:
  keep / remove / fold-into. Bias hard toward remove. Keep = it changes a lane's model,
  effort, permissions, worktree, dev port, or check command; or appearance.

## 3. Localhost port allocation
- Trace how OPERATOR_DEV_PORT is reserved per session (electron/src/main/terminals.ts,
  port-attribution.ts, reap.ts, electron/PORT-LEDGER.md, src/renderer/lib/env-policy.ts).
  Known defects: orphans squatting ports (memory says 24 orphans, port 1420 squatted
  since Aug 20); lanes told "use port X" while another lane's server already serves
  the same code; reserved ports that are already bound by a stranger. Say precisely
  what the current allocator checks before handing a port out, what happens on close,
  and list concrete failure cases with file:line. Propose the smallest fix set.

## 4. Tuning gap vs. the landing
The landing claims: (06) model+effort per agent, edits `.claude/agents` files, effort
travels as a `--effort` flag; (07) usage per model/project/day from transcripts;
(08) plan meter: session %, week %, per-model cap, reset times, "no data" never 0%;
(09) diff review in place. For each claim, state what the app ACTUALLY does today
(electron/src/main/agents.ts, AgentLibraryView, usage dashboard, any plan-limit reading)
with file:line, and what is missing. Especially: is there any read of the plan's
session/week limits at all? Where would it come from (Claude Code `/usage`? OAuth
usage endpoint? statusline?) — verify against the INSTALLED claude binary, not memory.

## 5. (added 2026-09-05, after launch) Usage analysis that leads to a tuning decision
Juan: "we do need to bring back context, cost, usage per model, but some way we can
actually analyse to improve usage." So the usage surface is NOT removed; it is re-aimed.
Audit what the transcripts on disk (`~/.claude/projects/<slug>/*.jsonl`) can give per
turn: model, effort (from the launch flag / lane config), input, output, cache read,
cache write, context size at each turn, compaction events, tool_result bytes, subagent
fan-out, wall/API time. Then answer: which of these, sliced by lane/role, project, day,
and model, would tell Juan a concrete thing to change (move a lane to a cheaper model,
drop effort a step, shorten briefs, cut tool_result bloat, split a lane)? Also state
what the current usage dashboard (src/renderer/views/DashboardView.tsx and the usage
code) already computes vs. throws away, with file:line. Note the tension: the landing
says "tokens, never dollars" while Juan said "cost" — report both what a token view and
a plan-fraction view (share of session/week limit) could show; do not decide.

## Live evidence for part 3 (2026-09-05 14:20) + part 6: Diff panel "unavailable"
Port: Operator reserved 1425 for the operator lane (session f8fef5ba…, `--append-system-prompt
Operator reserve…`). `lsof -iTCP:1425` shows pid 93480 = `node …/huridocs/uwazi_app/app/node_modules/.bin/vite --port 1425 --strictPort`,
a DIFFERENT project. The lane's "is my port up? then another lane serves the same code" check
(curl → 200) was therefore wrong: the allocator handed out a port a stranger already bound, and
the liveness probe can't tell whose server answers. Other live servers: el-encanto worktrees on
1432/1433, web27 on 1434. See `~/.operator/dev-leases.json`.

Part 6 — the right panel of the operator lane shows "Diff unavailable / Couldn’t read the git
diff — it will retry on the next change" (screenshot at /tmp/operator-shots/diff-unavailable-2026-09-05.png),
while a toast says "Ready for review — operator-7d9000, 1 change" (that is the Research lane's
worktree; its 1 change is the untracked results file). The lane's cwd is the repo root on `main`,
with only untracked files, so `worktreeDiff` (electron/src/main/worktree.ts:156) should succeed.
The copy is NOT in main's src, NOT in any branch history (`git log --all -S`), and NOT in the
installed 0.20.0 renderer bundle (asar extracted, grep for "unavailable" hits only main/index.cjs).
Find where that copy comes from and why the diff read fails for a repo-root lane (candidates:
`execFile git` rejecting on stderr noise/maxBuffer, a timeout wrapper in the IPC layer, the panel
being fed a task cwd instead of the session cwd, or the running window loading a different bundle
than /Applications/Operator.app's asar). Report with file:line.
