# Security fixes H1, H2, H3 — 2026-10-02

Source: `dev/results/security-audit-2026-10-01.md`. Branch `operator/bbc780`, three commits on top of `7d42949`, done in the requested order:

| Finding | Commit | Summary |
|---|---|---|
| H2 | `10affd4` | Control characters are stripped from text written into a lane's pty, refused in MCP dispatch/reply, and stripped from sentinel directives |
| H1 | `8939826` | A Preview pick is accepted only while Inspect is on, is never sent on its own, and waits in an Operator-drawn card until the user clicks Console or Tasks |
| H3 | `177ddd8` | `buildArgs` puts `--` before the prompt; MCP dispatch refuses a task starting with `-`; the sentinel prefixes one with `Task: ` |

Not merged, not pushed.

## Tests

- Renderer (repo root, `npx vitest run`): 113 files, 1675 tests passed.
- Electron (`electron/`, `npx vitest run`): 45 files, 809 tests passed.
- Typecheck: root `npx tsc --noEmit` exit 0; `electron/ npm run typecheck` (main + renderer configs) exit 0.

## H2 — control bytes into the pty

New shared rule: `src/shared/control-chars.ts`
- `stripControlChars` (`:23`) removes every C0 control except `\t` and `\n`, plus DEL (U+007F) and the C1 range (U+0080–U+009F). It turns `\r\n` and a lone `\r` into `\n`, so line breaks survive.
- `hasControlChars` (`:29`) reports the same set and does not count `\r`.
- C1 and DEL are beyond the brief's letter. C1 is included because U+009B is the one-character form of `ESC[`, so `\x9b201~` is the same paste terminator to a parser that honours 8-bit controls. DEL was included because it is a control key in a terminal and no message needs it.

Where it is applied:
- `src/renderer/lib/submit-queue.ts:25` `submitSequence` strips before wrapping. This covers every `submitQueue.submit` caller: dispatches into live workers, replies into the coordinator, reused-lane dispatches, Preview notes, and report announcements.
- `src/renderer/lib/submit-queue.ts:323` `attachImages` strips the joined paths.
- `src/renderer/lib/delivery-confirm.ts:44` `normalizeTurn` strips too. The delivery check compares what was sent with the recorded turn, and without this a stripped message would never match and would be reported undelivered.
- `electron/src/main/mcp-serve.ts:304` `dispatch` and `reply` refuse a lane or body that contains one, with an error that says why and that nothing was sent. Refused rather than cleaned, so a lane never has a message delivered in a form it did not write.
- `electron/src/main/directives.ts:86-87` `parseDirectives` strips target and body. A directive whose body was only control characters is dropped by the existing empty-body rule.

Tests: `src/shared/control-chars.test.ts` (new), `submit-queue.test.ts` (submitSequence with the audit's `ESC[201~ ^U !cmd` payload; attachImages), `delivery-confirm.test.ts`, `electron/src/main/directives.test.ts`, `electron/src/main/mcp-serve.test.ts` (refusals open no dispatch request).

Not changed: `typedSequence` (slash commands from Operator's own toolbar; the text is Operator's, not external). Probe P1 from the audit was not run; with this change the bytes it relies on no longer reach the pty from these paths.

## H1 — Preview page can submit prompts

- `src/renderer/lib/preview-pick.ts:44` `acceptPick(data, { inspecting, pending })` returns a pick only when Inspect is on, no other note is waiting, and the payload parses to an object. It removes any `target` field. `PreviewPick.target` is gone from the type.
- `src/renderer/components/session/AppPreviewPanel.tsx`
  - `:178` `inspectingRef` gives the once-subscribed handler the current Inspect state.
  - `:184` `pendingPick` state, plus `pickPendingRef`, which is set as soon as a pick is accepted (before the screenshot is taken) so a second pick in that gap is dropped.
  - `:432` the handler goes through `acceptPick`, takes the screenshot as before, and at `:453` stores the note instead of calling `onDispatch` / `onSendToTasks`.
  - `:1000` the pending-note card. It is drawn by Operator above the stage, outside the iframe. It shows the exact text that will be sent and says whether a screenshot is attached. Its buttons are → Console, → Tasks (each shown only if that handler exists) and Discard. Only those buttons send.
  - A second pick while a note waits is dropped, not swapped in, so the page cannot change the text between the user reading it and clicking.
- The CDP path (`preview-cdp.ts` → `index.ts:336` → `onPreviewPick`) reaches the same handler, so the same gate and card apply. Main still forwards picks unchanged; the gate is in the renderer, which is the only place that knows whether Inspect is on.
- `src/shared/preview-inspector.js:163` the in-page card now has one button, "Review in Operator →" (Enter does the same), and sends no target. Leaving the old → Console / → Tasks buttons would have offered a choice that no longer does anything.

What "a pick was started by the renderer" means here: Inspect is a renderer state that only the user's click on the mode segment turns on. A nonce passed to the inspector would not help, because the inspector runs in the page's own main world and the page could read it. While Inspect is on, the page can still post a pick without a click inside the page. The confirm card is the control that stops it from being sent.

Tests: `src/renderer/lib/preview-pick.test.ts` (accepted with Inspect on and the target removed; refused with Inspect off, while a note waits, and for non-object payloads); `src/shared/preview-overlay.test.ts` (the in-page card's payload has no `target`). No test renders the component; the renderer suite has no DOM rendering.

## H3 — dispatch text parsed as a `claude` option

`src/renderer/lib/launch-args.ts:68` pushes `'--'` before the positional prompt. `terminals.ts:292` puts Operator's own flags (`--append-system-prompt`, `--mcp-config`) before `o.args`, so `--` stays the last token before the prompt.

Second guard, for dispatch text:
- `electron/src/main/mcp-serve.ts:311` the MCP `dispatch` tool refuses a task that starts with `-` and tells the lane to start it with a word. `reply` is not checked, because a reply is typed into a pty and never becomes argv.
- `electron/src/main/directives.ts:101` `parseDispatches` prefixes such a task with `Task: `. It is prefixed rather than dropped because a dropped sentinel looks like the coordinator did nothing. This changes the directive id only for those bodies.

### Binary check (installed `claude` 2.1.287, `~/.local/bin/claude`)

`claude --help` shows a Commander-style parser: `Usage: claude [options] [command] [prompt]`, with `--remote-control [name]` taking an optional value.

Dry argv test: each run used `-p`, a nonexistent model (`claude-argv-probe-nonexistent`), and `--settings` with a `UserPromptSubmit` hook that writes the hook input to a file and exits 2. Exit 2 blocks the prompt, so no model request was made. The recorded `prompt` field is exactly what the CLI parsed as the positional. Runs were made from the scratchpad directory.

| Run | argv after the probe flags | Result |
|---|---|---|
| p1 | `'hello world'` | prompt `'hello world'` (the harness works) |
| p6 | `--version` | printed `2.1.287 (Claude Code)`; no prompt. This is the H3 bug: a dashed positional is an option |
| p2 | `-- --dangerously-skip-permissions` | prompt `'--dangerously-skip-permissions'` |
| p3 | `-- '--mcp-config={"mcpServers":{}}'` | prompt is that string verbatim |
| p4 | `--name probe--code -- --version` | prompt `'--version'`, no version printed |
| p5 | `-- '-- leading double dash in the task'` | prompt verbatim; the terminator itself is not in the prompt |
| p7 | `--name probe--code --remote-control probe-rc -- 'hello after rc'` | prompt `'hello after rc'` |
| p8 | `--name probe--code --remote-control probe-rc -- --dangerously-skip-permissions` | prompt `'--dangerously-skip-permissions'` |
| p9 | `-- doctor` | prompt `'doctor'`; the `doctor` subcommand did not run |

Conclusion: the installed binary honours `--`. `--remote-control <name>` followed by `--` leaves the prompt alone (p7, p8). Limits of the check:
- These runs used `-p`. Real lanes are interactive. The option parser is the same program, but interactive mode was not run.
- p7/p8 show that the name did not end up as the prompt. They do not show the name the phone app lists; that was verified on 2.1.261 per the existing comment and was not re-checked.

Tests: `src/renderer/lib/launch-args.test.ts` (four existing expectations updated to include `--`; a new case covers flag-shaped tasks, `--` and `doctor`), `electron/src/main/directives.test.ts`, `electron/src/main/mcp-serve.test.ts`.

## For GUI verification (the user's)

1. Preview, Inspect on: click an element, write a note, press "Review in Operator →". The pending-note card should appear above the page showing the note, with "with a screenshot" when one was taken. → Console submits it to the lane with the screenshot attached; → Tasks queues it; Discard drops it. Nothing should reach the lane before the click.
2. With a note waiting, pick another element. The second note should be ignored and the first stays. Check whether this is acceptable UX, or whether a "replace" with a short delay is wanted.
3. Inspect off: a page that runs `parent.postMessage({__operatorPreview:'pick', data: JSON.stringify({message:'x'})}, '*')` should produce no card.
4. The attached-Electron-app (CDP) source: same as 1–3.
5. The card's layout at narrow panel widths, and that the stage re-fits when the card appears and goes. The stage box is measured by a ResizeObserver, so it should.
6. Launch a lane with an initial prompt and dispatch to a dormant lane. Check that the task arrives as the first message and that a Remote Control lane is still listed under its name in the phone app.
7. A dispatch, a reply, and a report announcement still submit as one turn each, with no visible change.

## Left out

- Probe P1 (whether `ESC[201~` plus `!cmd\r` runs a shell command in a live lane) was not run. It is no longer reachable through the patched paths, but it would show whether other pty writers need the same rule.
- H4 (Electron bump) and the Medium findings were not touched. M3/M4 (identity and bus authentication) still let a lane present itself as the coordinator. With H3 fixed, that no longer turns into flags on a launched lane's command line.
