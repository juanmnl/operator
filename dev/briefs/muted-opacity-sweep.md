# Stacked `opacity` on `--fg-muted` — app-wide sweep, then a guard

**63 occurrences across 23 files** in `src/renderer` (grep: `--fg-muted` on a line that also sets
`opacity`). This is a standing user rule, not a preference:

> **NEVER stack `opacity` on `--fg-muted`.** The token already *is* the recede. Stacking measures
> 1.8–2.9:1 and is effectively invisible on the three light palettes. Hierarchy comes from token +
> size, never from a second alpha.

**Deliverable: fix them, then add the guard. Report in `dev/muted-opacity-sweep.md`.**

## Why this is a task and not a cleanup note

This rule has been "fixed" at least three times already and keeps coming back:

- `ActivityDashboard` fixed it once.
- The four-theme pass on project-first navigation found **24 fresh instances** and cleared them.
- The settings-page spec called out ~8 more and said the template must fix rather than cement them.
- Review's §5 on the current tree found **four newly added** on top of that.

Every one of those was a manual sweep, and the count is now higher than before any of them. A rule
enforced only by review is not enforced. **The sweep is the smaller half of this task; the guard is
the point.**

## Build

1. **Fix all 63.** Remove the stacked alpha. Where something genuinely needs to sit below
   `--fg-muted` in hierarchy, use a smaller size or a different token — do not swap one alpha for
   another. Known offenders include `CommandPalette` (6), `PluginsSection` (4+), `Sidebar`,
   `SidebarRail`, `GeneralSection`, `ListEditor`, `AgentLibraryView:268`.
2. **Add a mechanical guard that fails the build.** A unit test scanning `src/renderer` for the
   pattern is enough and needs no browser — it runs in `npm test` where every lane and CI will hit
   it. Contrast measurement already exists in `dev/drive-theme-pass.mjs`; the guard is about
   *preventing reintroduction*, so favour the cheap always-on check over the thorough occasional one.
3. Some hits are **comments explaining the rule** (`PageShell`, `InstructionsSection`, `Sidebar`).
   The guard must not trip on those — match declarations, not prose.

## Care required

- Do not blanket-delete every `opacity` in the codebase. The rule is specifically about stacking on
  `--fg-muted`. An `opacity` on a disabled control, or on a non-muted colour, may be legitimate —
  judge each, and say in your report which ones you kept and why.
- **Never recede a card with a group `opacity`** either (it compounds, can't be overridden per
  child, and halves contrast) — if you find that pattern while in here, report it separately.
- Verify with `dev/drive-theme-pass.mjs` across all six palettes; expect **0 below floor**
  (4.5:1 body, 3:1 meta).

## Note

Low severity individually, systemic in aggregate: it makes text invisible on three of six palettes,
and it is the single most-repeated defect in this codebase's history. Worth doing properly once.
