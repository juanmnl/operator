# Terminal research v2 — result (2026-08-04)

## Recommendation, up front

**Stay on the DOM renderer. Don't chase WebGL, canvas, or libghostty-vt-as-WASM next.**
Instead, spend the next real effort **reviving `src-tauri/src/gridterm.rs` +
`GridTerminalPane.tsx`** — a complete, already-compiling, currently **orphaned**
implementation of exactly the architecture Lead 2 was reaching for (VT parsing done by a
mature engine outside the WebView, host just paints cells), except it's *native Rust*
(alacritty), not WASM, and it already exists in this repo. Nobody is importing it. It
was built during the ghostty-web era (commit `e9e02e3`, 2026-06-30) and never deleted or
wired back in.

**The single cheapest experiment that would settle this:** wire `SessionView`'s terminal
choice to render `GridTerminalPane` instead of `TerminalSurface` for one dev build,
force `tui:fullscreen` on, and run one real, hours-long Claude Code session against it —
the same trigger conditions (sustained output, multiple tool calls, in-place status
redraws) that broke WebGL twice in production. `cargo check` passes today and `tsc`
finds zero errors touching it, so the backend hasn't bit-rotted; what's unproven is
whether it holds up **live**, which is exactly the class of claim this brief warns
against taking on faith.

---

## What's stale, what's wrong, what survives

| Old conclusion | Verdict |
|---|---|
| "WebGL/canvas corrupt wholesale in WKWebView; DOM is the only correct renderer" | **Survives**, but for a different reason than recorded. Not a permanent WebKit law — see below — but a real, twice-reproduced, production-witnessed failure that a short/synthetic test cannot detect. |
| Lead 1's hypothesis: "canvas is fine, it's a WebGL-only, 26.5-beta-only bug" | **Wrong**, refuted by this project's own git history before I ran anything. |
| Lead 2: "ghostty-web is dead" | **Stale.** libghostty-vt-as-WASM is real, but immature (pre-1.0, WASM support itself is "planned/experimental" per upstream) and solves a problem this repo already solved better, natively, and forgot about. |
| "`verify:width`/`verify:dom` prove the width-drift class is fixed" | **Still true today**, reconfirmed live (below). Not in question. |
| "`tui:fullscreen` desyncs cells and freezes input" | **Unproven either way** — I found no test artifact substantiating the brief's claim that a replay "was later reported to render clean." The code comment still says "opt-in until fullscreen is confirmed clean in the live app," which nobody has done. |

---

## Lead 1 — was canvas ever actually fine? No. Real production history says no, twice.

Before touching Playwright, `git log` already answers this more authoritatively than any
new test could:

- **2026-06-16** (`53f2844`, `84b1d08`): canvas addon shipped in v0.2.1 specifically *to
  fix* WebGL corruption. **One day later** (`e922de7`, 2026-06-17, v0.2.2): *"WKWebView
  corrupted both the WebGL atlas and the canvas renderer (stray tofu cells +
  duplicated/garbled rows under both)"* — canvas failed the same way WebGL did. This
  predates the "macOS 26.5 beta" issue entirely.
- **2026-07-02** (`253c73f`, `19a9a7d`, v0.8.0): WebGL retried, on the premise that
  "xtermjs/xterm.js#5816... was a WebKit bug since fixed." A same-day in-app A/B test
  looked clean.
- **2026-07-05, three days later** (`77ad591`, v0.8.2): reverted. *"WebGL still corrupts
  wholesale in WKWebView on real long sessions... the WebKit GPU bug is NOT fixed
  here."* The `TerminalSurface.tsx` comment is explicit: it looked clean in a short test
  and then failed under sustained real use.

That three-day gap is the load-bearing fact for this whole brief: **this app has already
been burned exactly once by "a short test says it's fine."** Any new short test —
including the one I ran below — inherits that exact same blind spot and cannot on its
own overturn the production finding.

**New evidence from live web research (not in the original brief) makes the "WebKit-only,
version-specific" framing weaker, not stronger:**

- `xterm.js#5816` (the 26.5-beta report) is **still open**, no WebKit bug number ever
  linked, and its last comment (2026-05-21) is from a user on **macOS 15.7** — i.e. the
  same symptom shows up on an unrelated, much older macOS release. It isn't beta-only.
- A **more specific, more relevant issue exists that the brief didn't name**:
  `xterm.js#5847`, filed 2026-04-27, still open, explicitly scoped to **Tauri/WKWebView
  on stable macOS**, triggered by **"Claude Code streaming large amounts of text,"** with
  a transparent theme background, onset "after a while of heavy output" — this is a
  closer match to Operator's own bug than #5816 is, and it is unresolved.
- A 2026 blog post documents **the identical failure signature in VS Code's integrated
  terminal — under Chromium, not WebKit** — attributed to xterm.js's WebGL texture atlas
  corrupting under Claude Code's high-redraw-rate TUI specifically, fixed by disabling
  GPU acceleration. **This is the single most important new fact**: it means the bug is
  most plausibly a general xterm.js WebGL-addon atlas-robustness problem under
  Claude-Code-shaped redraw patterns, not a WebKit/WKWebView-specific defect. Chasing "is
  WebKit fixed yet" was never going to be the right question.
- One real fix did land upstream: PR **#5883** (merged 2026-05-21) fixes two atlas bugs
  in issue **#5847**. It shipped only to `@xterm/xterm@6.1.0-beta.29x` — **the stable
  channel is still pinned at 6.0.0** (unchanged since 2025-12-22). Nothing here has
  reached what this app is running.
- **`@xterm/addon-canvas` was removed entirely in xterm.js 6.0** — the project's own
  release notes recommend DOM or WebGL only going forward. Separately, the specific
  canvas beta this app vendored in June (`0.8.0-beta.48`) **still ships a broken
  package.json `exports` field today** — confirmed live, below — so canvas isn't just
  historically bad, it's actively unmaintained and no longer a supported path at all.

### What I actually tested today (and why it's weak evidence, honestly stated)

- `npm run verify:width` and `npm run verify:dom`, live, right now: **both clean** (0/52
  glyph mismatches, 0/20 wrap-row mismatches, 0/30 DOM-vs-buffer row mismatches). The
  width fix holds under `@xterm/xterm@6.0.0` + `addon-unicode-graphemes@0.4.0`. Not in
  question, just reconfirmed.
- I built a throwaway harness (`scripts/width-audit/renderer-spike.{ts,html,mjs}` — not
  product code, left in place as a spike) that mounts the production font/unicode config,
  loads `dom` vs `webgl` vs `canvas`, and replays 40 box-drawn tool-call blocks plus **30
  in-place cursor-up status-line rewrites** (Claude's actual ticking-elapsed-timer
  pattern) under Playwright WebKit on this machine (macOS 26.5.2, build 25F84).
  - `dom`: clean.
  - `webgl`: **also clean**, no context loss, screenshots visually match the DOM run.
  - `canvas`: could not run — `@xterm/addon-canvas@0.8.0-beta.48`'s package.json still
    fails Vite's module resolution (confirmed live, same brokenness the 2026-06-16
    vendoring commit worked around).
  - **This WebGL "clean" result is not evidence it's safe.** It is a short, synthetic,
    single-session Playwright run — structurally the same shape as the July 2 in-app A/B
    that also looked clean and then corrupted three days into real use. I'm reporting the
    screenshots because the brief asked for a live test, not because they settle
    anything; the honest reading is "reproduces the known false-negative, again."

**Bottom line for Lead 1**: don't flip WebGL back on. Not because WebKit is uniquely
broken, but because this exact bug (xterm.js WebGL-addon atlas corruption under
Claude-Code-shaped high-redraw TUIs) is real, currently unresolved upstream even in
beta, hits Chromium too, and this app has already paid for finding that out once. Canvas
is not a fallback anymore — it's gone from xterm 6 and its old beta is unmaintained.

---

## Lead 2 — libghostty-vt is real, but this repo already has something better and forgot

Web research (background agent, full citations in the transcript) confirms libghostty-vt
compiles to standalone WASM (no emscripten) and has real consumers: `@wterm/ghostty`
(Apache-2.0, ~400KB WASM, Vite-verified), a real shipping Obsidian plugin ("Ghostty
Terminal," v0.2.1, ~2k downloads), and "browstty" (explicitly labeled an *experiment* by
its own author). The scope is narrower than pure parsing, though: the official API
**does** include key- and mouse-*encoding* (the brief's guess that key encoding is absent
was wrong), but it does **not** include selection, find-in-scrollback, or any rendering —
those stay the integrator's job. Upstream's own framing: WASM support is "planned," the
API is explicitly pre-1.0 with breaking changes expected.

**None of that matters much here, because this exact architecture — mature VT engine
owns grid/cursor state, host paints cells as DOM, no escape sequences ever reach a
webview buffer to desync — already exists in this codebase, more complete than
libghostty-vt-node's current state, and isn't WASM at all:**

- `src-tauri/src/gridterm.rs` (406 lines): pty bytes parsed by **`alacritty_terminal =
  "0.25"`** (pure Rust, no GPU, the same VT engine the shelved native build used),
  producing a run-length-encoded, themed cell-diff snapshot (`gridterm:update`) per
  chunk. Its own header comment states the thesis directly: *"the whole corruption
  class... is xterm's grid state mis-tracking the cursor under heavy streaming. The fix
  here moves the GRID AUTHORITY out of the webview... No escape sequences ever reach the
  webview, so there is no buffer to drift."*
- `src/renderer/components/terminal/GridTerminalPane.tsx` (446 lines) paints that
  snapshot as plain DOM (one `<div>` per row, rAF-coalesced, bypassing React
  reconciliation on the hot path), and is **not a stub** — it already has: wheel→
  scrollback via alacritty's own `display_offset`, drag-to-select + ⌘C copy, click-to-
  open-URL, live theme remapping across all 16 ANSI + RGB + 256-cube colors, and a
  headless xterm instance used *only* as a key encoder so input encoding can't drift from
  the real pane.
- `operator-bridge.ts` already exposes the full IPC surface
  (`gridtermAttach/Resize/Scroll/SetTheme/Detach`), and `lib.rs` already wires all five
  Tauri commands.
- **It compiles clean today**: `cargo check` in `src-tauri` exits 0 with no warnings.
  `tsc --noEmit` finds zero errors referencing `gridterm`/`GridTerminalPane`.
- **It is completely disconnected from the UI.** `grep -rn "GridTerminalPane"
  src/renderer/` finds exactly one hit: its own export. Nothing imports it, no
  preference toggles it, no session ever mounts it. It's reachable only by calling the
  bridge functions directly.
- A comment in `operator-bridge.ts` claims this grid renderer "parses alt-screen
  correctly, so it can host Claude Code's FULLSCREEN TUI... which the DOM xterm
  corrupts" — i.e. someone already believed this solves the *other* open problem
  (fullscreen/alt-screen desync) too. I found no test artifact proving that claim either
  — it's an asserted design intent, not a verified result.

This is a much better bet than building fresh on libghostty-vt: same core idea
(offload VT authority to a mature native engine), already Apache-2.0-licensed
(`alacritty_terminal`), already has the selection/scrollback/mouse features
libghostty-vt's docs admit are missing, no WASM load cost, no dependency on an upstream
project whose own maintainers call WASM support "planned." The work remaining is not
"build a parser-in-WASM integration" — it's "find out why this was shelved, soak-test
it, and wire it back into the UI," which is a much smaller and better-understood lift.

**What isn't known and should be found before committing further:** why it was
abandoned. No `dev/` doc discusses it, and no memory note explains a reason beyond
"superseded." Given the timeline (built 2026-06-30, superseded by the WebGL retry two
days later on 2026-07-02), the likely explanation is simply that effort moved to "maybe
WebGL just works now" before grid was soak-tested — not that grid was tried and failed.
That should be confirmed, not assumed, before relying on it.

---

## The wider sweep

- **xterm.js 6.0** (released 2025-12-22, still `latest`; `6.1.0-beta.292` is the current
  prerelease as of 2026-07-27): canvas addon removed outright; WebGL got shadow-DOM
  support and unrelated ligature/serialize improvements; DEC mode 2026 (synchronized
  output) added — **not mode 2027**. No evidence xterm.js has native grapheme-cluster
  width handling; `addon-unicode-graphemes` was republished the same day as 6.0.0 and its
  own npm description still calls itself **"experimental."** `addon-unicode11` also
  current, no deprecation notice. **Conclusion: both addons stay required; the width fix
  is not being subsumed by core anytime soon.**
- **Fullscreen/alt-screen retest**: not substantiated. `terminal-options.ts` still gates
  it behind an opt-in pref with the comment "until fullscreen is confirmed clean in the
  live app," and I found no dev doc or test recording that confirmation ever happened.
  Treat the brief's "later reported to render clean" as an unverified rumor, not a
  finding — if it matters, the grid-terminal soak test above should specifically include
  forcing `tui:fullscreen` on, since gridterm's own comments claim it's the one path that
  handles alt-screen correctly.
- **Other embeddable VT cores**: dead end, by comparison. No verified running
  browser/webview example exists for `wezterm-term` or Rust `vte`/`vt100` compiled to
  WASM — only the theoretical possibility. Ghostty's ecosystem is, by a wide margin, the
  only one with real shipped artifacts (committed `.wasm`, a live Obsidian plugin).
  Doesn't change the recommendation: this repo's native alacritty path is still better
  positioned than adopting Ghostty's WASM path from scratch.
- **What everyone else does, and why they mostly don't hit this**: Warp and Zed don't use
  a webview at all (custom GPU UI frameworks — wgpu/Metal and GPUI respectively);
  avoiding exactly this class of problem is *why*. Hyper and VS Code both run
  xterm.js-in-Chromium and VS Code has hit the **identical** atlas-corruption bug under
  Claude Code's TUI, mitigated by disabling GPU acceleration — the same fix direction
  this app already took. The working hypothesis in the original brief (native apps, or
  Chromium's more-exercised canvas path) is **half right**: native avoids it entirely;
  Chromium does not reliably avoid it, it just isn't the only place it's been reported.
- **Tauri/WKWebView escape hatches**: no first-party one. Multiwebview support in Tauri 2
  exists but is unstable and still WebKit-backed (doesn't dodge the bug). The one
  verified real pattern is a third-party blog post (2026-05-22, "atrium") describing a
  production **CEF-alongside-WKWebView "punchout" trick** (native `NSView` layer behind a
  `drawsBackground=NO` webview) — real and shipping, but heavyweight (custom hit-testing,
  "weeks of usage" to shake out bugs), and solving a different problem (embedding
  Chromium for OAuth) than a terminal renderer needs. Not worth pursuing over the
  already-built grid terminal.

---

## Ranked options

1. **Stay DOM (today's default).** Cost: the known one — a bit slower on heavy scroll,
   fullscreen/alt-screen stays off (wheel-scroll trade-off already documented). Risk:
   zero — this is what's shipping and proven in real use. Do this until #2 is validated.

2. **Revive the grid terminal (alacritty native + DOM paint).** Cost: soak-testing time
   + finding out why it was shelved + wiring a real UI path in (currently zero UI
   surface). Fixes, if the soak test confirms the code's own claims: the entire
   width/wrap-desync class structurally (no xterm buffer to drift), *and* the
   fullscreen/alt-screen desync (its stated reason for existing). Risk: unknown-but-
   plausibly-low, since it already compiles and was clearly built to completion, not
   abandoned mid-way. **Recommended next step**, with the experiment named at the top.

3. **libghostty-vt WASM as parser, keep a DOM/webview renderer.** Cost: adopting a
   pre-1.0 API from a project whose maintainers call WASM support itself
   "planned"/"experimental," plus building selection/find/rendering that library
   explicitly doesn't provide, plus WASM load overhead. Fixes: same class of bug as
   option 2, in theory. Not recommended — it would be re-deriving option 2's architecture
   with a less mature, less complete building block, for no offsetting benefit (license
   is comparable, alacritty is arguably more battle-tested).

4. **Switch renderer to WebGL (or canvas).** Cost: real, paid twice already — wholesale
   corruption in actual long sessions, not caught by short tests. Canvas is additionally
   now unsupported upstream (removed in xterm 6; the old beta package is broken today).
   Not recommended, full stop, regardless of what any new short test shows — that test
   result is the same false-negative shape that already burned this project once.

5. **Native surface (CEF punchout / own NSView+Metal, the diri-adjacent route).** Cost:
   confirmed real by the atrium precedent, but heavyweight — custom hit-testing,
   compositing bugs, "weeks of usage" to stabilize. Not worth it while option 2 sits
   mostly-built and untested in this exact repo.
