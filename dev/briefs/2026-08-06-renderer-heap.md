# RESEARCH: ~1GB of retained JS heap in the renderer — find what holds it

**Lane: Research. Investigate and report — change no product code.** Probes under `dev/` are fine.

## What is measured, not guessed

The WKWebView renderer is killed and respawned roughly hourly. A watcher captured peaks immediately
before death: **1089MB and 1196MB** (fresh pids, ~1h apart). `sample` on a live renderer at
**949.5MB footprint, 1.5GB peak** shows:

- **The main thread is idle.** All 2498 samples sit in run-loop/XPC plumbing — no app work.
- **The only busy thread is `scavenger_thread_main` (JavaScriptCore, 2487 samples)** — libpas, the
  memory-reclaiming thread. So the ~23% idle CPU is **the garbage collector grinding a large heap**,
  not rendering or React. The CPU is a symptom of the memory, not a separate problem.

**And the retention is NOT lane-scoped.** The user closed 17 of 27 lanes; the renderer fell from a
1196MB peak to 1060MB — about **8MB per lane**. If per-lane state were the bulk, closing 63% of the
fleet would have released far more. Roughly **1GB is baseline or leaked**, and it survives lane
closure.

## The question

**What retains ~1GB of JS heap in Operator's renderer, and what releases it?** Static audit informed
by the evidence above — a heap snapshot needs the GUI and is the user's to take, so do not wait on
one. Name suspects with `file:line` and say how each would be confirmed.

## Leads worth checking first — these are guesses, disprove them freely

1. **xterm instances and their buffers on close.** `TerminalPane.tsx:593` and
   `GridTerminalPane.tsx:422` call `term.dispose()`, so the obvious path exists — **verify it
   actually runs on every close path**, including a lane closed from the board, from the rail, via
   `closeProject`, and now via the new task-scoped auto-close (`lib/lane-lifecycle.ts`, merged
   tonight). A disposal that only fires on unmount misses a tab that stays mounted.
2. **Scrollback.** `terminal-options.ts` already has a policy: `ACTIVE_SCROLLBACK` vs
   `INACTIVE_SCROLLBACK = 2_000` via `scrollbackFor(active)`. Its own comment notes a reactivated
   pane *"could restore what it dropped"* but that this was deliberately not built. Check what the
   totals actually are with N panes mounted, and whether trimming is applied on every transition or
   only some.
3. **Transcript / chat accumulation.** Chat reads transcript JSONL and `chat.db`. Prior art in this
   repo: react-markdown re-parse × `session:update` pegged WebContent, fixed with a memo and a 16KB
   cap (`project_chat_markdown_freeze`). Look for the same shape elsewhere — arrays of parsed
   messages that only grow, per-session caches with no eviction, `useMemo` keyed on something that
   changes every tick.
4. **Listeners and subscriptions.** `window.operator.on*` subscriptions, `gridterm:update` handlers,
   pty data handlers. An unremoved listener retains its whole closure — which for a terminal handler
   is the buffer.
5. **The `sessions`/`terminals` arrays themselves.** Ended tabs "linger mounted" by design (the
   `ended` guard in `pickLaneTab` exists precisely because of that). Find out for how long, and what
   they hold.

## What the output must contain

- **A ranked list of retainers** with `file:line`, each with the evidence for it and the cheapest way
  to confirm — ideally something measurable without a heap snapshot (e.g. instrument a counter, or
  compare `performance.memory`/`vmmap` across a scripted open-close cycle in the existing
  `dev/drive-*.mjs` harness pattern).
- **One number that matters:** how much of the ~1GB each suspect could plausibly account for. A list
  of ten theoretical leaks is less useful than "this one is probably 600MB".
- **Whether it is a leak or a baseline.** These need different fixes: a leak means something isn't
  released on close; a baseline means the app genuinely costs 1GB and needs caps. The 8MB-per-lane
  measurement suggests the latter for lanes, but says nothing about the rest.
- Explicitly say what you could NOT determine without a heap snapshot, so the user knows what a
  snapshot would buy.

## Context that constrains fixes

- The DOM renderer is not negotiable — WebGL/canvas corrupt in WKWebView, re-confirmed 2026-08-04.
- Do not propose reducing lane count as the fix; that was measured and it is worth ~8MB/lane.
- Lanes now auto-close 10 minutes after reporting done (merged tonight), so any fix should assume
  the fleet shrinks on its own.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-renderer-heap-RESULT.md`
(absolute path, main repo).
