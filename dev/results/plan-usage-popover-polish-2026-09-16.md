# Plan usage popover polish — 2026-09-16

Lane: Design. Worktree: `~/.operator/worktrees/operator-666300` (branch `operator/666300`), uncommitted.
Files: `src/renderer/components/session/FooterReading.tsx`, `src/renderer/lib/footer-reading.ts`,
`src/renderer/lib/footer-reading.test.ts`.

## Verification

- Renderer suite: `npx vitest run` — 84 files, 1310 tests passed (3 new).
- `npx tsc --noEmit -p .` — exit 0.
- Not verified in the GUI. The popover needs `window.operator.planLimits`, so it does not render in a
  plain browser. Light/dark and the 0% row still need to be checked in the app.
- The worktree had no `node_modules`; I symlinked the main checkout's (`node_modules -> ~/Developer/operator/node_modules`).
  Git ignores it. Remove it if you don't want it there.

## Defects and changes

### 1. Header wrapped, plan badge clipped
Cause: the CLI's plan line (`You are currently using your subscription to power your Claude Code usage`)
was rendered in an uppercase, nowrap, bordered chip beside the title in a 320px panel.

Spec: the plan line never goes in a chip and never has `nowrap` on arbitrary text.
- New `planBasis(plan)` in `footer-reading.ts`. The main process (`electron/src/main/plan-limits.ts:58`)
  only keeps a line that mentions "subscription", so that case collapses to the word `Subscription`,
  shown right-aligned on the title row in 10px `--fg-muted`, with the full sentence as its tooltip.
- Any other line is shown whole on its own row under the title. It wraps (`overflow-wrap: anywhere`) and
  its last two words are joined with a non-breaking space, so the line never ends on one stranded word.
- The title row can no longer wrap: title is `nowrap` and the only thing beside it is one short word.

### 2. Cell tooltip covered the open panel
`title` on the plan cell is now `undefined` while the panel is open. The closed cell keeps
`Highest limit: … — click for every limit`.

### 3. Three type systems
One hierarchy, body font throughout, mono only for the percentages (they need to line up):

| Role | Font | Size | Ink |
|---|---|---|---|
| Title `Plan usage` | body, 600 | 12 | `--fg` |
| Plan word / status line / reset lines | body | 10 | `--fg-muted` (no opacity) |
| Row label | body | 11.5 | `--fg` |
| Percentage | mono, tabular | 11 | `TONE_INK[tone]` |

Removed: tracked uppercase mono header, mono status line, mono reset lines. Reset lines keep
`tabular-nums` so the dates don't shift.

### 4. Rows didn't group
Before: label→bar 5px, bar→reset 4px, row→row 12px, so the eye saw a flat list.
After: label→bar 4px, bar→reset 3px, row→row 14px. Header block to first row 14px.
The gap between rows is now about four times the gap inside a row (before it was about two and a half times).

### 5. 0% bar had no anchor
- Panel bars use `--overlay-medium` for the track (was `--overlay-subtle`, 5% black on the light
  palettes, which barely showed at full width). The footer strip keeps `--overlay-subtle`.
- `Bar` has a new `zeroTick` prop. In the panel, a real 0% draws a 2px stub of the tone fill at the
  start of the track, so the row reads as a meter at zero. Rows only exist when a value was read
  ("absent is not zero" is kept), so the stub never stands in for missing data. The context cell does
  not use `zeroTick`, so its "no value yet" track stays bare.

## Rules checked
- No opacity on `--fg-muted` anywhere in the panel.
- No new hardcoded colours; all ink/fill/track values are existing tokens or `TONE_*`.
- No dynamic border on a radiused element (the bar stays background-only).
- No text in the panel is `nowrap` except the fixed title, the one-word plan label and row labels
  (which already ellipsize).

## Still open
- GUI check in both themes: header row, a wrapped non-subscription line, the 0% stub, and that the
  tooltip no longer appears while open. Native tooltips that are already showing when you click may
  stay up until the pointer moves in some Chromium builds. If that still happens, the fix is a
  custom tooltip, not `title`.
