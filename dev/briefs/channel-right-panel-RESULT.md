# List-and-detail extracted; the channel's panel is tabbed

Answers the rewritten `dev/briefs/channel-right-panel.md`.

---

## Part 1 — the pattern, extracted

**`src/renderer/components/SplitPane.tsx`**

```tsx
<SplitPane
  index={…}          // the list column — its own scroller
  detail={…}         // undefined/null falls through to `empty`
  empty={…}          // required, not optional
  indexWidth={240}   // default
/>
```

Decisions you asked me to state:

- **Width: a fixed 240, and it does not resize.** That is the literal `AgentLibraryView` has always
  used. A draggable divider is state to persist, a hit target to place, and a second thing that can
  disagree between two consumers — worth adding when something asks for it, not before.
- **`empty` is required, not optional.** A detail pane with nothing in it should say what to do; an
  optional prop invites a blank column.
- The two scrollers stay independent, and the component keeps the note about why an ancestor must
  not cap the width: a capped ancestor parks both scrollbars at its edge rather than the window's.

**`AgentLibraryView` is unchanged** — measured rather than eyeballed:

```
index column   240px · overflow: auto · border-right 1px · padding 12px 10px
empty state    "Select an agent to edit, or create one."   present
with selection editor renders, empty state gone
```

Same DOM, same styles, same literals — the extraction moved the markup without retuning it.

## Part 2 — the channel's panel, tabbed

I took your resolution rather than trying to beat it: **the detail pane IS the right panel, and it
carries tabs.** Three columns beside the rail and sidebar would have been too many, and tabs
collapse the conflict instead of splitting the difference.

```
CONTENT                         RIGHT PANEL (shell slot, 340px)
digest rows = the INDEX         [ Message ]  the selected entry, in full
                                [ Project ]  contextNotes + moodboard
```

- **Rests on Project** with nothing selected, so the panel is never empty and the moodboard is the
  default view. Message is *disabled* until there is a selection rather than showing a blank tab.
- **Selecting a row switches to Message.** I shipped this wrong first — the selection landed in a
  tab you weren't looking at, which reads as the click doing nothing. Keyed on the entry id so it
  fires per selection and returning to a row you had open still brings the tab forward.
- **The digest row keeps its own expand-in-place.** The panel is for reading one thing properly,
  not a replacement for the fold — both work.
- **Row clicks ignore interactive descendants.** The row is an index entry but it *contains* Show
  more, copy, Approve and Decline; selecting on any click would fire when someone folds a body open.

**`MoodboardPanel` is reused, not reimplemented** — it already owns the on-disk store via
`moodboardAdd`/`moodboardList` and is also reached from `ProjectView`. Two entry points is fine;
two implementations is not. Its own empty state covers "no images".

**What went in Project:** the project's `contextNotes` (with an empty state pointing at the card's
⋯ menu, since that is where they are edited) and the moodboard. **What I left out:** everything
that is per-session — this panel is about the project, which is the distinction that made the slot
per-mode in phase 1.

## The re-render measurement

You asked for the measurement rather than an assurance, because this panel is mounted beside a live
feed and the reading-panel freeze came from re-parsing on every `session:update`.

Method: tag every node inside `[data-channel-panel]`, fire six channel phase updates, count how
many tagged nodes survive. A React re-render replaces them.

```
17 nodes marked → 17 survived 6 channel updates → PANEL DID NOT RE-RENDER
```

`ChannelPanel` is wrapped in `memo`, and its props are the project, the resolved selection and a
callback — none of which change when a message arrives. So the moodboard does not re-decode its
images and the selected entry is not re-tokenised.

## Empty states

- **Nothing selected** → Message disabled, panel rests on Project.
- **No notes** → "No description yet. Add one from the project card's ⋯ menu."
- **No images** → `MoodboardPanel`'s own empty state, unchanged.

All three are the common case today, as you said, not edges.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**.
- `drive-project-channel.mjs` — all 33 assertions.
- `AgentLibraryView` measured identical, before/after.

## Not done

- **The panel does not collapse.** The shell's slot geometry is unchanged from phase 1, which is
  what you asked for, but the session's panel has a toggle and the channel's does not — it is always
  340px. That is a real inconsistency between two users of the same slot, and the honest place to
  fix it is the shell (a slot-level collapse), not a second toggle in the channel. Worth a small
  brief.
- **`SplitPane` has one consumer.** The channel's index is the feed itself, not a 240px column, so
  it uses the shell slot rather than `SplitPane`. The extraction is still right — it is the house
  pattern with three independent signals behind it — but it is currently proven by one caller, and
  a second will likely reshape the API.
