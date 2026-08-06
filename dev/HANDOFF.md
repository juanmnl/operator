# Handoff — 2026-08-06

## ▶ STATE: v0.15.1 IS PUBLISHED

Tag `v0.15.1` at `fcbb247`, `main` pushed, CI signed + notarized, live on `operator-releases`
with `latest.json`, `Operator.app.tar.gz` and `Operator_0.15.1_aarch64.dmg`. 701 tests, `tsc` and
`build` clean.

**The first tag build failed at 0s** on a GitHub-side `Internal Server Error occurred while
resolving` for `actions/checkout@v4`, `setup-node@v4`, `dtolnay/rust-toolchain`, `Swatinem/
rust-cache` — infrastructure, not us. `gh run rerun <id> --failed` was green. Worth knowing before
anyone debugs a release that never built.

### What shipped in 0.15.1

- **A pile of toasts collapses.** Identical toasts coalesce to one card with a `×N` chip; a stack of
  2+ grows a worded **DISMISS ALL**; the column caps at 4 with a `+N earlier` marker. Dismissal is
  presentation only — an undelivered dispatch stays `undelivered` in the project log.
- **The rail foot folds.** Agents · All projects · Open folder · **Plan usage** stay resting; the
  two `.claude` shortcuts, Preferences and the theme toggle go behind the seam. Plan usage is the
  one override on frequency — a meter you must unfold to read is one you check too late.
- **README caught up** with task-scoped lanes, the `operator__report` / `operator__task_status`
  surface, worktree lifetime, and Close vs Shelve.
- 28 brief/result docs written inside lane worktrees had never reached `main`. Committed
  (`5046d39`); working tree is clean.

## ⚠ UNMERGED AND UNVERIFIED BY ME: `operator/6e13d8`

Two commits from the Code lane, both built and self-reported green, **neither merged nor
independently re-run**:

- `caa6bfc` **Confirm delivery from the lane's message QUEUE, not only its turns** — the false
  "never started the task it was sent" reports.
- `c33df60` **Only the pane you are looking at resizes its pty** — the orb wake-up.

```
git merge --no-ff operator/6e13d8 && npm test && npx tsc --noEmit
```

Do that before trusting either. The last lane that said "landed in `<branch>`" had **zero commits
on it** (see Process, below).

## The two diagnoses behind those commits — keep these, they cost real time

### Why good dispatches were reported lost

A prompt typed into a lane that is **mid-turn** never becomes a `user` transcript entry — Claude
Code records it as a queued enqueue and only turns it into a real turn at the next turn boundary.
`delivery-confirm.ts` matches on `kind: 'user'` turns inside a ~34s budget
(`RESCUE_AFTER_MS` 30s + `CONFIRM_WINDOW_MS` 4s), so any lane working longer than that had its
perfectly good message declared lost. **52 of 62 recorded `undelivered` outcomes were false.** The
two lanes named in the user's screenshot were the coordinator and Code — the two that are almost
always mid-turn, which is the tell.

The design had already, correctly, rejected "the lane became busy" as a *confirm* signal. What was
missing is that busy is a reason **not to declare failure yet**.

**Still open: ~4 of the 62 were REAL losses** — writes into a lane tab that was already dead. That
is a different bug with a different fix (route to the resume path; don't write to a dead terminal)
and nobody is on it.

### Why switching lanes animated every orb

Not the rail (its `collapsed` doesn't depend on lane selection) and not the Console⇄Chat⇄Preview
toggle (an overlay, deliberately, so the terminal never resizes). The actual chain:

1. Every terminal pane, **across every project**, is a sibling in one unfiltered `terminals.map(...)`
   (`DashboardView.tsx:4162`), each `position:absolute; visibility:hidden|visible` — and
   `visibility:hidden` still has a **measurable box**, so hidden panes' `ResizeObserver`s fire.
2. The Plan/Diff panel is **per-session** state rendered as a flex *sibling* of the terminal
   container. Switching to a lane whose `panelOpen` differs mounts/unmounts it → the `flex:1`
   container genuinely changes width → every pane resizes for real.
3. `terminal_resize` → `TIOCSWINSZ` → SIGWINCH → every Claude Code TUI redraws → bytes back →
   `note_activity` (`lib.rs:235`) → `transcript.rs:992` forces `phase = "running"` for 1.5s.

**Measured 5 of 5 mounted terminals resized per switch → 1 after the fix.** The fix is the guard
`GridTerminalPane.tsx:263-269` has always had; `TerminalPane` never got it.

Second-order, checked and benign: a spurious `running` does **not** re-arm the keep-warm timer —
`lastActivityAt` comes only from a transcript line's own timestamp, never from `note_activity`.
Two separate clocks. It can make a close-eligible lane transiently ineligible for 1.5s
(`lane-lifecycle.ts:93`); low odds, and it goes away with the fix.

## Process notes from this round

- **A lane reporting "landed in `operator/63f860`" had committed nothing** — the branch was at
  `main` HEAD exactly, all work uncommitted in its worktree. Verify with
  `git log main..<branch>` before believing a hand-off. (It committed properly when told.)
- **Raw NUL bytes in a `.tsx` source make git treat the file as binary.** A coalesce key used
  literal NUL separators inside a template literal; `Toast.tsx` showed as `Bin 6957 → 15839` —
  no diff, no merge, no blame. Use an escape. Check `git diff` renders as text before committing.
- Briefs still have to be **copied into each live lane worktree** before dispatching; a lane cannot
  see an uncommitted file in the main repo. `operator__brief` would end this.

## Also open

- **Renderer killed and respawned hourly at ~1.1–1.2GB** — the user experiences this as "the app
  restarts". Retention is *not* lane-scoped (closing 17 of 27 lanes freed ~8MB/lane), so fewer
  lanes is not the fix. `dev/briefs/2026-08-06-renderer-heap-RESULT.md`.
- The **stale `dev/HANDOFF.md` this replaces** was from 2026-07-28 and described v0.10.0. If you
  are reading a handoff older than the current release, distrust it.
