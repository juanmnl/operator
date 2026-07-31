# Brief — list-and-detail is the pattern. Extract it, and make the channel's right panel tabbed.

> **REWRITTEN 2026-07-31, before Design started it.** The earlier version asked for a right panel
> holding the moodboard and project context. That still happens — but the user has since pointed at
> the **Subagent library** and said *"the subagent view is the layout i'd want everywhere"*, which
> changes the shape. Discard the earlier framing.

## What the user is pointing at

`AgentLibraryView`'s split: a **240px index column** (`:169`, `borderRight`, its own scroller) and a
**detail pane** that says *"Select an agent to edit, or create one"* until something is picked.

This is now the **third independent signal for the same pattern** — Codex's conversation-plus-detail,
the PR tool's list-plus-context, and the user's own Subagent library. It is the house layout; it
just isn't extracted.

## Part 1 — extract the pattern

`PageShell` already knows about it: its `fullBleed` note says *"required by a split pane like the
agent library, whose two columns each scroll independently"*. But the split itself is hand-rolled
inside `AgentLibraryView`.

Extract it — index column + detail pane, each scrolling independently, with an empty-detail state.
`AgentLibraryView` becomes its first consumer and must look and behave **exactly** as it does now;
that is the regression bar.

Decide and state: the index column's width rule (240 is the current literal), whether it resizes,
and what the empty state's API is.

## Part 2 — the channel, and the conflict this creates

Two of the user's requests now compete for the same space:

- *"channel needs a right panel, maybe the moodboard and other global project-wide info"*
- *"the subagent view is the layout i'd want everywhere"* — index + detail

Naively that is **index + detail + right panel** — three columns beside the sidebar and the rail.
Too many. Don't build that.

**The resolution I want you to take, unless you can beat it:** the detail pane *is* the right panel,
and it is **tabbed**. That is exactly the PR-tool reference already recorded in
`dev/design-references.md` (`Info · Changes · Terminal · Agents`), and it collapses the conflict
instead of splitting the difference.

```
CONTENT                        RIGHT PANEL (shell slot, tabbed)
digest rows = the index        [ Message ]  the selected entry, in full
                               [ Project ]  moodboard + contextNotes
```

- Selecting a digest row fills the **Message** tab. Nothing selected → the panel rests on
  **Project**, so the panel is never empty and the moodboard is what you see by default.
- The digest row keeps its own expand-in-place — the panel is for reading one thing properly, not
  a replacement for the fold.
- **Reuse `MoodboardPanel`.** It exists, its images live on disk via `moodboardAdd`/`moodboardList`,
  and it is currently reached from `ProjectView`. Two entry points is fine; two implementations is
  not.

## Constraints

- Shell slot geometry and collapse behaviour, unchanged — that is what phase 1 built.
- ⚠️ **The moodboard sits beside a live feed.** The reading-panel freeze
  (`project_chat_markdown_freeze`) came from re-parsing on every `session:update`, and this panel
  will be mounted while messages arrive. **Do not re-render or re-decode images per channel
  update** — memoise, and report the measurement rather than an assurance.
- Empty states: no images, no notes, nothing selected. Most projects have all three today, so this
  is the common case, not an edge.
- Transparent badges, no solid accent fills, no browser focus rings, no stacked opacity, no
  colour-changing border on a radiused element. All six palettes.

## Verify

- `AgentLibraryView` is pixel-identical to before the extraction — that is the proof the pattern
  came out clean.
- The channel with a selection and without; with and without moodboard images and notes.
- **Measure that the panel does not re-render when a channel message arrives.**
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs`.

## Where to work

`main` is at `32616ea`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-right-panel-RESULT.md`: the extracted pattern's API, proof `AgentLibraryView`
is unchanged, the tab model, what you put in Project and what you left out, the empty states, and
the re-render measurement. Then one OPERATOR-REPLY line.
