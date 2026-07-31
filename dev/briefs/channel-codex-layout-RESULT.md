# Channel — narrow column, digest rows, and a rule for where controls live

Answers `dev/briefs/channel-codex-layout.md` (as amended), with `channel-digest.md`'s composer
section.

---

## The measure: back to 470, with its history in the code

`PROSE` is **470 (~79 chars)**, stable at every pane width — 79 / 79 / 79 at 712 / 1152 / 1812,
where it was 96 / 151 / 151.

The comment at the site records the oscillation, because you're right that a constant which has
moved twice will move again:

> `470 → 900 → 470`. The 900 widening's *observations* were true — this feed is scanned in bursts,
> and its path-heavy content wrapped constantly at 470. **The diagnosis was wrong.** The complaint
> was never that lines were too short; it was that the space beside them was empty, and widening
> the text was the wrong way to fill it. So: **if this is ever widened again, the question to ask
> first is "what should occupy the space beside the column?" — not "how wide should the column
> be?". Longer lines are what you reach for when there is nothing else to put there.**

`ROW_MAX` and `COMPOSER_MAX = ROW_MAX` follow from `PROSE` and came back with it — composer 570px
at every width, and the hover action still sits one gap past the text rather than at a far edge.

## The clamp became the digest

`CLAMP_LINES` went **4 → 1**. You were right that a 4-line fold had stopped doing anything: a
dispatch's median body is 173 chars, which at 79 chars/line is ~2–3 lines, so the asks were never
folding while the replies (500–1300) were the blocks. One line treats both alike and lets the
reader choose which to open.

It is a **fold, not a summary**: the line shown is the message's own first line, verbatim, clipped
with an ellipsis — nothing generated or discarded. Expansion is per-entry and sticky; nothing
auto-collapses when a message arrives.

**Density: 6 → 8 entries** per screen at the default pane height (the wide-prose + 4-line baseline
was 6; the pre-digest rhythm pass had cost one entry, which this returns with interest). Measured
on the p90-heavy fixture; on real content, where the median ask is 173 chars, the gain will be
larger.

## The composer (per `channel-digest.md`)

**One row, 38px tall.** The target is now a **prefix** — `to everyone ▾` reads as part of the
sentence you're writing rather than a separate labelled control, which removes a control instead of
relabelling one.

**The chord stands in for the button.** With an empty draft there is no Send — a permanently
disabled button is chrome that teaches nothing — just a muted `⌘↵`. Send appears when there is
something to send.

Both defects from part 2 of the focus brief are fixed here, since they were in scope for the
digest's composer:

- **The grey fill is gone.** `--overlay-subtle` on a light page is the visual language of
  *disabled*, and this composer has a real disabled state. Resting is the border alone; focused
  adds the ring; disabled recedes by ink. Three distinguishable things.
- **The focus ring is `ACCENT_INK`**, not raw `var(--accent)` — this file already defines that mix
  because raw accent reads as an error state on the light palettes. Still an inset `box-shadow`.

## Button placement — the rule, and the audit

Written into `ProjectChannel.tsx` so the *next* control has somewhere to go. Four zones:

| zone | what it is | where |
|---|---|---|
| **Pane chrome** | acts on the pane as a whole | toolbar header, **right** |
| **View chrome** | changes how you see, not what you see | toolbar header, **left, leading** |
| **Per-message · incidental** | belongs to one row, optional | **hover**, row content's right edge |
| **Per-message · decision** | belongs to one row, must be answered | **persistent**, in the row body |
| **Composer actions** | act on the draft | inside the composer box, on its row |

**The audit found today's placements already correct**, which the brief allows as an outcome — but
writing it down forced one distinction that wasn't articulated: **per-message actions split in
two.** Copy is incidental and is hover-revealed at the right edge; Approve & send / Decline are
*decisions* and are persistent in the row body. A decision you must make cannot hide behind a
hover, and it needs the message it decides on adjacent to it. Without that clause the rule would
have said to move Approve/Decline to a hover rail, which would be wrong.

Placements confirmed against it: sidebar toggle (view chrome, header left) ✓; agent↔agent kill
switch (pane chrome, header right) ✓; copy (incidental, hover, right edge) ✓; Approve/Decline
(decision, persistent, body) ✓; target prefix + Send (composer row) ✓.

## Adopted vs deferred, from the reference

**Adopted:** the narrow conversation column; recovered width left empty rather than filled; the
digest one-liner; the composer docked in the column as a single row.

**Nothing qualified as a muted activity line.** You anticipated this: every entry we have is a
dispatch or a report, and both carry real content. There is no `Ran 5 commands, edited 1 file`
equivalent in this feed — inventing the category would mean inventing the events. If the
work-items direction lands, dispatch/reply *pairs* may produce something that qualifies.

**Collapsible inline cards already exist in miniature** and I did not add more: a fan-out dispatch
already collapses to one row with `delivered 4/6 · 2 queued`, and queued tasks already surface as a
per-lane badge in the Agents hub. Both use existing state. Building a third would have meant
inventing state, which you ruled out.

**Deferred: the right detail pane.** Not started, as instructed — it collides with the existing
Plan/Diff panel, and whether the channel gets its own or reuses that one is an architecture
question.

**Avatars stay.** Settled by the amendment and I never touched them; for the record I agree with
the ruling — Codex can omit author identity because it is one agent talking, ours is genuinely
multi-author, and the colour-coded author is the whole reason the UUID bug mattered.

## What the empty right side looks like — it reads as broken

**~1018px empty at a 1604px pane.** And I don't think it currently reads as *reserved*: because the
rows are full-bleed, their hover background sweeps the entire width while the content sits in the
left third, so the emptiness is actively drawn attention to on every hover. A narrow column inside
a visibly narrow container would read as intentional; a narrow column inside a full-width row reads
as unfinished.

**That is the argument for prioritising the detail pane**, and it is stronger than "it would be
nice to have". Until then the honest intermediate is what you asked for — empty rather than filled
with prose — but I'd take the detail-pane brief sooner rather than later.

## Verified

- Chars/line **stable**: 79 at all three pane widths (was 96 / 151 / 151).
- Entries per screen 6 → **8**.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**.
- `drive-project-channel.mjs` — all **33** assertions pass.
- `npm run build` clean. `npm test` **562/562**.
- Narrow pane unaffected: 326px content, 43 chars, no overflow.

## Out of scope, worth a brief

The reference's **contextual status bar** under the composer (folder, worktree, branch, model) is
genuinely useful for this app — every one of those is real state we already hold and currently show
nowhere near where you act on it. Not built, per the constraint. Worth its own brief.
