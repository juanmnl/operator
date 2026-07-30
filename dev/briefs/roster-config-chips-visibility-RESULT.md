# Lane config chips — one control family

Answers `dev/briefs/roster-config-chips-visibility.md`, including the AMENDED worktree scope.

New file: **`src/renderer/components/Segmented.tsx`** — one shared control, used by
`RosterPanel` (model, effort, worktree) and `AgentDefaultsView` (model, effort, worktree).

---

## The form I chose

**A true segmented control with a resting track, one selected language everywhere, and origin on
its own channel.**

```
              WHICH ONE IS CHOSEN          WHERE IT CAME FROM
before   model row: weight + brightness    fused into the same channel — the
         effort row: tinted pill           selected treatment WAS the origin signal
         worktree:  9px box, border-style
after    the CHIP (tinted wash), always,   the RING (hairline inset), only when
         in every row, at every origin     the value is pinned here
```

Two channels that were fused are now separate, which is the whole brief in one line. Finding 1
(two rows disagreeing) and finding 4 (the distinction unreadable *as* a distinction) were the same
bug seen from two sides: the model row looked different from the effort row **because** one was
inherited and the other pinned.

**The ring marks the exception, not the norm.** Most lanes inherit most settings, and once the
worktree default flips on for four of six lanes, inherited becomes the common case outright —
so decorating *inherited* would put a marker on nearly every control and mark nothing. Designed
for the post-change world, per the brief, not for today's screenshot.

A `box-shadow` ring rather than a border: colour-changing borders on radiused elements
re-rasterize in WKWebView. Same dodge as `ProjectTile`'s "you are here" ring. Inset, so it can
never overflow the track.

### Rejected

- **Keeping the flat row and moving origin to a dot or an underline.** The dot solves finding 4
  but not finding 3 — the rows still wouldn't read as interactive, which is the complaint the
  user actually led with.
- **A hairline box around each row.** A bordered box inside a card inside a list is the nesting a
  previous pass removed for good reason. A filled *track* adds the affordance back without adding
  another edge.
- **Dropping the origin signal entirely** (the brief offers this as legitimate). It survives
  because it is cheap once it has its own channel — one ring, no extra width, no extra row.
- **A label on every roster row.** `MODEL Fable Opus Sonnet Haiku` would push the card past its
  355px. Model names identify themselves; `worktree On/Off` does not, so that one keeps its label.

### The worktree control specifically

It is now the *same* control: `WORKTREE [On][Off]`. The 9px tri-state box is gone.

That answers all four of the amendment's sub-points at once — there is no dashed-vs-solid 1px
edge to perceive, inherited-on and pinned-on are now the same drawing (chip on `On`) differing
only by the ring, it no longer looks like a checkbox because it isn't one, and it stops being a
third dialect. The third state didn't need a drawing: **"inherited" is the absence of the pin
ring**, exactly as on model and effort. Clicking the lit option clears back to inherit — the same
gesture as the other two rows, learned once.

## Contrast, before → after

The brief's regression line was 4.45:1 on Mr Pink light for the unselected option.

```
                          mc·D   mc·L   pink·D pink·L 84·D   84·L
roster · unselected  before 7.50   5.22   6.40   4.97   7.14   5.79
                     after  8.38   7.05   6.95   6.66   7.93   7.79
roster · inherited   before 13.09  11.59  10.64  10.95  12.32  12.12
                     after   5.92   6.56   4.84   6.23   5.60   6.87
roster · pinned      before  4.93   5.58   3.82   5.34   4.62   5.68
                     after   5.92   6.56   4.84   6.23   5.60   6.87
```

**Contrast was never what was failing.** At 72% the unselected ink already measured 4.97–7.50,
i.e. it cleared the 4.5 bar on every palette — the user could read the words and still couldn't
tell the row was a control. That is the evidence for "change the channel" over "go further", and
the track is the change. I raised it to 85% anyway (6.66–8.38), which the new arrangement *allows*:
with the chip carrying selection, the unselected labels no longer have to stay dim to keep the
selected one legible. The two channels stopped competing, so both went up.

`inherited` drops because it is no longer plain `--fg` — it is now the same accent-tinted chip as
`pinned`, which is the point. **I regressed it first and the sweep caught it:** at full
`laneTextColor` on a wash on a track it measured 3.15 (Mr Pink dark) and 3.77 (1984 dark), under
the 4.5 floor a selected option is held to — `BELOW FLOOR: 3`. Mixing the chip's *text* 50% toward
`--fg` (the wash and ring keep the raw tint, where no text can fail a floor) brings it to
4.84–6.87. Same trick and roughly the same ratio as the channel's `ACCENT_INK`.

Final sweep: **`BELOW FLOOR (4.5 body / 3 meta): 0`** across all six palettes.

## Other homes

- **`AgentDefaultsView`** — brought in. It carried its own near-identical `Picker` plus its own
  `CONTROL_OFF` *and* its own 9px worktree box, so the app was already answering this question in
  three dialects before the roster's amendment made it four. Both are deleted; it now imports the
  shared control. Its `chosen` maps to `pinned` — the same concept one layer up the cascade. Its
  numbers improved too (`chosen` 4.67→6.91 worst-case-dark, `other option` unchanged at 6.97+).
- **`ChatComposer`** — deliberately **not** converted. It is a `PopMenu`, a dropdown for switching
  a live session's model, with an "Other…" free-text row for arbitrary model ids. It is a menu,
  not a picker-in-place; there is no room for four inline chips above a composer, and a segmented
  control cannot hold an unbounded id space. Its "active item in a list" convention is internally
  consistent.
- **`AgentLibraryView`** — also not converted, same reason in a different shape: a native
  `<select>` in a full-page form, with descriptive labels (`Haiku — fast & cheap`) and a
  free-typed custom value. A form field, not a compact picker.

The line I drew: **inline, bounded, few options → the shared `Segmented`. Unbounded or
descriptive → a menu or a field.**

## Verified

- `npm run build` clean. `npm test` **429/429** (`roster.test.ts` / `model-config.test.ts` both
  pass — no logic changed, only rendering; `nextWorktreeState` is now unused by the view but left
  in `model-config.ts`, which Code owns).
- `node dev/drive-theme-pass.mjs`, all 6 palettes, **BELOW FLOOR: 0**. Its roster/defaults probes
  needed re-pointing: `[data-default-state]` and `[data-worktree-toggle]` no longer exist, and
  both views now expose the same `[data-segmented]` / `[data-segment-state]` hooks — which is
  itself a small proof that the two surfaces really are one control now.
- Eyeballed dark and light at 3–6× with **both origin states on screen at once** (a pinned model on
  Operator, inherited on Research), per the brief: `/tmp/operator-shots/roster-final.png`,
  `seg-{pinned,inherited}-{dark,light}.png`.
- No values touched — `model-config.ts` and the worktree migration stay Code's.

**Port note:** 1433 is serving a Python `http.server` directory listing of an empty folder, not
the app, so nothing could be eyeballed there. Used 1436, this session's assigned port; did not
bind 1433.

## Left alone

- **`nextWorktreeState`** in `model-config.ts` is now dead as far as this view is concerned. Code
  owns that file and the migration is in flight, so I did not delete it.
- **The `View →` / `Launch →` button** keeps its bordered container while the pickers use filled
  tracks. Two container styles on one card, but they are different things — an action versus a
  choice — and collapsing them would make the primary action look like a fourth option.
- **The card grew ~8px taller** (166 → 174) because the worktree control is now a labelled track
  rather than a 9px box on the same line. Accepted: it buys the whole unification.
