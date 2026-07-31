# Composer proportions

Answers `dev/briefs/composer-proportions.md`. All three complaints, and one of them made me
abandon an argument mid-way.

---

## The width rule

**The composer's surface is a feed row's content box: `COMPOSER_MAX = ROW_MAX`.**

Stated plainly: the composer relates to the **feed**, not to the pane and not to a number of its
own. The shared left edge already commits the pane to reading as one column; this finishes it.

`COMPOSER_MAX = 720` was defensible when it was written — writing isn't reading, and a 79-char
measure is a cramped place to compose. But once the rows grew to a 900px prose ceiling, a fixed 720
under 1000px-wide messages stopped looking like a decision and started looking like a leftover.

**Rejected:** *filling the pane minus the inset* — the composer would then be wider than any
message, and at 1800px it is a 1780px textarea. *Keeping a separate cap* — the complaint is
precisely that a separate cap looks accidental at width.

## The three-width table

```
pane (content)      composer     ROW_MAX     composer height   target → Send
 712px (706)        680px  ←cap by pane        1000               60px           6px
1152px (1146)      1000px  ←at ROW_MAX         1000               60px           6px
1812px (1806)      1000px  ←at ROW_MAX         1000               60px           6px

before (all three)  720px flat                 1000               65px         553px
```

The composer now grows with the pane and stops where a message does, instead of sitting at a flat
720 whatever the pane is doing.

## Send — and the argument I had to drop

**553px → 6px.** It sits directly beside the target control now; the `flex: 1` spacer that pushed
it to the far right is gone.

I nearly argued something else and the measurement killed it. Having matched `ROW_MAX`, my first
instinct was to keep Send at the container's right edge and claim that edge was now *meaningful* —
the same vertical line every row's hover action sits on. **It isn't.** I measured it: rows hug
their own text (`fit-content`, from the prose-wider pass), so the row I tested ends at **675px**
against a **1016px** composer. There is no shared right edge to anchor to, and matching `ROW_MAX`
had actually made Send *worse* — 553 → 835px — before I moved it.

Your framing was exactly right: *if Send belongs at the right edge, the container is too wide —
those are the same problem stated two ways.*

`fit-content` — the fix in the feed — cannot be the fix here: a composer that hugs its content
collapses to nothing when empty, and the input must be a stable target. So the cluster moved to the
content rather than the content to the cluster.

**Bottom-left is not the convention** (Slack, Linear put submit bottom-right), and I want to be
explicit that I chose against it. That convention assumes a container whose right edge means
something. Here it doesn't — rows end wherever their words do — and everything else in this pane is
anchored left. If it reads wrong in use, the alternative is a narrower container, not a
right-aligned button in a wide one.

## Resting height

**65px → 60px.** The slack was padding, not the row count (`rows={1}` auto-grow was already right):
the textarea's `9px 11px 4px` → `7px 10px 2px`, the action row's `0 7px 7px` → `0 6px 6px`, and the
outer `10px/12px` → `8px/10px`.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- The three-width numbers are now printed by `dev/drive-channel-view.mjs` alongside the pane and
  row measurements, so the *relationship* is checked rather than the absolutes — your point that
  "the complaint is a relationship, not an absolute".
- Narrow pane unchanged: 326px content, 43 chars, no horizontal overflow.
- Shared left edge intact: header / row / composer all at **16** at every width.
- **No theme pass** — nothing moved but widths and padding. No colour, token or ink.

## Kept from the composer pass

One container, one target control, the chord stated once, the count inside, the inset box-shadow
focus ring, the 160px grow ceiling, the feed's bottom mask.

## Still open from that pass

The **19px width-change scroll drift** is unchanged and still unfixed — see
`channel-composer-RESULT.md`. Nothing here touches it.
