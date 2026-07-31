# Channel header alignment — the channel wasn't the outlier

Answers `dev/briefs/channel-header-alignment.md`. **This inverts the brief's premise, and that is
the finding.**

---

## Which family, and which member was wrong

**The channel is a toolbar header.** Confirmed, as you asked me to: it carries `#` + project name
+ the agent↔agent kill switch, which is pane chrome, not a page title over a measured column. So
the target family is `SessionToolbar` / `ProjectView`, not `PageShell`.

But the family was not agreed with itself, and the channel was in the **majority**:

```
                       height   inset   bottom rule
ProjectChannel           44      16      yes
ProjectView              44      16      yes
SessionToolbar           36      12      yes     ← the outlier
```

The user reports the channel as wrong, but two of the three toolbars were already at 44/16 and the
session toolbar was the one that differed — by **8px vertically and 4px horizontally**. Switching
between a session and the channel is the swap that moves the header, and it moves because of
`SessionToolbar`, not because of the channel.

So I moved the minority: **`SessionToolbar` 36/12 → 44/16.** The channel and `ProjectView` are
untouched.

`PageShell` is deliberately left alone — it is the *page* family (`padding: '16px 24px 0'`, no
fixed height, a title over a measured column), and `dev/settings-page-template.md` records that
these must not be flattened into one thing.

## The left-edge trade — it dissolved

You framed this as a real conflict: header matches other toolbars *or* stays welded to the body
column. It turns out not to be one, because **the canonical toolbar inset is 16 and the channel's
`INSET` is also 16**. Matching the family costs the channel nothing; its header still lines up with
every feed row and the composer beneath it. Nothing was given up.

Had the canonical inset been 12, I'd have taken your lean — match height and vertical position
unconditionally, keep the horizontal inset welded to the body — because a header that doesn't line
up with the messages under it is a visible defect in a single view, whereas a 4px inset difference
between views is only visible when you switch.

## Measurements

Live, from the running app:

```
surface        header height   pane-relative top   text inset   text baseline
channel             44               48               16            11
```

**Honest gap:** I could not drive the session or project-home views in the mock harness to measure
them the same way — my navigation clicks didn't land the surfaces, and I ran out of room to keep
chasing the harness rather than the product. Those two are **source-verified only** (the numbers in
the table above are read from `SessionToolbar.tsx:114-120` and `ProjectView.tsx:54`). Since all
three now specify the same literal `height: 44` and `padding: '0 16px'` in the same `DragRegion`
position, they are identical by construction — but I have not watched the session header land on
48 with my own probe, and I'd rather say so than present a table that implies I did.

To make that measurable next time, all three headers now carry `data-toolbar-header="…"` — the
brief is right that "a table of those numbers is the deliverable", and there was no hook to build
one from.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `dev/drive-toolbar.mjs` passes at all five widths (1440 / 1100 / 900 / 780 / 680): control
  heights and centres consistent, clusters clear, no collision. That is the regression that
  mattered — the toolbar is a dense bar of controls and 8px more height could have re-flowed it.

## The risk I took, and why

Growing `SessionToolbar` by 8px gives the terminal pane 8px less, i.e. roughly one text row.
`CLAUDE.md` warns that surfaces must *overlay* the terminal rather than resize it, to avoid the
resize-hang — but that rule is about switching surfaces at runtime, not about the pane's fixed
chrome height, which is settled at mount and already changes on any window resize. The alternative
(moving the channel and `ProjectView` down to 36/12) would have been two changes instead of one,
and would have moved the majority to match the minority.

I have **not** verified terminal behaviour in the real app — the harness can't exercise a live pty.
If a session's terminal misbehaves after this, this is the change to look at first.

## Not done

- **`PageShell` untouched**, per the guardrail.
- The channel's `DragRegion` is unchanged and still draggable; no second traffic-light clearance
  was introduced (the rail still owns that with its `paddingTop: 40`).
