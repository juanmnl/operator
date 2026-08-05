# DEEP RESEARCH: re-open the terminal. The old conclusions are retired.

## Why this brief exists

Operator's standing direction was **"invest in the chat UI, NOT a terminal rewrite"** — three
rewrite attempts had been abandoned and the DOM renderer was declared the only correct surface. The
user has reversed it (2026-08-04): *"i want to invest in chat, but after months of use, i'm more
comfortable in the terminal, so scrap all that previous research and do a deep one again, maybe some
stuff is already fixed somewhere."*

**Treat every prior conclusion as expired, not as evidence.** Your job is to re-derive the answer
from what is true in August 2026, and to say plainly where the old conclusions were right, where
they have gone stale, and where they were wrong to begin with. Two already look stale — see below.

## Two leads that are already known to be live. Start here, verify, then go wider.

### Lead 1 — "WebGL/canvas corrupt wholesale in WKWebView" may be an OS-version bug, not a law

`xtermjs/xterm.js#5816` — *"Broken webgl rendering in Safari on MacOS beta 26.5 beta"*. Reports say
rendering is totally broken on macOS 26.5 **and that switching to the canvas addon fixes it**. This
machine runs **Darwin 25.5.0 / macOS 26.5**, exactly the affected version.

Operator's recorded conclusion was "WebGL AND canvas corrupt wholesale; DOM is the only correct renderer."
If canvas is in fact clean and only WebGL is broken — or if this is a WebKit regression already
fixed in a later build — then the renderer question is reopened and the performance ceiling with it.

Determine:
- Is #5816 a WebKit regression, its current status, and is there a fixed WebKit/macOS build?
- Does the **canvas** addon render correctly in *this* app's WKWebView today? Distinguish "Safari"
  from "WKWebView embedded in a Tauri app" — `xtermjs/xterm.js#3575` ("Does not work in WKWebView")
  suggests they are not the same environment.
- Related: `#3357` (WebGL broken on Safari Preview), `#3303` (webgl + ligatures), `#2033`.
- **Use the harnesses that already exist** rather than reasoning about it: `npm run verify:visual`
  (Playwright **WebKit**, the same engine family as the app's WKWebView), `npm run verify:dom`,
  `npm run verify:width`. `@xterm/addon-webgl` is already a dependency, so a renderer swap is a
  one-line experiment, not a port.

### Lead 2 — libghostty-vt now compiles to standalone WASM, and things ship on it

The note calling `ghostty-web` DEAD is out of date. As of 2026: **libghostty-vt compiles and runs as
a standalone Wasm module (no emscripten)**, and real consumers exist:
- **`@wterm/ghostty`** (wterm.dev) — "full-featured terminal emulation core powered by libghostty",
  full Unicode, all SGR attributes, **~400 KB WASM**.
- **ghostty-web**, used by a shipping **Obsidian plugin** — an existence proof in a webview.
- **browstty** — Zig WASM module embedding libghostty in the browser.

**The critical distinction to nail down: libghostty-*vt* is the PARSER, not a renderer.** If that is
right, the architecture it enables is *parser in WASM → we paint the cells*, which is the same split
diri uses (SwiftTerm headless + GPUI painting) but **without leaving the webview**. That would
target the width/parsing class of bug directly — Ghostty's VT is battle-tested on grapheme
clustering and mode 2027 — while leaving the renderer choice open.

Determine: maturity and API stability (the Zig API is testable, the C API was "coming shortly" —
where is it now?), licence, WASM size and load cost, what it does NOT provide (selection? find?
scrollback? key encoding?), and what shape a real integration takes.

## The wider sweep

- **xterm.js 6** — we are on `@xterm/xterm ^6.0.0` with BOTH `addon-unicode11` and
  `addon-unicode-graphemes` installed. Which is actually active, what changed in 6, and is
  **mode 2027 / grapheme clustering** now handled such that our width fixes are redundant?
- **Is the fullscreen/alt-screen desync fixed?** Operator ships `tui:default` (classic scrollback)
  because `tui:fullscreen` desynced cells and froze input. A replay of the real fullscreen byte
  stream was later reported to render clean on the current unicode-graphemes stack. Re-test it —
  if fullscreen is viable, that is a large UX win for no architectural cost.
- **Other embeddable VT cores**: wezterm's `wezterm-term`, `vt100`/`vte` compiled to WASM,
  SwiftTerm (native-only — note it as the diri route, not a webview option), Warp/Hyper's approach.
- **What everyone else does and why they don't hit our bugs.** The working hypothesis: they are
  either native (own shaper + CoreText fallback), or on Chromium (a far more exercised canvas path),
  and most do not host a full-screen agent TUI that redraws in place. Confirm or break that.
- **Tauri/WKWebView**: any newer escape hatch — a different webview, a native view overlaid on the
  webview, or GPU access that behaves.

## What the output must contain

A recommendation, not a survey. Rank the real options with the cost and the risk of each:
1. **Stay DOM** — what we give up.
2. **Switch renderer to canvas (or WebGL if #5816 is fixed)** — cheapest possible test; is it clean?
3. **libghostty-vt WASM as the parser**, keeping a webview renderer.
4. **Native surface** (the diri route) — cost honestly stated: selection, find, scrollback and key
   handling all become ours, which is why it was shelved before.

For each: what breaks, what it costs, what it fixes, and the smallest experiment that would settle
it. **Where a claim can be tested with an existing harness, TEST IT — do not report a GitHub issue
thread as a finding.** Say explicitly which of the old conclusions survive, which are stale, and
which were wrong.

## Constraints

- **Investigate and report. Change no product code.** Throwaway spikes under `dev/` or
  `scripts/width-audit/` are fine — the user already has untracked WebGL/DOM-perf spikes there
  (`dev/webgl-terminal-in-wkwebview.md`, `scripts/width-audit/webgl-spike.*`,
  `scripts/width-audit/dom-perf.*`) — **read those first, they may already answer Lead 1.**
- Cite versions, issue numbers and dates. "It's fixed" without a build number is not a finding.

## Output

Write `/Users/juanmnl/.operator/worktrees/operator-3b4cb8/dev/briefs/2026-08-04-terminal-research-v2-RESULT.md`
(absolute path — Operator reads it there). Lead with the recommendation and the single cheapest
experiment that would prove or kill it.
