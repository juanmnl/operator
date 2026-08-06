# Spike — can a GPU terminal work in WKWebView?

No product code changed (confirmed clean: `git status` shows only new files under `dev/` and
`scripts/width-audit/`; `TerminalSurface.tsx` was touched for a live test and reverted —
`git diff` against it is empty).

## Verdict

**Doesn't work. Confirmed, not assumed — and the diagnosis was never stale.** Three independent
lines of evidence converge: (1) the original diagnosis is dated precisely, and it **predates** the
width-drift bug this brief suspected it was confused with, so that confound doesn't exist; (2) an
unrelated third party hit the *identical* failure in the *identical* stack (Tauri + WKWebView +
macOS 26.5) with their own upstream bug report and repro case; (3) I reproduced a severe,
structurally-confirmed WebGL failure myself today, on the same WebKit line, in a clean
apples-to-apples test against a DOM control that rendered the same content perfectly. Canvas isn't
a fallback — it no longer exists as an option (removed upstream in xterm v6). The DOM renderer's
cost, measured rather than assumed, is negligible at realistic-to-heavy load. **This confirms one
input to the Electron decision is real, not speculative — it does not by itself decide the
question.**

## Was the original diagnosis sound?

**Yes, cleanly — the brief's suspicion turns out not to apply here.** The concern was that WebGL
might have been condemned on symptoms the width-drift ornament bug (`stripOrnaments` widening
width-1 glyphs, fixed 2026-07-07) actually produced, making the exclusion stale. Checked against
git history with exact dates:

| Event | Date |
|---|---|
| `253c73f` — replace ghostty-web with xterm.js + WebGL | 2026-07-02 |
| `19a9a7d` — **Release v0.8.0**, ships WebGL | 2026-07-02 |
| `77ad591` — **Release v0.8.2**, reverts to DOM renderer | 2026-07-05 |
| `ab68ba8` — width-exact ornament fix (the bug this brief asked me to check against) | 2026-07-07 |

**WebGL was shipped and reverted three days before the width bug was even found**, let alone
fixed. The revert can't have been a misdiagnosed width-drift symptom — that bug didn't have a name
yet. The two are chronologically and causally separate: the width bug was buffer/cursor-math
corruption in the *DOM* path (proven independently via `verify:width`/`verify:dom`, both renderer-
agnostic in cause), while the WebGL exclusion rests on the GPU texture-atlas pipeline specifically.

What the revert was actually based on, quoted verbatim from the guard comments in
`TerminalPane.tsx`/`TerminalSurface.tsx` (still in the tree, never removed): *"A 2026-07 spot-test
looked clean and v0.8.0 shipped WebGL, but real long sessions still corrupted WHOLESALE... near-
total glyph garble, atlas producing garbage for most cells... WebGL's texture-atlas failure has no
reliable software mitigation (periodic atlas clears can't keep up)."* That's first-hand production
experience — shipped to real usage, observed failing at a duration a spot-check didn't cover, and a
mitigation was tried and abandoned before reverting. Not a guess, not an inherited citation.

## WebGL — observed failure mode, two independent tests

**1. Historical / real-app (highest-evidence-weight, already covered above).** Wholesale glyph
garble over sustained real sessions; texture-atlas clears couldn't keep up. This is real-WKWebView
evidence, from actual shipped usage, not a synthetic test.

**2. External corroboration, independent of Operator entirely.** Checked
[xtermjs/xterm.js#5816](https://github.com/xtermjs/xterm.js/issues/5816) directly: **open**,
reported by a third party on **Safari/WKWebView, macOS 26.5 beta (build 25F5053d)** — same OS line
we're on (confirmed via `sw_vers`: 26.5.2, build 25F84; same kernel `Darwin 25.5.0` as every prior
check in this project's history, so **no WebKit version has moved past this since it was last
checked** — the "have we since fixed it" question has a clean no). The reporter's own words: WebGL
is *"totally broken... garbled visual output, though text remains selectable,"* with an attached
repro **specifically packaged as `xterm-webgl-tauri-repro.zip`** — someone else independently hit
this exact bug in this exact stack (xterm.js + Tauri + WKWebView) and filed it. Their workaround —
switch to the canvas addon — is not available to us (below). No maintainer response yet.

**3. My own reproduction today, Playwright WebKit (same engine family, not the exact embedding).**
Built a throwaway harness (`scripts/width-audit/webgl-spike.{html,ts,mjs}`) that loads the *same
real captured Claude Code turn* `dom-vs-buffer.ts` already uses (`claude-turn.bin`), chunked like
real pty delivery, through `WebglAddon` instead of DOM, looped up to 40 times to approximate a
sustained session (a single pass is already on record as "looked clean," so a single pass wasn't
the right test). Result: **the canvas rendered essentially blank** — no readable glyphs, one small
white artifact, across every loop count tried (1 and 40) — while an **identical harness run with
the DOM renderer, same content, same loop count, rendered perfectly** (screenshots:
`scripts/width-audit/out/{webgl-spike,dom-control}.png`). I did not stop at "it looks blank" —
`onChangeTextureAtlas` never fired once across 40 loops (`atlasEvents: 0`), meaning the WebGL
renderer's glyph-rasterization pipeline never populated its atlas at all, on a canvas confirmed to
have a real, correctly-sized backing store (`1800x1020`, matching the 2x DPR test viewport) and a
genuinely available WebGL2 context (`webgl2: true`, checked directly). I also ruled out the two
likely harness-artifact explanations before trusting this: a `preserveDrawingBuffer` screenshot-
timing gotcha (fixed, no change), and headless-WebKit-has-no-GPU (ruled out — a WebGL2 context is
demonstrably obtainable). This is a **more severe symptom than "garbled"** (nothing, rather than
garbage) — plausibly a harder failure than the production one, or a different manifestation of the
same broken atlas pipeline; either way it is not a clean pass, and it converges with both other
lines of evidence in direction if not in exact shape.

**What I could not do, and why.** The brief asks for real-app confirmation. I built a throwaway dev
instance with `TerminalSurface` temporarily forcing `webgl` on (frontend-only change, no Rust
rebuild needed) and launched `npm run tauri dev`. I could not drive it: `computer-use`'s access
grant classified Operator as a **browser-tier app — screenshot-only, no click or type** — and per
explicit instruction I did not attempt to route around that. The new window also never became
visible on screen for reasons I didn't chase further once the interaction path was closed off. I
did **not** substitute a workaround (no AppleScript/System Events input, no forcing the tier) —
flagging this honestly as a real gap rather than a settled leg. Given the other two lines are
already real-stack (history) and real-repro-in-the-same-stack (the upstream issue), I judged this
gap doesn't change the verdict, but it means the *current* macOS-26.5.2-specific confirmation in
Operator's *own* window is inherited from history and a third party's repro, not re-verified by me
today in our exact binary. Say so plainly rather than implying I completed a leg I didn't.

## Canvas — not a separate failure mode, because it isn't an available renderer

Checked directly, two ways: `node_modules/@xterm/` has `addon-fit`, `-unicode-graphemes`,
`-unicode11`, `-web-links`, `-webgl` — **no `addon-canvas`**, and no vendored copy anywhere in the
tree (the earlier vendored beta was deleted when the project moved to xterm v6). Confirmed against
xterm.js's own v6.0.0 release notes: *"Remove the canvas renderer — this addon no longer exists and
we recommend using either the DOM renderer or WebGL."* This is upstream-removed, not
Operator-disabled. **There is nothing to test here** — "does canvas share WebGL's fate" has a clean
answer: it can't, because it doesn't exist as an option on the xterm version we're on. Reverting to
xterm v5 to get canvas back would be trading one problem for a different, larger one (giving up
everything v6 brought), and isn't in scope of "GPU terminal in WKWebView" — canvas is CPU-rasterized
software rendering, not a GPU path anyway, so even if it existed it wouldn't answer this brief's
actual question.

**One more reason WebGL wouldn't be free even if the atlas bug were fixed**: a separate, unrelated
WKWebView issue ([wailsapp/wails#5111](https://github.com/wailsapp/wails/issues/5111)) reports
`devicePixelRatio=1` under a custom URL scheme on Retina displays — canvas/WebGL would render
half-resolution/blurry regardless of the atlas bug. The DOM renderer has no backing store to be
affected by this at all. Worth knowing this isn't a single-bug fix away even in the best case.

## The DOM renderer's cost — measured, not assumed

Built a second throwaway harness (`scripts/width-audit/dom-perf.{html,ts,mjs}`) using the same real
captured stream, production xterm config (`scrollback: 10000`, matching `TerminalPane.tsx`), and a
free-running `requestAnimationFrame` counter sampled over fixed wall-clock windows as the actual
frame-delivery metric (not a proxy).

| Test | Result |
|---|---|
| Idle baseline | 60 fps |
| Heavy write burst, 40 loops (174,240 chars, 1,284 scrollback lines) | **60 fps sustained**, 30,579 chars/sec |
| Heavy write burst, 150 loops (653,400 chars, 4,804 scrollback lines — 48% of the production cap) | **60 fps sustained**, 30,340 chars/sec |
| Scroll-fling (bottom→top→bottom, 240 frame-paced steps) at both depths above | **60–60.1 fps**, no measurable drop |
| 300 loops (~9,600 lines, near the full 10,000 cap) | **Inconclusive** — the harness itself became unstable/timed out. Not reproduced as a rendering problem (throughput and fps were flat and trending toward zero degradation at every point actually measured); recorded honestly rather than either extrapolated into a claim or hidden. |

**Reading this honestly**: from idle up to nearly half the production scrollback ceiling, under a
back-to-back write load far heavier than any live pty could actually deliver (a real terminal is
throttled by however fast Claude Code's own output streams, not by how fast xterm can accept
`write()` calls), the DOM renderer shows **zero measurable frame cost**. This is Playwright WebKit,
not the app's exact embedding — same caveat as the WebGL test — but the direction is unambiguous
and there's no visible trend toward a cliff anywhere I could measure it.

**`tui:default` (classic mode) cost — independent of the renderer, confirmed by where the bug
lives.** The fullscreen/alt-screen desync (`TerminalPane.tsx`'s `SIGWINCH` comment: a resize signal
landing mid-redraw desyncs Claude Code's own cursor-position math) happens **before any byte reaches
xterm's renderer** — it's a resize-timing interaction between the pty and Claude Code's own TUI
redraw logic. Both DOM and WebGL receive the identical, already-desynced byte stream in that
scenario; neither renderer choice changes it. This is why classic mode is the default regardless of
which renderer is in use — it's not a DOM-renderer trade-off, it's upstream of rendering entirely.

## What this means for the Electron question, stated plainly

**This does not decide the Electron question. It resolves one input to it from "assumed" to
"confirmed," and that input genuinely favors Electron — but it's one input, not the whole trade.**

- **Confirmed real, not speculative**: Operator lost GPU-accelerated terminal rendering in the move
  to Tauri, it is not coming back on the current WebKit, the exclusion was correctly diagnosed both
  times it was tried (v0.2-era and v0.8-era), and an independent third party's bug report in the
  identical stack backs it up. If "we can't have a GPU terminal" is a real cost to you, it is real —
  this spike removes the reasonable doubt about whether it might just be stale caution.
- **Also confirmed**: the thing WebGL would have bought — GPU-accelerated rendering — isn't
  currently buying measurable performance. The DOM renderer holds 60fps under load well past
  anything a real session would throw at it. So the cost of *not* having WebGL is not "a slower
  terminal" — it's specifically the loss of *headroom* and whatever future the WebGL path might have
  unlocked, not a present, measured deficit.
- **What this doesn't touch at all**: every other WKWebView cost the brief calls "a design rule we
  can work around" — those are unaffected by this finding either way. The bundle-size and idle-RAM
  numbers that motivated leaving Electron (`docs/tauri-migration.md`: ~250MB→~10MB, ~200–300MB→
  ~30–40MB idle) are real, independently measured, and matter more than usual given Operator runs
  **three or more instances at once** across worktrees — that multiplies the RAM side of the trade
  in Tauri's favor by exactly the factor that makes "just go back to Electron" expensive in a way a
  single-instance app wouldn't feel.

**Honest bottom line**: the renderer question is settled — GPU terminal in WKWebView is off the
table on the current stack, confirmed by three convergent, differently-sourced pieces of evidence,
not stale caution. Whether that's worth trading Tauri's multi-instance RAM/bundle advantage to get
back is a real decision with the renderer question no longer a wildcard in it — but it's a decision
about the whole trade, and this spike was scoped to one side of it.
