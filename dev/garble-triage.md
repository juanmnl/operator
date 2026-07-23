# Terminal-garble triage protocol

For the recurring composer garble (stale divider rows, rule-through-statusline
overprint, single-cell character corruption — see `/tmp/operator-shots/garble-*.png`
for the reference set). Written 2026-07-22 so the next instance can be triaged
fast without re-deriving the whole investigation.

## Baseline established today (2026-07-22, commit `4e6c40e`, Claude Code v2.1.218)

Buffer/DOM/width are all clean — the corruption is NOT a parse/width bug on
current code:

- `npm run verify:dom` → 0/30 row mismatches (DOM matches xterm's buffer after
  incremental chunked writes at production repaint cadence).
- `npm run verify:width` → 0/52 glyph mismatches, 0/20 wrap-row mismatches.
- Extended glyph probe (❯ prompt arrow, ⏸⏹⏵⏴, Braille spinner dots ⠂⠐, ↳⤷ —
  none of which are in `scripts/width-audit/harness.ts`'s battery) → 0/36
  mismatches against `string-width`.
- A fresh live capture (`python3 scripts/width-audit/capture-claude.py` →
  `node scripts/width-audit/replay.mjs`) → 0 garbled rows in the final buffer.

**If a future run of `verify:dom` or `verify:width` comes back non-clean, that
is a genuine regression and takes priority over the per-instance protocol
below** — it would mean the corruption moved from "pixel-only" back to
"buffer-level," which changes the whole fix strategy.

Known blocker for going further with headless repro: reproducing the specific
trigger (a real multi-second running tool call, ticking its elapsed-timer/token
count in place many times) requires the child `claude` session to run a Bash
tool call unattended, which needs `--permission-mode bypassPermissions`. The
auto-mode classifier blocks spawning a child Claude session with that flag as a
potential permission-bypass action. Unblock options: a human runs the
long-running-tool-call session manually while an agent tails the pty, or the
user explicitly allows that one flag for a throwaway sandboxed capture.

## The protocol — run this the next time garble is seen live

Code lane is adding a buffer-dump palette command that writes the live xterm
buffer to `~/.operator/terminal-dumps/`. This protocol turns that dump plus a
screenshot into a buffer-vs-pixels verdict.

1. **The moment garble is visible**, in order (don't reload/resize/scroll first
   — any of those can trigger a repaint that heals it before you capture):
   - Invoke the buffer-dump palette command for that session.
   - Screenshot the garbled region and copy it to `/tmp/operator-shots/`
     immediately (screenshots dragged in self-delete — see
     `feedback_screenshot_stash` memory).
   - Note the terminal id (visible in the session sidebar/tab) and the
     wall-clock time.

2. **Locate the dump** in `~/.operator/terminal-dumps/` matching that terminal
   id and timestamp (most recent file for that id if the naming scheme doesn't
   include both — check what Code lane actually shipped, the exact filename
   format isn't finalized as of this writing).

3. **Line up rows.** The dump covers more than the screenshot's crop, so anchor
   on stable structural text that appears in both: the divider rules (`───…`),
   the `❯` prompt, or the `auto mode on (shift+tab to cycle)` /
   `manual mode on · ? for shortcuts` status line. Count rows from there to
   find the dump's row(s) corresponding to what the screenshot shows garbled.

4. **Compare character-for-character**: the dumped buffer text at those rows
   vs what the screenshot visually shows.

5. **Verdict:**
   - **Dump shows the CORRECT/intended text, screenshot shows garbled pixels**
     → buffer is clean, this is pixel-only WKWebView compositing (the leading
     hypothesis — see below). No parser/width fix will help. Route to: forcing
     a real recomposite (the `translateZ(0)` toggle in `TerminalPane.tsx`'s
     `hardRepaint` is currently a no-op per `project_terminal_ornament_width_drift.md`'s
     2026-07-20 update — a real fix needs something that actually invalidates
     the stale rect) or adopting `tui:fullscreen` (alt-screen), which
     structurally can't leave stale rects since it repaints the whole frame
     every time.
   - **Dump shows the SAME garbled text as the screenshot** → the buffer
     itself is wrong. This contradicts today's baseline, so first re-run
     `verify:dom`/`verify:width` to check for a regression. If those are still
     clean, the corruption is happening in bytes Claude itself sent (an
     upstream Ink/partial-diff bug) rather than in Operator's write path —
     confirm by checking whether the raw pty history for that session (if a
     raw-bytes capture exists alongside the buffer dump) already contains the
     wrong characters at the source, before they ever reached `stripOrnaments`/
     `term.write`.
   - **Partial match** (some characters right, some wrong) → still lean
     pixel-only (a partial repaint that fixed some but not all of the stale
     rect), but grab a second sample before concluding — don't decide off one
     ambiguous instance.

## Ranked hypotheses (context for whoever reads a dump)

1. **(Leading)** WKWebView failing to recomposite small/frequent dirty rects —
   the same class of bug as the earlier documented ✳/👀 row-level ghost, now
   showing at sub-row/per-glyph granularity because Claude Code's status-line
   redraws look more surgical in current captures (Braille spinner frames,
   in-place elapsed-timer ticks) than the full-row rewrites the original fix
   was tuned against.
2. Upstream Ink/Claude-Code partial-diff bug sending already-wrong bytes for a
   same-length line (naive positional diffing after a length change earlier in
   the frame). Indistinguishable from Operator's own write path corrupting it
   without a raw-bytes-at-source capture — see verdict branch above.
3. **(Weak, unconfirmed either way)** Resize/reflow landing mid-redraw. No
   headless test has correlated this; none of the 4 reference screenshots have
   confirmed resize provenance.
