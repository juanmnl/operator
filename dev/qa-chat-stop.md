# QA: chat stop button — isolation experiment

**Brief:** `dev/briefs/chat-stop-does-nothing.md`. **Verdict: ESC works. The bug is not
in Claude Code's pty input handling — it's specific to Operator's stop-button write path.**

## What I could and couldn't do

I don't have AX/input-sim access to the real Tauri app window (per
`feedback_env_constraints`), so I couldn't literally click the stop button or type into
the live app's `TerminalPane`. Instead I ran the brief's isolation experiment — "type ESC
directly into Operator's own terminal surface for a running agent" — by faithfully
reproducing the pty side of that surface: a raw pty spawned with the **exact** recipe
`src-tauri/src/lib.rs`'s `terminal_spawn` uses (same shell invocation, same env, same
stripped vars), driven with the **exact** byte sequences Operator's own code writes
(`submit-queue.ts`'s bracketed-paste-plus-CR to submit, `lib/interrupt.ts`'s bare `\x1b`
to interrupt). This isolates the same variable the brief cares about — "how Claude Code
reads input under this pty" — without needing the Electron/Tauri chrome around it at all.

Script: `/private/tmp/.../scratchpad/pty_interrupt_test.py` (throwaway, not committed).
Raw pty logs for every run are alongside it as `pty_log_<mode>_<phase>.txt`.

### Harness recipe (matches production exactly)

- Spawn: `os.forkpty()` execing `zsh -ilc "claude --settings '{\"tui\":\"default\"}' --session-id <uuid> --permission-mode bypassPermissions"`, cwd = repo root — mirrors `terminal_spawn`'s `CommandBuilder` line for line.
- Env: strips `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_EXECPATH` (same set as `strip_nested_session_env`), sets `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=1`, `TERM_PROGRAM=iTerm.app` — same as production.
- Submit: `\x1b[200~<text>\x1b[201~\r` — verbatim from `submit-queue.ts:20`.
- Interrupt: a single `\x1b` byte — verbatim from `lib/interrupt.ts`'s `INTERRUPT_SEQ`.
- Pty size 100×30, matching Operator's default.

### Harness bugs I hit and fixed before trusting any result (worth recording so nobody re-derives them)

1. **First attempt used `sleep 40 && echo …` as the long-running command.** Claude Code's
   Bash tool has a *built-in* guard that blocks chained/long `sleep` commands outright
   ("`Error: Blocked: sleep 40 followed by: echo … To wait for a condition, use Monitor`").
   Not related to the bug under test — just the wrong tool for a synthetic long-runner.
   Switched to a CPU-bound one-liner: `python3 -c "print(sum(range(N)));print('BUSY_DONE')"`,
   `N` calibrated so the call takes ~40s wall-clock on this machine.
2. **Racing the paste against Claude Code's own startup drops the submit.** Sending the
   bracketed-paste+CR as soon as the banner's first byte appears lands mid-redraw and the
   trailing CR gets swallowed — the message sits unsubmitted in the composer forever (no
   error, no signal, just silence). Fixed by waiting for the pty to go idle (no bytes) for
   1.2s after the ready markers show up before submitting.
3. **Detecting "did it actually finish" by grepping for a literal marker string is
   unreliable.** The instruction text I send to Claude contains the marker word itself, so
   naive substring search matches on the *echo* of my own prompt, not the real result.
   Fixed by using a unique 20-digit computed value (`sum(range(4_600_000_000))`) as the
   completion signal — a number that can only appear as the actual printed output of the
   command running to completion, never as an echo of instruction text.
4. **Claude Code's own TUI draws "words" via cursor-column jumps, not literal spaces.**
   After stripping ANSI/CSI codes, `"esc to interrupt"` in the raw stream becomes
   `"esctointerrupt"` (no spaces) and `"⏺ Bash("` becomes `"⏺" … " Bash("` (glyph and word
   are non-adjacent). Any detection string built from what you'd expect to *read* on
   screen needs to account for this — I got silently-wrong "trigger never fired" results
   twice before catching it.

## Results

| run | phase ESC sent in | result |
|---|---|---|
| `single reasoning` | mid-"thinking", before the Bash tool call was even dispatched (~2s after submit) | **Interrupted.** Draft text restored verbatim into the composer, busy footer (`esc to interrupt`) cleared, back to idle prompt. |
| `single bash` | mid-execution of the real Bash tool call (~3s into a run that takes ~40s to finish on its own) | **Interrupted.** Transcript shows `⏺ Interrupted · What should Claude do instead?`, busy footer cleared, back to idle prompt. **No completion marker ever appeared** — confirmed the busy loop did not run to completion (it would have, well before this run's 120s deadline, had it not been cut off). |
| (earlier control, no ESC sent) | n/a | Busy loop ran to real completion at ~48-51s post-submit, printing the expected 20-digit sum — confirms the harness's "did it actually finish" detection is sound (it correctly reports completion when nothing interrupts it). |

Evidence excerpt from the `single bash` run (ANSI-stripped, from
`pty_log_single_bash.txt`), showing the actual mid-execution interrupt:

```
⏺Bash(python3 -c "print(sum(range(4600000000)));print('BUSY_DONE')")  ⎿  Running…
… (3s · timeout 10m)(ctrl+b to run in background) …
⏺Interrupted · What should Claude do instead?
```

Timeline for that run: prompt submitted at t=3.7s, Bash tool call visibly running by
t=19.1s, single `\x1b` sent at t=22.2s (≈3s into an execution that needs ~40s to finish
naturally), and the process was never observed to print its completion marker before the
harness's 120s deadline — i.e. it was cut off, not merely slow.

The session was not killed — after the interrupt, the pty returned to a normal, idle
prompt (`⏵⏵ bypass permissions on … · ← for agents`, no busy footer), exactly the
"hands the turn back, session survives" behavior the brief describes as the contract.
I terminated the harness's own forked pty afterward via `os.kill(<the one pid I forked>,
SIGTERM)` — a single targeted kill of a process I own, not a pattern-kill.

## Conclusion — which branch of the brief's decision tree

> "If typed ESC interrupts but the button does not → the difference is in the write path
> or its timing, not the byte. Instrument `terminal_write` and confirm the `0x1B` actually
> reaches the pty when the button is clicked."

**This is the branch that holds.** A single `\x1b` — the exact byte
`lib/interrupt.ts`'s `INTERRUPT_SEQ` already sends — reliably interrupts Claude Code
under this exact pty setup (`--settings {"tui":"default"}`), both mid-reasoning and
mid-tool-call. Hypothesis 1 (a lone ESC being ambiguous/absorbed) is **falsified** — I
never needed a double-ESC or a deliberate gap; a single byte worked cleanly both times I
tried it. I'd call the isolation experiment conclusive enough that the double/gap modes
in the harness (`double`, `gap`) aren't worth running — the single-byte case already
succeeds, so there's nothing left to disambiguate on the Claude-Code-input side.

**`INTERRUPT_SEQ = '\x1b'` is correct and needs no change.** The bug is somewhere between
the stop button's click handler and the byte actually leaving Operator's process — not in
how Claude Code reads it. Per the brief's own next step, that means instrumenting the real
write path (`operator-bridge.ts`'s per-terminal write queue → `terminal_write` → pty) at
the moment the button is clicked in the live app, which needs a human at the keyboard
(outside what I can drive). Two things worth checking there, going in:

- **The write queue is a chained promise per terminal id** (`operator-bridge.ts:29-33`,
  `writeQueues`). If a prior write for that terminal is still in flight when the button
  fires, the ESC queues behind it rather than jumping ahead — worth confirming the queue
  isn't backed up at the moment of a real click (e.g. right after a large paste).
  I didn't reproduce this in the harness since I only ever wrote one message at a time.
- Whether `busy`/`session?.terminalId` at the moment `onClick` fires is the *live* value
  or a stale render closure — the brief already confirmed the byte and the id are both
  correct in isolation, so this would only matter if there's a timing race between a
  re-render and the click, which I have no way to exercise without the real UI.

## Not run

Double-ESC and ESC-with-gap variants (hypothesis 1) — moot, see above. Hypothesis 3
(write lands but is swallowed on redraw / heal loop) — not tested here; it's specific to
Operator's own `TerminalSurface.tsx` rendering, which this pty-only harness doesn't
exercise at all (no xterm.js in the loop). If instrumenting `terminal_write` rules out the
write-queue and confirms the byte reaches the pty promptly on a real click, hypothesis 3
is the next thing to check.
