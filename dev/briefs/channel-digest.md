# Brief — the channel becomes a digest, and the composer becomes one line

User reviewed four redesign directions and chose **C (digest)** and **composer 2 (single line)**.
Direction **A (work items)** follows afterwards, so don't foreclose it.

## The measurement that drives this

Re-counted from the real store, and it changes the diagnosis:

```
dispatches in this project   100
  median   173 chars   (~2 lines)
  p90      231
  max     1253
outcomes   90% `sent`
```

**A dispatch is short. It was the REPLIES that ran 500–1300 characters.** The feed is bimodal —
short asks alternating with long reports — and every pass so far has treated it as uniform, which
is why widening the prose measure couldn't fix comprehension. A digest exploits the asymmetry:
most rows are already one line's worth of content and are being drawn as blocks.

## C · The digest

**Every entry renders as one line by default**: author, a one-sentence summary, time. Expanding
shows the full body in place. Nothing is hidden and nothing is truncated away — it's a fold, not a
summary that replaces content.

Yours to decide, and these are the decisions that make or break it:

- **Where the summary comes from.** My intent is the message's own first line or first sentence,
  used verbatim — not generated, not re-written at render time. Say what you chose and what
  happens when the first line is 400 characters (most likely: clamp to one line with an ellipsis
  and expand for the rest).
- **Dispatch vs reply at one line.** These are different acts — a request and a report — and at
  full height the `→ target` carried it. At one line there's less room. Make the distinction
  survive; it's the main thing a reader is parsing.
- **What stays on the row**: the chip is the other load-bearing element (`held`, `queued`,
  `sent · never started`). An actionable state must not be the thing that gets dropped for space.
- **Expansion state.** Does it persist as you scroll away and back? Does a new message collapse
  others? My lean: expansion is sticky per entry and nothing auto-collapses — surprise collapsing
  is worse than a long page.
- **Density target.** The mock suggested ~12 entries per screen. Report what you actually get.

**Keep** the author colour and initials, `parseInline`, local timestamps, the day separators, the
4px rhythm, the full-bleed rows and shared left edge. The clamp (`CLAMP_LINES = 4`) is likely
superseded — say what happened to it.

**Don't foreclose A.** The next step pairs a dispatch with the reply it produced, using `replyId`.
A digest row is a good host for that (a pair collapses to one line with its outcome), so avoid
choices that make nesting impossible later.

## Composer 2 · single line

One row until a draft needs two, growing from there. The target reads as a **prefix** — you are
writing *to everyone* — rather than as a separate labelled control, which removes a control. The
chord replaces the Send button until there is a draft.

- **Drop the grey fill.** `--overlay-subtle` on a light page reads as *disabled*, and this
  composer has a real disabled state that currently looks the same. Resting, focused and disabled
  must be three distinguishable things — check them side by side rather than reasoning about it.
- **Tone down the focus ring.** It is raw `var(--accent)` inset; this same file defines
  `ACCENT_INK` as `color-mix(--accent 55%, --fg)` precisely because raw accent is wrong on the
  light palettes. Focus should read as attention, not as an error. Keep it a `box-shadow` — a
  colour-changing border on a radiused element is the WKWebView trap.
- Keep: ⌘↵, the character cap and its warning, the disabled state when `onSend` is absent, the
  shared left edge, `COMPOSER_MAX = ROW_MAX`, and the `PopMenu` dismissal fix you're landing now.

## What I'm changing on my side

The digest is only as good as the first line of each message, and most of those are mine. I'm
changing how I write dispatches and asking lanes to lead with a one-sentence result. **You don't
need to build anything for that** — just don't design around the assumption that first lines are
currently good, because today's are not.

## Verify

- Entries per screen at the default pane height, before and after.
- A message whose first line is very long; one that is a single short line; one with code spans.
- Dispatch and reply side by side at one line — is the difference legible?
- All six palettes for the composer's three states.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `573deaa`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-digest-RESULT.md`: where the summary comes from, how dispatch vs reply reads
at one line, what happened to the clamp, expansion behaviour, density before/after, and the
composer's three states. Then one OPERATOR-REPLY line.
