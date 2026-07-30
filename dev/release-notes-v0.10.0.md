# Operator v0.10.0

Project-first navigation, a rebuilt chat view, and a dispatch loop that stops losing work.

## Projects come first

The launcher is now a **project gallery**. Opening a project scopes the whole app to it — the
sidebar shows that project's lanes and live sessions, and nothing else. The old always-all-projects
accordion is gone. Your last project is restored on relaunch.

Project cards carry a description you write yourself, the team's status at a glance, and what each
project is actually doing right now — "1 needs you" outranks "3 running", because if a lane is
waiting on you that's the thing worth saying.

## The chat view got serious

- **You can see it working.** A status line at the foot of the transcript says what the agent is
  doing and for how long. Only `running` and `compacting` animate — motion means busy, everywhere in
  the app.
- **You can stop it.** The composer's send control becomes a stop control mid-run. Previously there
  was no interrupt anywhere on the chat surface. It sends Claude Code's own interrupt — the session
  survives, the turn hands back.
- **The send control is now the lane's orb**, carrying its accent and its real state. One control,
  one identity.
- **Tool calls appear in the transcript** as first-class blocks, rather than the chat recording only
  what the agent *said* and never what it *did*.
- **The column is capped and centred.** It used to run the full width of the panel — around 180
  characters per line on a wide window, which is why it read as a log rather than as writing.
- Claude Code's internal plumbing (`<local-command-caveat>`, `/model` invocations,
  `<system-reminder>`) no longer renders as though you typed it — in new sessions *and* in history
  already on disk.

## Work stops going missing

- **Long dispatched tasks arrived truncated** — the first half submitted as a turn, the rest
  stranded in the composer, so a lane worked from a brief that stopped mid-sentence. The submit
  watchdog now scales with message length.
- **Stop no longer gets undone.** Interrupting cancels the pending submit nudge, which could
  otherwise re-submit the restored draft seconds later and silently restart the work you just
  stopped.
- **Tasks stop being stuck in `running` forever.** A task stamped with a pty id could never be
  matched again after a restart, so it stayed "running" permanently — one project had 26 running and
  zero done. Stale entries are now reconciled at startup.
- **Rosters start empty.** New projects no longer arrive pre-populated with six agents nobody asked
  for. Lanes are added on demand — one click from a preset, or created automatically when a dispatch
  is addressed to one. A dispatch naming an unknown lane lands in a visible backlog instead of
  vanishing.

## Settings and fixes

- One shared page template across Preferences, Claude files, and the Agents hub — consistent titles,
  section headers and measure, enforced by a test rather than by convention.
- Sidebar hover cards no longer stick to the screen when the pointer leaves the window.
- The project page header no longer sits 84px too low.
- The launch splash can no longer hang indefinitely: the reveal is now guaranteed outside React, so
  a render failure shows the app rather than a blank splash forever.
- A contrast rule that had been hand-swept four times is now enforced in the test suite.

---

## Known issues

**⚠ The ✕ on a lane card deletes the lane, not the session.** On the project's agent board, ✕
removes that lane's whole configuration — model, effort, accent, charter — and unassigns its tasks.
There is no confirmation and no undo, and if the lane was running, its session keeps going without a
lane to represent it. **Avoid ✕ on the agent board in this version.** To stop a running agent, use
the session's own close control in the sidebar, or the stop control in chat.

If you hit it: re-add the lane from `+ Add agent` on the project's agent board — the preset restores
its configuration. Tasks that were assigned to it will be sitting unassigned in the backlog and need
reattaching. Fixed in 0.10.1.

**The six-palette contrast sweep could not complete** on the release host (WebKit ran out of memory
under load). Two palettes verified clean. If something reads poorly on a light theme, that's worth
reporting first.
