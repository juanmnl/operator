# Brief — can a GPU terminal work in WKWebView, or is it permanently off the table?

**Investigate and report. Change no product code** (a throwaway harness is fine).
Output: `dev/webgl-terminal-in-wkwebview.md`.

## Why this decides something bigger

The user is weighing a return to **Electron**. The recorded reason for leaving it is specific and
still credible — bundle ~250MB → ~10MB, idle RAM ~200–300MB → ~30–40MB
(`docs/tauri-migration.md`) — and matters more than usual here, because Operator runs **three or
more instances at once** across worktrees.

Against that, almost every WKWebView cost we pay is a *design rule* we can work around. **One is
not: the terminal renderer.** WebGL and canvas are recorded as corrupting wholesale in WKWebView,
so we are pinned to xterm's DOM renderer, with classic-mode scrollback as the stated trade-off.
v0.8.0 shipped *"xterm+WebGL terminal"* under Electron and that capability was lost in the move.
`@xterm/addon-webgl` is still in `package.json`, unused.

**So: if a GPU terminal can work in WKWebView, the Electron case largely collapses. If it truly
cannot, that is the strongest argument for Electron anyone has made.** Settle it.

## The question I most want answered first

**Was the WebGL corruption ever correctly diagnosed?**

There is direct reason to doubt it. Scrollback garble was blamed on the renderer for a long time
and was *later* traced to something else entirely: `stripOrnaments` widening width-1 ornaments
(dominoes, cards), which drifted the composer-divider cursor and caused overprint. That was fixed
width-exact, and `npm run verify:width` now proves xterm↔Claude widths are otherwise clean.

If WebGL was condemned on symptoms that the width bug actually produced, the constraint is stale
and nobody has retested it since the real cause was fixed. **Check the history before running
anything** — find what was actually observed, when, and whether it postdates the width fix.

## Then test it

- **Reproduce, or fail to.** Turn the WebGL addon on in a throwaway build and drive it. What
  exactly happens — blank canvas, glyph corruption, wrong colours, a crash, or nothing at all?
  "It's broken" is not a finding; the failure mode is.
- **Canvas addon separately.** It is a different renderer with different failure modes and may not
  share WebGL's fate.
- **Use the existing harness.** `npm run verify:visual` already drives a real xterm with the
  production font stack under **Playwright WebKit** — the same engine family as the app's
  WKWebView. That is the cheap test. ⚠️ But it is *not* the app's exact embedding, and that
  caveat is already recorded — so a Playwright pass is evidence, not proof. Anything promising has
  to be confirmed in the real app.
- **macOS/WebKit version.** Is this a permanent WKWebView property or a bug in a version we have
  since moved past? The machine is on macOS 26.5. Look for upstream xterm.js and WebKit reports.

## Also establish the cost of the status quo

Right now we *assume* the DOM renderer is acceptable. Quantify it, so the trade is real:

- Frame cost / dropped frames under a fast-scrolling build log, and at what scrollback depth it
  degrades.
- What `tui:default` costs us — fullscreen/alt-screen desyncs cells and freezes input, so we run
  classic mode and lose scrollback fidelity. Is that a DOM-renderer consequence or independent?

If the DOM renderer turns out to be *fine* at our workloads, that also settles the question — from
the other direction.

## What I do not want

- Don't restart the shelved native attempts. `native-gpu-terminal` (alacritty+wgpu), the DIY grid,
  and ghostty-web are all abandoned; this brief is about the WebView, not about replacing xterm.
- Don't turn the addon on in the product. The recorded rule is **no renderer toggle without a soak
  test**, and a soak test is not in scope here.

## Output

`dev/webgl-terminal-in-wkwebview.md`:

- **Verdict in the first five lines**: works / doesn't / works with caveats — and the single
  strongest piece of evidence.
- Whether the original diagnosis was sound, and what it was actually based on.
- The observed failure mode for WebGL and for canvas, separately, with how you tested and how much
  each result is worth (Playwright WebKit vs the real app).
- The DOM renderer's measured cost today.
- **What this means for the Electron question**, stated plainly — including "this doesn't decide
  it" if that is the honest answer.
