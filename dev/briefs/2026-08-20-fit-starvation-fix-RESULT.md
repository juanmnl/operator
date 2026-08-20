# Result — bound the terminal fit's "quiet" deferral

**Done.** The gate is kept; the wait is bounded. `tsc` clean, **786/786 tests pass** (see the
environment note at the bottom — the suite needs one Node flag on this machine, and that is not
a regression).

## What changed

Three files, one commit.

**`src/renderer/lib/terminal-options.ts`** — the deferral decision extracted as a pure function,
next to `shouldFitOnResize`, which is its exact sibling policy:

```ts
export const FIT_QUIET_MS = 150      // moved here from TerminalPane; value unchanged
export const FIT_MAX_DEFER_MS = 500  // new: the bound

export function planDeferredFit(
  now: number, lastDataAt: number, firstDeferAt: number | null,
  opts: { quietMs?: number; maxDeferMs?: number } = {},
): { fit: boolean; retryInMs: number }
```

The rule: fit if output has been quiet for `FIT_QUIET_MS`; **also** fit if this request has been
held for `FIT_MAX_DEFER_MS`; otherwise wait out the rest of the quiet window — but never past the
deadline, so the last hop cannot overshoot the bound by a whole quiet window.

**`src/renderer/components/terminal/TerminalPane.tsx`** — a `firstDeferAtRef` beside
`pendingFitRef`, `handleResize` asking the helper instead of doing the arithmetic inline, the
stamp set on the *first* hold only and cleared when a fit actually runs. `pendingFitRef`'s
clear-and-replace semantics are untouched, so a burst of ResizeObserver callbacks still collapses
into one fit. The local `FIT_QUIET_MS` const is gone in favour of the shared one.

**`src/renderer/lib/terminal-options.test.ts`** — 11 new tests.

### Why the stamp resets on *fit* and not on each resize

This is the one subtle decision. Resetting the budget whenever a new resize replaces a pending one
would let a burst of callbacks — which is the normal case during a panel drag — push the deadline
out indefinitely. That is the same starvation wearing a different hat, so the budget belongs to
the deferral, not to the individual callback. There is a test for it.

## The tests

Five unit tests on `planDeferredFit` (idle → fit; never-received-output → fit; mid-burst → defer
with the right retry; past the bound → fit however busy the stream; retry never scheduled past the
deadline), and six that drive a **simulation of the pane's own loop** — refs, replace-on-new-
resize, retry timer — against a fake clock:

| Test | Asserts |
|---|---|
| idle: fits immediately, once | `[0]` |
| **WITHOUT the bound, a 60 ms stream starves the fit completely** | `[]` — 0 fits in 2000 ms |
| data every 60 ms: fits within `FIT_MAX_DEFER_MS + FIT_QUIET_MS` | first fit ≤ 650 ms |
| data every 60 ms: fits ONCE for one resize | length 1 |
| a second resize during the deferral replaces, does not stack | 1 pending, 1 fit |
| a continuous drag does not restart the budget | first fit ≤ 650 ms |

**The counterfactual test is the one that makes the rest mean anything.** It runs the identical
loop with `maxDeferMs: Infinity` and asserts **zero fits in 2000 ms** — QA's "0 resizes in 2000 ms"
reproduced as an assertion. Without it, the suite would pass just as happily against the broken
code.

Two mistakes worth recording, because both produced *passing* tests that proved nothing:

- The simulator first started `lastDataAt` at 0 on a clock that also started at 0, which reads as
  "a chunk just landed" and gated the idle case. In the pane, `lastDataAtRef` starts at 0 against
  a real epoch clock, so "never" is an enormous quiet period. Fixed with an explicit
  `busyAtStart` flag rather than a magic zero.
- With an idle start, the *streaming* tests fitted at t=0 before the gate was ever reached — green,
  and testing nothing. They now start with the stream already running, which is the reported
  scenario: a resize arriving into live output.

## Timings

From the simulation (1 ms steps), stream ticking every 60 ms — inside the quiet window, so the gate
never opens on its own:

| | first fit |
|---|---|
| before (unbounded) | **never** — 0 fits in 2000 ms |
| after | **500 ms** |
| idle case, unchanged | 0 ms (immediate) |

500 ms is the deadline exactly, because a 60 ms stream keeps `sinceData` under the quiet window for
the whole budget, so the bound is what fires. Worst case is `FIT_MAX_DEFER_MS + FIT_QUIET_MS` =
650 ms, when the stream stops just before the deadline and the pending retry is already scheduled.

**Not run: QA's `dev/drive-sidebar-collapse-vspace.mjs`.** It drives the mock harness over a Vite
dev server, and this worktree's product source is currently also feeding the Electron spike's
measurement bench — every save to `TerminalPane.tsx` HMR-reloads it. Running a second driver
against the same source while those measurements are live would have confounded both. The
simulation covers the same property with a deterministic clock, and the live check is worth
re-running once the bench windows are closed.

## Environment note — the suite is green, but not with a bare `npm test` here

`npm test` on this machine reports **33 failures across 5 files**, and it reports exactly the same
33 on a clean checkout with none of this work applied. Every one is
`Cannot read properties of undefined (reading 'clear'/'setItem')` — `localStorage` is undefined
under jsdom.

The cause is **Node v26.7.0**, which defines its own `localStorage` global that jsdom cannot
override and that is inert unless `--localstorage-file` is passed:

```
ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
```

Proof, not inference:

```
$ npm test                                                    →  33 failed | 753 passed (786)
$ NODE_OPTIONS="--localstorage-file=/tmp/ls.db" npm test       →  61 files, 786 passed (786)
```

So: **no regression, and this change adds 11 passing tests and zero failures** (baseline 775 tests
/ 33 failing → 786 tests / 33 failing, same 33). CI runs Node 20 and is unaffected. Worth deciding
separately whether to pin Node for local dev or add the flag to the test script — it currently
makes a clean checkout look broken to anyone on Node 26.
