# Brief — channel layout: direction A (roomy), left-aligned and full-bleed

User reviewed three mocked directions and chose: **"A but left aligned, full width."**

Direction A is the Slack-default shape — real avatars, generous rows, hover actions, author-run
grouping. You already built the grouping and the clamping; this is the **layout frame** around it.

## What's wrong today

The feed sits in a fixed centred column (`MEASURE = 720`) inside a ~2000px window, so roughly
1200px is dead space to the right, and the content floats in the middle of a very wide field.

## What to build

**Rows go full-bleed. Prose does not.**

- The message **row** — its hover background, its hit area, any separator — spans the full width of
  the channel pane, edge to edge. No centred column, no visible gutter of empty page.
- Content is **left-aligned** against a fixed left inset, so the avatar column, author names and
  body text all share one hard left edge down the whole feed.
- **Body text keeps a readable measure.** A full-bleed row at 2000px with unconstrained text is
  ~300 characters a line and unreadable. Your own channel work already established the number —
  the redo brought prose to ~79 chars/line. Cap the body, left-aligned within the full-bleed row.
  The row is full width; the paragraph is not. That distinction is the whole design.
- The **header and composer** align to the same left inset, so the three parts of the pane share
  one edge rather than each being centred on its own.

Right-hand furniture (timestamp, chip, hover actions) can sit at the row's right edge now that the
row has one — that's the affordance the centred column had nowhere to put.

## Judgement calls that are yours

- Whether the measure is a hard `ch` cap or a `clamp()` that lets the body grow a little on very
  wide windows before stopping.
- What, if anything, uses the recovered space at very wide sizes. Options: nothing (honest and
  cheap); right-aligned meta; or a genuine second column later. **Do not invent a sidebar in this
  pass** — the user asked for a layout change, not a new panel.
- Whether very narrow widths (the pane is resizable, and the Plan/Diff panel steals from it) need
  the avatar column to collapse.

## Constraints

- Everything you shipped in the channel pass stays: clamped bodies with Show more, author-run
  continuation collapsing identity only, `parseInline`, sticky day separators, the chip tones.
- Hover actions need a **visible keyboard focus state** — they're the first interactive furniture
  in the feed, and the house rule is no browser focus rings, so give them a real one of their own.
- Transparent badges; no solid accent fills; `laneTextColor` for names; no colour-changing border
  on a radiused element; never stack opacity on `--fg-muted`.
- Scroll position must not drift on reflow — this pane is live and a width change re-wraps
  everything.

## Depends on

`dev/briefs/channel-author-uuid.md` (Code): lane replies currently show a raw session UUID as the
author. **The colour-coded author is the load-bearing element of direction A** — build the layout
assuming names resolve; don't design around the hash.

## Verify

- Drive it at **three widths**: the pane narrow (Plan panel open), default, and a ~2000px window.
  Report characters-per-line for the body at each. The 2000px case is the one that motivated this.
- Confirm the header, feed rows and composer share one left edge — measure it, don't eyeball it.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs` if any ink changes.

## Where to work

`main` is at `8b40454`. Commit in your own worktree; I'll merge forward. Do not edit
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-layout-full-bleed-RESULT.md`: the measure you chose and why, chars/line at the
three widths, how the left inset is shared across header/feed/composer, and what happens to the
recovered space. Then one OPERATOR-REPLY line.
