# Brief — the channel composer needs to be much better

User, on the merged build: **"this needs to be way better."** Screenshot is the composer: a `TO`
row of seven pills, then a textarea and a Send button as two separate bordered boxes.

Same reference as the feed pass: Slack / Mattermost.

## What's there now (`ProjectChannel.tsx`, `Composer`, ~`:780-885`)

1. **A permanent seven-pill radio bank.** `to` + `everyone` + one pill per roster lane, each a
   bordered 9px mono button, always visible, always taking a full row. Seven bordered elements is
   a lot of chrome for a choice most messages never change.
2. **Two boxes, not one.** The textarea carries its own border and the Send button carries another,
   sitting beside it under `alignItems: 'flex-end'`. Every reference app puts the input and its
   actions **inside one container** so the composer reads as a single surface.
3. **The shortcut is stated twice** — the placeholder ends "⌘↵ to send" *and* the button says
   "Send ⌘↵".
4. **`rows={2}` at rest**, for a surface whose typical message is one line.
5. **The feed is clipped hard against the composer's top edge** — in the screenshot a `Code … DELIVERED`
   row is sliced through the middle of its glyphs with nothing to mark the boundary. Whatever the
   fix (padding, a fade, a rule), the last message must not look severed.

## What I want

A composer that reads as **one surface**, where addressing is available without permanently
spending a row on it, and where the send affordance sits inside the container rather than beside
it.

Yours to decide, but decide deliberately:

- **How addressing works.** The seven pills are a radio group wearing chip clothing. Options worth
  weighing: a compact target control inside the container that opens the full list on demand;
  inline `@lane` addressing parsed from the text (closest to the reference apps, and it composes
  with the existing dispatch grammar); or keeping pills but only for a project's *actual* roster
  size — after the prune most projects have **one lane**, so this row is frequently `to · everyone ·
  Operator`, two pills to choose between. **Check what this looks like at one lane before designing
  for six.**
- **Where the count goes.** It currently rides the target row's right edge and only appears near
  the cap. Inside the container is the conventional home.
- **Resting height.** One row that grows, versus a fixed two.

Keep: ⌘↵ to send, the character cap and its warning state, the disabled/read-only state when
`onSend` is absent, and the composer's own `COMPOSER_MAX` width and shared left inset — that came
from the layout pass and is deliberate.

## Constraints

- Transparent badges; **no solid accent fills for state** — the existing selection treatment (faint
  surface tint plus normal ink) is right, keep that instinct for whatever replaces the pills.
- **No browser focus rings** — but the composer is the most keyboard-driven surface in the app, so
  every control needs a real, visible focus state of its own. This is where that rule most needs
  care, not least.
- No colour-CHANGING border on a radiused element (WKWebView re-rasterizes). A composer container
  that changes border colour on focus is exactly this trap — use a box-shadow ring instead.
- Never stack opacity on `--fg-muted`.
- The whole surface must work at the narrow pane width (Plan/Diff open) as well as wide.

## Verify

- Drive it at **one lane** and at **six** — the one-lane case is now the common one and the seven-pill
  design was never looked at there.
- Confirm the last feed row is never clipped against the composer.
- Keyboard: tab through every control and confirm each has a visible focus state; ⌘↵ still sends;
  the disabled state is still reachable-but-inert.
- `node dev/drive-theme-pass.mjs` — all six palettes.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `c3ca6fe`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-composer-RESULT.md`: the addressing mechanism you chose and what you rejected,
how the container is composed, what happened to the clipped feed edge, the one-lane and six-lane
screenshots, and the focus-state treatment. Then one OPERATOR-REPLY line.
