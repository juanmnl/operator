# Roster panel: four different left edges in one column

**Reported:** 2026-07-28, *"improve alignment"*.
Screenshot: `/tmp/operator-shots/2026-07-28-roster-alignment.png`

The READY list reads as ragged because content in one vertical column starts at four different x
positions. Measured from `RosterPanel.tsx`:

| Element | Left inset | Source |
|---|---|---|
| `READY · 6` / `TASKS` section label | **2px** | `SectionLabel` `margin: '0 0 8px 2px'` (`:651`) |
| `+ Add agent` text | **12px** | `padding: '0 12px'` (`:346`) |
| Lane orb in a `LaneRow` | **26px** | 8px padding + 10px handle + 8px gap (`:693`, `:711`) |
| Lane name | 26px + orb + gap | after the above |

## The cause of the big one

`LaneRow`'s drag handle (`:705-711`) is `width: 10` with `opacity: hover ? 1 : 0`. It is invisible
at rest but **still occupies its 10px plus the row's 8px flex `gap`**. So every idle lane carries
~26px of empty gutter before its orb, permanently, for an affordance you cannot see until you hover.

That is what makes the lane names look pushed away from the section header above them — and why
`+ Add agent`, which has no handle, doesn't line up with the lanes it sits among, even though the
comment at `:643` says the whole point is that it matches.

## What to decide

The rule should be **one left edge for the column** — section label, row content, and `+ Add agent`
all starting at the same x. The open question is where the drag handle goes so it costs nothing at
rest:

- Absolutely position it in the row's left margin (outside the content flow), fading in on hover.
  Keeps one content edge; the handle overhangs into the gutter the panel already has.
- Keep it in flow but give the whole column that same inset, and move the section labels to match.
  Simpler, but spends 26px of a narrow panel on nothing.
- Something better — your call.

**Do not** shift content horizontally on hover. A row whose text jumps when the pointer crosses it
is worse than the misalignment.

Check the same question in the live `RoleCard` (`:490`+), which has its own handle and its own
padding (`'11px 13px'`, `:427`), and in the sidebar, so the fix does not just move the seam.

## Constraints

- The panel is narrow (see the screenshot) — every px of gutter is real estate.
- House rules apply: no solid accent fills for state, no colored left-border marker stripe, never
  stack `opacity` on `--fg-muted`.
- Verify with `dev/drive-roster.mjs` and the theme pass across all six palettes. Assert the left
  edges mechanically — measure `getBoundingClientRect().left` for the section label, a lane's orb
  and the add-agent text, and assert they match. An alignment fix without a measurement is a fix
  that regresses silently.
