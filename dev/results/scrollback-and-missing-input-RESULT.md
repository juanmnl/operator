# Scrollback empty after long sessions, and missing prompt box after switching — RESULT

Read-only research. No code changed, nothing killed, no `lsof`.

## Summary

Both hypotheses in the brief are **confirmed**, with one addition: the missing-prompt
defect (#2) also has a second, independently confirmed cause in Operator's own code —
xterm's viewport is never told to scroll to bottom on activation.

- **#1 (empty scrollback)**: confirmed directly from the installed `claude` 2.1.268
  binary's own source (it ships unminified enough to grep as a single-file JS bundle).
  Claude Code's renderer really does keep an internal virtual `screen` taller than the
  terminal `viewport`, and when that screen doesn't fit, it repaints only a
  `viewportRows`-tall window using cursor moves + line-clears, not real linefeeds — so
  the excess rows never enter the pty stream as scrollable content, and xterm never
  sees them. This is a Claude Code CLI behavior, not something Operator's own code can
  see or control by reading its output — Operator's INACTIVE trim (`INACTIVE_SCROLLBACK
  = 2_000`) makes the same symptom worse but is not required for it to occur.
- **#2 (missing prompt box)**: confirmed as a real gap — `TerminalPane.tsx`'s
  activation effect never calls `term.scrollToBottom()`. Combined with the fit-after-
  flush ordering, a reactivated pane can legitimately end up showing the prompt below
  the fold.

---

## #1 — Scrollback empty after long sessions

### What's actually in Claude Code 2.1.268

`claude --version` on this machine resolves to `2.1.268`, the exact version the brief
cites (`/Users/juanmnl/.local/bin/claude` → `~/.local/share/claude/versions/2.1.268`,
a 193MB bun-compiled Mach-O binary — no vendored source anywhere in this repo,
`node_modules/@anthropic-ai` does not exist). `strings -a` on the binary recovers its
embedded JS as one long unminified-enough blob. Grepping it directly (not
inference — this is the actual shipped renderer code) finds:

```js
function Qa(n,s,c,f,m,y){
  let g=f?0:Math.min(m,Math.max(0,n.screen.height-n.viewport.height+1)),
      S=new zd({x:0,y:g},n.viewport.width);
  return Kv(S,n,g,n.screen.height,c),
    [{type:"clearTerminal",reason:s,altScreen:f,viewportRows:n.viewport.height,debug:y},...S.diff]
}
```

and its three call sites inside `render()`:

```js
if(this.forceReset) return this.forceReset=!1, Qa(s,"clear",y,c,C);
if(s.viewport.height<n.viewport.height || ...) return Qa(s,"resize",y,c,C);
if(S&&R&&T) return t(`Full reset (shrink->below): prevHeight=${n.screen.height}, nextHeight=${s.screen.height}, viewport=${n.viewport.height}`), Qa(s,"offscreen",y,c,C);
// ... and a third `offscreen` branch mid-diff, when a changed row is above the
// current viewport window (`oe<X`), which also attaches `debug:{triggerY, prevLine, nextLine}`
```

This is exactly the brief's claim, verified rather than assumed: `clearTerminal`
carries `reason` ∈ `{clear, resize, offscreen}` plus `altScreen`/`viewportRows`.

The important mechanism, read from `Qa`/`Kv` directly:

- `g` (the first row it will repaint) is `0` when `altScreen` is true (full-screen TUI
  mode repaints from the top), but is **clamped to a `viewport.height`-ish window**
  when not on the alt screen: `min(m, max(0, screen.height - viewport.height + 1))`.
- `Kv` then rewrites rows `g..screen.height` using cursor-move + per-cell writes, not
  `\n` linefeeds. There is no `ESC[3J` anywhere in this path (confirmed by exhaustive
  grep of the binary — the only alt-screen-adjacent sequences found anywhere are
  `ESC[?1049h` / `ESC[?1049l`, i.e. alt-screen enter/exit, used only for fullscreen
  TUI mode).
- Net effect: once Claude Code's own internal `screen` (its full virtual frame) grows
  taller than the terminal's `viewport`, every subsequent repaint in normal (non-alt)
  mode **only ever re-emits the last `viewportRows` lines**, positioned with cursor
  moves. The lines above that window are never turned into real scrolled-off content
  again — they were only ever real scrollback if they were written once, in order, as
  ordinary finalized stdout before falling out of the viewport window. A long-running
  turn that keeps rewriting its own status/tail region (spinner, progress, "N files
  changed") is precisely the shape that repeatedly re-triggers `resize`/`offscreen`
  resets on the same window, so very little of a long turn's visible history is ever
  committed as real terminal scrollback in the first place.

This is a Claude Code CLI-internal decision. Operator does not parse `clearTerminal`
frames (confirmed: zero matches for `clearTerminal`/`offscreen`/`3J` anywhere in
`src/` or `electron/`) and has no way to distinguish "this repaint replaced a screen's
worth of content" from "this is new scrollable history" — it just receives bytes.

### What Operator adds on top

`src/renderer/lib/terminal-options.ts:158-160` (`scrollbackFor`) and
`TerminalPane.tsx:660` (`term.options.scrollback = scrollbackFor(active)`) trim a
**backgrounded** pane's xterm scrollback to 2,000 lines the moment it goes inactive,
discarding anything beyond that immediately and irreversibly (confirmed by the
existing harness `dev/drive-scrollback-trim.mjs`, which fills to 6,000 lines, lowers
the option, and asserts the buffer is actually cut, not just capped for future
growth). This is a real, separate, secondary loss on top of #1 — a background lane
that already has thin real scrollback (because of the `offscreen` mechanism above)
gets what little it has trimmed further while you're not looking at it — but it is
not the primary cause. The **foreground/active** pane you are actually looking at
during a long session is not touched by this trim at all (stays at
`ACTIVE_SCROLLBACK = 10_000`); it just may not have much real content to hold,
because of the Claude Code behavior above.

### Smallest fix

There is no code-side fix inside Operator's own control for the root cause — the
`offscreen`/`resize` windowed repaint is Claude Code's own renderer, and it renders
that way in **any** terminal, not just xterm.js in this app (a genuine `iTerm`/`kitty`
would exhibit the exact same missing-scrollback behavior for the same session). The
one thing Operator's own docs already proposed and did not build —
**replay-on-activate**, referenced in `terminal-options.ts:150-153` — does not help
here either: it replays the backend's retained pty bytes (`terminalHistory`,
`electron/src/main/terminals.ts:526-529`, itself capped at 256KB with 2× hysteresis),
which are the *same* windowed-repaint bytes already discussed; there is no more
history to replay than what the pty already emitted.

The only real fix belongs to Claude Code itself (its `fullscreen`/alt-screen mode,
already an existing Operator preference at `terminal-options.ts:40-54`, does not have
this problem structurally — `altScreen` forces `g=0`, i.e. it always repaints from the
top of its own frame within the fixed alt-screen viewport, and never depends on xterm
scrollback at all). Cost of recommending that route: it's already built and shipped as
an opt-in (`getTuiMode`), just not the default, specifically because "opt-in until
confirmed clean in the live app" per that file's own comment — i.e. it trades this bug
for the DOM-renderer alt-screen ghosting risk already tracked elsewhere in this
project's memory. Not a zero-cost swap, but it is the only actually-available lever;
nothing on the Operator side of the pty can put lines into scrollback that Claude Code
never sent as real scroll.

---

## #2 — Prompt box not visible after switching to a lane

### Confirmed: fit runs after the bg-buffer flush, and nothing scrolls to bottom

`TerminalPane.tsx:645-685`, the `active`-change effect, in exact order:

1. `term.options.scrollback = scrollbackFor(active)` (line 660)
2. if `active`: flush `bgBufferRef` via a direct `term.write(buf)` (lines 663-670)
3. `fitRef.current?.fit()` (lines 671-676)
4. `term.refresh(0, term.rows - 1)` (line 679)
5. `term.focus()` (line 680)

So the buffered background content (written by Claude Code at whatever pty width was
last set *while the pane was active*, since `shouldFitOnResize` (`terminal-
options.ts:181-183`) blocks the pty from being resized while the pane is
inactive/hidden — confirmed: `handleResize` early-returns for an inactive pane, so a
window/sidebar layout change while a lane is backgrounded changes the pane's DOM
*container* size but never reaches `fitAddon.fit()` or `terminalResize`) is written
into xterm first, then `fit()` runs and may immediately reflow/resize both xterm and
the pty to the container's now-possibly-different real size. That resize round-trips
to the pty (`term.onResize` → `terminalResize` IPC, `TerminalPane.tsx:318-319`) and
Claude Code answers asynchronously with its own `resize`-reason `clearTerminal` frame
(see #1) — there is necessarily a window between "xterm just reflowed stale content to
a new width" and "Claude Code's fresh redraw at that width arrives", during which the
pane's content is not guaranteed self-consistent.

Separately and unconditionally: **`grep -n "scrollToBottom" TerminalPane.tsx` returns
nothing.** Nowhere in the file — not in the activation effect, not in the bg-flush
paths, not after a resize — is xterm's viewport ever explicitly moved to the bottom.
xterm.js only auto-follows new content when the viewport was already exactly at
`ybase` (i.e., the user hadn't scrolled up) at the moment of the write; a reflow from
`fit()` changing row/col counts, or a large multi-KB flush landing on a buffer whose
tracked scroll position had drifted while hidden, is exactly the kind of write that
does not clearly commit to "stay at bottom" for a DOM renderer. Whether or not the
resize race above is what triggers it, the missing `scrollToBottom()` call is a
concrete, independent gap: if a reactivated pane's viewport is not already pinned at
the bottom for any reason, nothing in this code path puts it there, and the
prompt/composer row — always the last line — is exactly what falls off the bottom of
what's currently on screen.

### What I could not fully settle without a live GUI session

I did not have a running long-session lane to switch away from/back to and capture
`buffer.active.length`/`viewportY` vs `rows` live (the brief's ask), and per the
project's own environment notes GUI verification here is the user's, not something a
research pass can substitute for. The `⌘K` → "Dump terminal buffer (debug)" command
(`DashboardView.tsx:3895-3937`, registered `DashboardView.tsx:4291-4292`) is the
built-in tool for exactly this: it writes `size: <cols>x<rows> bufferLength:
<buf.length>` plus the tail of the live buffer to `~/.operator/terminal-dumps/`. Its
one limitation for this specific bug: it only ever reads `activeSession`/
`activeTerminalId` — there's no way to dump an *inactive* pane's buffer with it, so it
can confirm the symptom on the pane you just switched to, but can't capture the
state the instant *before* you switched.

### Smallest fix

Two independent, cheap changes, either of which would help, together closing more of
the gap than either alone:

1. **Call `term.scrollToBottom()` in the activation branch of the `active`-change
   effect** (`TerminalPane.tsx:662-680`), after the bg-buffer flush and after `fit()`
   — i.e. right before or alongside `term.refresh(...)` at line 679. Cost: one line,
   no new state, no risk to the trim/flush logic already there. This directly fixes
   "content is there but scrolled above the fold" regardless of which of the above
   mechanisms caused it. It does the "right" thing even if the real cause turns out to
   be something else entirely, because a freshly-activated pane should always open
   at the bottom.
2. **Reorder the activation effect to `fit()` before flushing `bgBufferRef`**, so
   Claude Code receives its resize signal before the stale-width buffered content is
   replayed, rather than after. This doesn't eliminate the round-trip race (Claude
   Code's own redraw is still asynchronous either way) but it means the buffered
   content that does land is written into an already-correctly-sized terminal instead
   of one about to be reflowed out from under it. Cost: reordering ~15 lines already
   in that effect; slightly changes what's on screen for one frame during activation
   (buffer flush now happens after a possible resize instead of before), so it wants
   the visual-harness soak (`scripts/visual`) re-run before shipping, though today
   that harness doesn't actually exercise this path (confirmed: no `scrollback`/
   `bgBuffer`/`fit` references in `scripts/visual/harness.ts`), so new coverage would
   need writing alongside the fix.

Fix (1) is safe enough to ship without new test coverage; fix (2) is the more
structurally correct one but touches ordering the existing comments treat as
deliberate, so it deserves its own harness addition first.

---

## Constraints honored

Read-only throughout: only `Read`/`Bash` (grep, `strings`, `file`) were used; no file
in `src/`, `electron/`, or elsewhere in the repo was edited; nothing was installed;
no process was killed; no `lsof` was run (the installed `claude` binary was inspected
by path and `strings`, not by inspecting a running process).
