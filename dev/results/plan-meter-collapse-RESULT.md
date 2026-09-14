# Plan meter collapse — RESULT

Design lane, 2026-09-14. Built on `operator/b11dc0`. **Not verified in a real window**: no GUI run,
no screenshot, no contrast measurement. Pure functions are tested; the component is typechecked
only.

## What changed

The right end of the session footer used to show every limit inline:
`Current session 6% · Current week 83% · Current week (Fable) 97%`, each with a bar. It is now one
cell. Clicking it opens a panel above it with everything the plan reading knows.

### The collapsed cell

```
│ ctx 84k / 200k ▬▬ │ Opus · High │ Week (Fable) 97% ▬▬ +1 ▴ │
```

- **Label + percentage of the limit closest to its cap** (the existing `bindingLimit`), with the
  label shortened the same way the rail foot already does (`Current week (Fable)` → `Week (Fable)`).
  The limit is named, not just a number, so the "it only shows Fable" misreading cannot return.
- **The percentage and bar take the limit's tone**: bar in `TONE_FILL` (accent below 75, amber from
  75, error from 90); the percentage in a new `TONE_INK`, which is the tone mixed 50% into `--fg`
  (the same construction as the roster's warning ink, because raw amber at 10px fails contrast on the
  light palettes). The label stays control ink.
- **`+N` when other limits are also at or past 75%**, in the worst of their tones. With the reported
  reading (6 / 83 / 97) the cell shows `Week (Fable) 97%` plus `+1` in warning ink, so the week at 83%
  is still visible without opening anything. The title spells it out:
  `Highest limit: Week (Fable) 97% · Week 83% is also high — click for every limit`.
- **Aging** keeps the amber dot in front. **No reading / window closed** keep the existing
  `plan [NO READING]` / `plan [WINDOW CLOSED]` chips. **Loading** shows `plan …`. No state without
  data renders a percentage.
- `▴` caret at rest (it opens upward), `▾` while open. Transparent at rest, `--overlay-subtle` on
  hover, focus and while open. No border, no fill, no focus ring.

### The panel

```
┌──────────────────────────────────────┐
│ PLAN USAGE                    [MAX]  │
│ Updated 3m ago                       │
│                                      │
│ Current session                   6% │
│ ▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ Resets Sep 14 at 6pm (America/…)     │
│                                      │
│ Current week                     83% │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░ │  amber
│ Resets Sep 15 at 12:59am (…)         │
│                                      │
│ Current week (Fable)             97% │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░ │  error
│ Resets Sep 15 at 12:59am (…)         │
│                                      │
│ <note, when the reading carries one> │
├──────────────────────────────────────┤
│ Refresh                Open Tuning → │
└──────────────────────────────────────┘
                     │ Week (Fable) 97% ▬▬ +1 ▾ │   ← the cell, in the footer
```

- Every limit from `limitRows`: full label, percentage, full-width bar, and the reset clause verbatim.
  Also shown when present: the plan name (`limits.plan`, transparent chip), `limits.note`, and the
  freshness status (`Updated 3m ago`, `Updated 12m ago · may be out of date`, `No plan reading right
  now`, `The session window this reading described has closed`, `Reading plan limits…`).
- **Every bar in its own tone here.** The old strip coloured only the binding row, so three amber bars
  side by side would not read as three alarms. In this list each bar sits next to its own number, and
  a grey bar beside "83%" would contradict it.
- **Refresh** (forces a read, shows `Refreshing…` while loading) brings back the explicit refresh the
  earlier design dropped with the rail popover. **Open Tuning →** closes the panel and opens Tuning,
  which is what clicking the cell used to do.
- **Opening revalidates**: it calls the hook's `revalidate`, which re-reads only if the reading has
  aged out.
- **Placement**: fixed position, portalled to `body`, 320px wide, opening upward with its right edge
  aligned to the cell. If the window is narrower than 336px it narrows instead; it never crosses an 8px
  window margin; its height is capped to the room above the cell and it scrolls inside that. It
  re-measures on window resize.
- **Dismissal**: through `useDismiss`, so outside pointer-down, Escape (focus goes back to the cell)
  and focus leaving the panel all close it, and so does clicking the cell again. Focus moves into the
  panel on open (`role="dialog"`, `tabIndex -1`), so Escape is caught before it reaches the terminal.
  **Scroll does not close it**: `useDismiss` closes on any document scroll, and the terminal's viewport
  scrolls every time a running lane prints, which would close the panel while you read it. So
  `useDismiss` gained a `closeOnScroll` option, which defaults to `true`; existing callers are unchanged.
- Surface `--bg-surface`, 1px `--border`, radius 10, `--shadow-panel`. z-index 950: above toasts (900),
  below the ⌘K palette (1000).

## Where

| What | File:line |
|---|---|
| Collapsed cell | `src/renderer/components/session/FooterReading.tsx:198` (`PlanCell`) |
| `+N` marker | `FooterReading.tsx:270` |
| Revalidate on open | `FooterReading.tsx:244` |
| Dismissal without scroll-close | `FooterReading.tsx:210` |
| Panel (portal, rows, footer) | `FooterReading.tsx:303` (`PlanPanel`), portal `:313`, per-row tone `:351`, Tuning `:393` |
| Label shortening (shared with rail foot) | `src/renderer/lib/footer-reading.ts:133` (`shortLimitLabel`) |
| Cell reading | `footer-reading.ts:172` (`planSummary`) |
| Cell tooltip / panel status copy | `footer-reading.ts:190` (`planCellTitle`), `:203` (`planPanelStatus`) |
| Placement | `footer-reading.ts:218` (`PLAN_PANEL_W`), `:228` (`planPanelPlacement`) |
| Warning text ink | `src/renderer/lib/plan-limits.ts:46` (`TONE_INK`) |
| `closeOnScroll` option | `src/renderer/lib/use-dismiss.ts:30`, `:80` |
| Wiring (`loading`, `onRefresh`, `onRevalidate`) | `src/renderer/views/DashboardView.tsx:5154-5156` |
| Tests | `src/renderer/lib/footer-reading.test.ts:264-398` |

`railFootPlanText` now uses `shortLimitLabel`; its output is unchanged and its four existing tests pass.

## Tests

- `footer-reading.test.ts`: 31 → 47 tests (+16):
  - `shortLimitLabel` (1)
  - `planSummary` (6): reported reading 6/83/97 → `Week (Fable)` 97 danger with `week` in `alsoHigh`; nothing extra when only one limit or none is high; tone taken from the rounded number; no label or percentage for no-reading, loading and window-closed; aging keeps the number
  - copy (4), including a check that no status or tooltip string contains a sentence break, so no word can be stranded after a full stop
  - `planPanelPlacement` (4): upward with right edges aligned, narrow window, both edges, no negative sizes
  - `TONE_INK` (1): no `--fg-muted`, no opacity, and the warn/danger inks mix into `--fg`
- Full renderer suite: **77 files, 1184 passed, 0 failed** (`npx vitest run`).
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- The worktree had no `node_modules`; the run used a symlink to `~/Developer/operator/node_modules`
  (`package.json` and the lockfile are identical at both HEADs). The symlink was removed after the run.

## Not verified

- Not opened in a real window. Unchecked: how the cell looks at footer widths, the panel's position
  and upward opening, Escape and outside-click in Electron, focus moving back, and whether the
  terminal still takes keys after the panel closes.
- Contrast not measured. `TONE_INK.warn` is the same mix as the roster's already-checked warning ink;
  `TONE_INK.danger` (`--color-error` 50% into `--fg`) has not been checked on the six palettes.
  `dev/drive-theme-pass.mjs` would need a probe for `[data-plan-cell]` and `[data-plan-panel]`.
- `limits.note` and `limits.plan` are rendered as delivered. Their text comes from the backend, and I
  did not check what they contain on a real account.
- The `+N` marker counts limits at or past 75%. Whether the user wants a lower threshold for noticing
  a second limit is a product call, not measured.
