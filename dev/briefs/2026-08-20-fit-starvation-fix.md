# Brief — bound the terminal fit's "quiet" deferral so streaming output can't starve a resize

**Implement + test. Small, self-contained — ONE commit on your branch, cherry-pickable, touching
only `src/renderer/components/terminal/TerminalPane.tsx` (+ a test).**
Output: **`dev/briefs/2026-08-20-fit-starvation-fix-RESULT.md`** (what changed, the test, and the
timings you observed).

## The defect (confirmed by QA, `dev/briefs/2026-08-20-sidebar-collapse-terminal-vspace-RESULT.md`,
and re-verified in source)

`TerminalPane.tsx:110-132` `handleResize`: if output arrived within `FIT_QUIET_MS` (150 ms, L93),
it reschedules itself and returns — **with no bound**. Under a stream that ticks faster than every
150 ms (a Claude Code spinner does), the fit never runs: QA measured **0 resizes in 2000 ms** after
a sidebar collapse, while the idle case fits once at ~327 ms. This is the "slow to take the freed
width" the user reported, and it applies to every resize source (sidebar, window, panel drag),
not just the collapse. The one-shot settle at L630-632 (`suspendFit → false`) routes through the
same gate and is starved too.

## The fix (keep the intent, bound the wait)

The gate exists so a resize doesn't interrupt a TUI redraw mid-frame — keep it. Add a **maximum
total deferral** measured from the FIRST deferral of a given resize request (e.g. `FIT_MAX_DEFER_MS
= 500`): once exceeded, call `doFit()` regardless of `sinceData`. Reset the "first deferral"
stamp whenever a fit actually runs. Keep the `pendingFitRef` clear/replace semantics as-is so a
burst of ResizeObserver callbacks still collapses into one fit. Don't change `FIT_QUIET_MS`.

## Test

`src/renderer/components/terminal/*.test.ts(x)` — extract the deferral decision into a pure
helper if that's what makes it testable (pattern: `shouldFitOnResize` in
`src/renderer/lib/terminal-options.ts`), and assert: (a) idle → fits immediately; (b) data every
60 ms → fits once within `FIT_MAX_DEFER_MS + FIT_QUIET_MS`, not never; (c) a second resize during
the deferral replaces, not stacks. `npm test` green, `tsc` clean. If QA's driver
`dev/drive-sidebar-collapse-vspace.mjs` runs for you (`MOCK_PORT=<your port>`), run it streaming
and paste the resize timestamp.
