# Brief — the channel's layout target is Codex. This supersedes the digest brief's layout half.

User: **"i think codex is a good example of layout we're aiming for"**, with a screenshot — then,
clarifying scope: **"i don't want to drop avatars, just an overall overview of the layout, button
placement, message box, etc."**

**So this is a reference for ARRANGEMENT, not a component-by-component copy.** What to take from it:
where things sit, how the window divides, where controls live, what the message box is shaped like.
What NOT to take: its typography, its identity model, or any of its specific components.

**Avatars stay. That is settled, not open** — see the deferred section below; ignore anything that
reads as an invitation to revisit it.

**Read this together with `channel-digest.md`.** The digest idea survives; where the two disagree
on layout, this wins. `channel-digest.md`'s composer section also stands.

## What the reference actually does

Three columns: a narrow thread sidebar, a **centre conversation column**, and a **right detail
pane** showing the artifact under discussion (a file, a diff, code).

1. **The conversation column is NARROW** — roughly 70–80 characters, generous line-height. It is
   not full-bleed and does not grow with the window.
2. **The recovered width becomes a second pane, not longer lines.**
3. **Low-information events are muted one-liners**: `Ran 5 commands, edited 1 file`,
   `Ran 6 commands · 6 errors`. Grey, compact, not prose blocks.
4. **Structured state is a collapsible inline card**: `2 active child threads` listing them;
   `Uncommitted · 25 files, +3,104 −116`.
5. **No avatars and no repeated author names.** It reads as a document.
6. **The composer is docked in the conversation column**, with a contextual status bar beneath it
   (folder, worktree, branch, model).

## The correction this forces, and I want it stated in the code

`PROSE = 900` (~151 chars) was **my call and it was wrong**. The user asked why text couldn't be
wider; I widened the measure when the actual defect was that the space beside it was empty. The
reference resolves it: **narrow measure, second pane.**

Bring the prose measure back toward a readable band. You measured 470px ≈ 79 chars, which is the
right neighbourhood. **Leave a comment recording that this went 470 → 900 → back**, and why — a
constant that has oscillated will oscillate again unless the reasoning is written at the site.

`ROW_MAX` and `COMPOSER_MAX = ROW_MAX` follow from `PROSE`, so they come back with it. Re-check the
things that were tuned against the wide value: the hover action's position, the 4-line clamp
(a median dispatch is 173 chars, so at 79 chars/line it is ~2–3 lines and may not need folding at
all), and the composer's proportions.

## Button placement — the part the user named, and we have no rule for it

The reference puts controls in consistent, predictable places: window-level actions top-right,
per-message actions inline on hover, composer controls on a row *inside* the box, and a contextual
status bar along the bottom.

**We have no such rule**, and it shows. Today the channel's kill switch rides the pane's far right
because it is "titlebar chrome"; the sidebar toggle was just added to three toolbar headers; the
composer's Send sits beside the target; hover actions sit at `ROW_MAX`. Each was decided on its own
and they were all defensible individually.

Write the rule down and apply it: **which zone owns which kind of control** — pane chrome, view
chrome, per-message actions, composer actions — and put each existing control where the rule says.
If a control has to move, move it. If the rule says today's placement is already right, say that
too; the deliverable is the rule plus an audit, not necessarily a change.

## What to build now, and what to defer

**Now:**

- The narrow conversation column, with the pane's remaining width **deliberately empty** rather
  than filled by prose. Empty is honest and is the correct intermediate state.
- The digest one-liner from `channel-digest.md`.
- **Muted activity lines** as a distinct row type, if the feed has anything that qualifies. We may
  not — our entries are dispatches and reports, both of which carry real content. If nothing
  qualifies, say so rather than inventing a category.
- **Collapsible inline cards** where we already have structured state to show. Real candidates:
  a fan-out dispatch (already collapses to `delivered 4/6 · 2 queued` — that is this pattern in
  miniature), and queued tasks per lane. Use the existing data; do not invent new state.

**Defer, and say so in the result:**

- The **right detail pane**. It is the biggest piece and it collides with the existing Plan/Diff
  panel, which already occupies that side. Whether the channel gets its own detail pane or reuses
  that one is a real architecture question and deserves its own brief. Do not start it.
- **Dropping avatars — NOT DEFERRED, REJECTED.** The user ruled on this directly. Codex can omit
  author identity because it is one agent talking; ours is genuinely multi-author, and the
  colour-coded author is load-bearing — it is the whole reason the UUID bug mattered. Keep them.

## Constraints

- Keep: local timestamps, `parseInline`, day separators, the 4px rhythm step, the shared left
  edge, the toolbar header at 44/16, the opaque `PopMenu`, `⌘↵`.
- Composer per `channel-digest.md` (single line, target as prefix, no grey fill, softened focus
  ring). The status-bar idea from the reference is interesting but **out of scope** — note it if
  you think it's worth a brief.
- No colour-changing border on a radiused element; no browser focus rings; no stacked opacity.

## Verify

- Chars per line at the three pane widths — it should now be stable, not growing.
- Entries per screen, against both the pre-digest and the wide-prose baselines.
- What the empty right-hand space looks like at 1812px. If it reads as broken rather than as
  reserved, say so — that is the argument for prioritising the detail pane.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs`.

## Where to work

`main` is at `573deaa`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-codex-layout-RESULT.md`: the measure you landed on and the comment you left
about its history, which reference behaviours you adopted vs deferred, what the empty right side
looks like, and your position on avatars. Then one OPERATOR-REPLY line.
