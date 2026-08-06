# RESULT — a lane switch no longer resizes every lane

## Measured, headless WebKit, the real `TerminalPane` × 5 lanes

| what | before | after |
|---|---|---|
| **terminals resized by ONE lane switch** (incoming panel state differs) | **5 of 5** — `t0,t1,t2,t3,t4`, 6 calls | **1** — `t1`, the pane becoming active, 2 calls |
| lane switch with the panel state **unchanged** (control) | 0 | 0 |
| terminals sized **at mount**, 4 of them inactive | 5 | **5** (unchanged — see regressions) |
| terminals resized by a real **OS window resize** | 5 | 1 (the active pane) |

The Research lane's falsifiable trigger is **confirmed empirically**, both directions: switching to
a lane whose `panelOpen` differs resized every mounted terminal; switching with the panel state
unchanged resized nothing at all. Each of those 5 was a real `TIOCSWINSZ` → SIGWINCH → a background
Claude Code redrawing → bytes back → `note_activity` → `phase = "running"` for 1.5s, which is the
reported "switching agents wakes up all of them".

**How it was measured** (`npm run verify:resize-guard`, new — `scripts/resize-guard/`): the same
Playwright-WebKit pattern as `verify:visual`/`verify:input`, mounting the **real** `TerminalPane`
five times in the app's own layout — absolutely-positioned siblings in one `flex: 1` container,
hidden with `visibility`, with the Plan/Diff panel as a flex sibling — against a counting
`window.operator` stub. So the number is what would have reached the pty, not a proxy for it. The
brief suggested a temporary `console.log` in the app; I could not drive the GUI from here, and a
harness gives the same receipt plus a regression gate. `--keep-panel` runs the control;
`--expect-max 1` makes it fail if the guard ever regresses.

## The change

`TerminalPane.tsx` `handleResize` now returns early unless the pane is the active one:

```ts
if (!shouldFitOnResize(activeRef.current, suspendFitRef.current)) return
```

The predicate lives in `lib/terminal-options.ts` next to `scrollbackFor(active)` — the same
per-active-state pane policy, in the file this repo already keeps such policies in, and the only
way to unit-test it given `vitest.config.ts` covers `src/**/*.test.ts` pure logic and does not
render components. It absorbs the pre-existing `suspendFit` early return rather than sitting beside
it, so the whole "may this pane fit?" rule is one testable expression. This is the pattern
`GridTerminalPane.tsx:263-269` already ships (`if (activeRef.current)` around `gridtermResize`).

## Regressions checked, not assumed

- **A pane that mounts while inactive still gets its true initial size.** `ensureInitialFit` fits
  and calls `terminalResize` **directly**, never through `handleResize`, so the guard is not in
  front of it — and the harness asserts it: 5 of 5 panes sized at mount with 4 of them inactive.
  A lane launched by a dispatch (`opts.focus: false`) still starts at the right width.
- **The activation path still fits** — `TerminalPane.tsx:646` (`fitRef.current?.fit()` when
  `active` flips true) is untouched, and it is what makes the single post-switch resize happen at
  all. The `1` in the table is that path plus the observer, on the pane you are now looking at.
- **`suspendFit` release on an inactive pane** is now a no-op. Harmless: that fit exists to snap
  the terminal to its final size after a panel drag, and an inactive pane refits on activation
  before you can see it.
- **A real OS window resize still reaches the active pane** — measured above (1 terminal, the
  active one). **Behaviour change, stated plainly:** background panes no longer follow a window
  resize immediately; they catch up when activated. That is the same trade the brief accepted for
  the switch case, and the same one `GridTerminalPane` already makes.

## Noted, not chased (per the brief)

A spurious `running` blip never re-armed the keep-warm timer (`lastActivityAt` comes only from a
transcript line's own timestamp), but it could make a close-eligible lane transiently ineligible
for ~1.5s via `laneCloseDecision`'s `if (BUSY.has(lane.phase))`. With the traffic gone, so is the
window.

## Done

- `npm test` **681/681** (+4: `shouldFitOnResize` — inactive pane does not reach the pty; active
  pane still fits; the drag hold in both states)
- `npx tsc --noEmit` clean · `npm run build` green
- No instrumentation left in product code — the measurement lives in `scripts/resize-guard/`
- Committed on `operator/6e13d8` (see `git log`)
