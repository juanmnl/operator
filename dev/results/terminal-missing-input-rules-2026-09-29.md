# Missing input rules (─ above and below the `❯` prompt) — research, 2026-09-29

Read-only. No tracked file changed. Scratch harness is untracked in `dev/results/_scratch/`.

## Verdict

**Not reproduced, so the cause is not found.** Every layer I could replay in this checkout is clean: xterm's buffer, xterm's DOM and the painted pixels, in a real Chromium, for the installed Claude Code 2.1.284. What the screenshot shows is that the two rule rows are blank on screen, not faint. That points at the live app only. Below: what was ruled out, what is still open, and a cheap instrument to settle it the next time it happens.

## What the screenshot shows (verified from pixels)

`missing-input-borders-2026-09-29.png` is 1366x500. Row pitch is about 31 px. Spinner row at y≈215, `❯` at y≈308, footer at y≈370. The rows at y≈277 and y≈339 are exactly the background colour: no pixel within 3 levels of the background in x 60..1360. So the layout is Claude's normal frame (spinner, blank, RULE, `❯`, RULE, footer) with both RULE rows blank. The footer is `· esc to interrupt · ← for agents`, which is a different footer from the one in my captures (`⏵⏵ auto mode … · esc to interrupt`). `for agents` is in the 2.1.284 binary (4 hits), shown when subagents/background tasks exist. That state is not covered by my captures (see "Not tested").

## Confirmed (measured here)

1. **Claude 2.1.284 always emits both rules.** Captured real pty streams with `claude --settings '{"tui":"default"}'` at 120, 60, 40 and 25 columns, idle and mid-turn (spinner, streaming answer, "Cooked"). Every frame has `─` x cols above and below the prompt, colour `38;2;136;136;136` (no SGR 2 dim). Claude wraps every frame in `?2026h`/`?2026l` (synchronized output), 43 frames in a 40-line answer. No `?1049h`, no `2J`/`3J`.
2. **xterm's buffer keeps them.** Replayed through xterm 6.0.0 with UnicodeGraphemes and `stripOrnaments`, evaluating at every `?2026l`: 0 frames missing a rule at 120/60/40/25 cols (`dev/results/_scratch/replay.stest.ts`, run with `npx vitest run --config dev/results/_scratch/vt.config.mjs`). A capture with SIGWINCH resizes mid-turn (120→70→120→45→120→90) also ends with both rules present. Note the check must use the last `❯` row: the submitted message is also a `❯` row.
3. **The DOM keeps them.** Chromium (playwright, same engine as Electron) with `buildTerminalOptions()` and the production repaint cadence (180 ms throttle, 90 ms settle), stream written in chunks of 64, 200, 700, 1024 and 4096 bytes with 16 ms gaps (mirrors `pty-batch.ts` FLUSH_MS), with and without resizes: outside synchronized-output mode, DOM row text equals buffer row text in 100% of frames (`dev/results/_scratch/drive.mjs`). Inside sync mode the DOM is intentionally stale until `?2026l` (xterm holds rendering, up to 1 s).
4. **The pixels keep them.** Final Chromium screenshot (`final-c120.bin.png`) draws both rules at full width.
5. **`stripOrnaments` cannot remove them.** `src/renderer/lib/terminal.ts:44` replaces only U+1F000–1FAFF; U+2500 is outside. 2.1.284 no longer emits an ornament on the divider at all in these captures.
6. **Fonts cannot drop them.** None of the four bundled subsets (`operator-symbols/legacy/emoji/dingbats.woff2`) contains any of U+2500–257F (checked with fontTools), so `─` always comes from SF Mono.
7. **Pty batching is byte-preserving.** `electron/src/main/pty-batch.ts` only concatenates reads; a batch can split a `?2026h … ?2026l` frame, which xterm handles (item 3 covers 64-byte splits).
8. **The scrollback freeze fix is unrelated.** It changes `scrollback`/viewport sync only (`terminal-options.ts` applyPaneActivation); nothing in it writes or clears rows.
9. **xterm's sync-output code looks right.** `RenderService.ts` (from the shipped source map): `?2026l` fires `onRequestRefreshRows` → `refresh(0, rows-1)` → `refreshRows` flushes the buffered range; the 1 s timeout forces a full refresh. I found no path that drops a row range.

## Old notes re-tested

`project_terminal_ornament_width_drift.md` (WKWebView era) says the buffer is clean and the garble was compositor-level. That still holds for buffer and DOM, now also on Chromium. Its ornament-width story is obsolete for 2.1.284 (no ornament). The heal code in `TerminalPane.tsx:370-480` (hardRepaint, `rebuildLayer` every 1 s while output is < 6 s old) was written for WKWebView; on Electron it still runs, and I have no evidence either way on whether it helps or hurts here.

## Not tested / open (inferred, not confirmed)

- **The `← for agents` state.** I tried to capture a session with a subagent running; the auto-mode classifier blocked launching Claude with `--permission-mode bypassPermissions`, so I did not pursue it. The footer in the screenshot proves that state was active. The binary has a `borderStyle` helper that returns no border props for one of its inputs (`function oM(h,v){if(v)return{};return{borderColor:…,borderStyle:"round",borderLeft:!1,borderRight:!1,borderBottom:!0}}`, and the main input calls `oM(mode, Fr)`), but minified names make it impossible to say from strings alone what `Fr` is. **Leading hypothesis (inferred): with subagents/background tasks running, Claude 2.1.284 itself draws the composer without rules, or as a frame the buffer shows differently.** This would not be an Operator bug. A user can test it in Terminal.app: same lane state, do the rules disappear there too?
- **Live-only layers**: the exact Electron build's compositor (I used stock playwright Chromium), GPU raster, a pane that was hidden and re-shown (`bgBuffer` path, `TerminalPane.tsx:487-505`), a renderer under memory pressure (~1.1 GB respawn).
- **Frame-boundary race under real load**: my harness feeds a captured stream; a live lane with several other lanes rendering may hit xterm's 1 s sync timeout (`SYNCHRONIZED_OUTPUT_TIMEOUT_MS`) if a `?2026l` is late; that would show a stale DOM, not blank rule rows only, so I rate it unlikely for this symptom.

## How to settle it (no code change needed to start)

The composer-ghost probe already exists (`lib/ghost-probe.ts`; enable with `localStorage.setItem('operator.terminal.ghostProbe','1')`, then Ctrl+Alt+Shift+G while the rules are missing). It prints the bottom 8 rows' buffer text next to their live DOM text:
- buffer has `─` rows, DOM blank → xterm/DOM renderer or sync-mode hold (Operator side).
- buffer and DOM both lack them → the bytes never arrived or were overwritten → Claude's frame (check the lane state: subagent running?) or a byte-level ordering problem.
- buffer and DOM both have them but pixels blank → compositor/paint (Electron), and the heal in `TerminalPane.tsx` is the place to look.

Also useful: note the lane's exact `claude` version (the harness used 2.1.284; installed versions are 2.1.282–284) and whether the lane had a subagent or background task running.

## Proposed fix

None yet: no defect isolated. Recommended next steps, in order:
1. Turn on the ghost probe in the daily-use build and record the three-way result at the next sighting (cheap, read-only).
2. Capture a lane with a subagent/background task running from a normal session (not through my harness) and replay it with `dev/results/_scratch/replay.stest.ts`; if Claude omits the rules in that state, close as a Claude Code behaviour and note it in the hub.
3. Only if the probe shows buffer correct and DOM/pixels blank: add a rule-row check to the heal so a `─` row present in the buffer but missing in the DOM triggers `term.refresh` for that row; do not add opacity or visibility toggles (burned in v0.8.5).

## Reproduction of my measurements

```
python3 <scratch>/cap.py 120 30 out.bin      # pty capture, tui default, 1 prompt
npx vitest run --config dev/results/_scratch/vt.config.mjs   # buffer at every ?2026l
npx esbuild dev/results/_scratch/entry.ts --bundle --outfile=dev/results/_scratch/entry.js --format=iife
node dev/results/_scratch/drive.mjs c120.bin 120 1024        # Chromium DOM vs buffer + screenshot
node dev/results/_scratch/drive.mjs cr.bin 120 700 '[[2730,70],[4363,120],[6332,45],[7671,120],[9640,90]]'
```
Capture scripts live in the session scratchpad; the `.bin` captures are copied to `dev/results/_scratch/`.
