# Brief — the channel header doesn't sit where every other view's header sits

User: **"channel header is not in the same position as all the other views headers."**

Switching between the channel and any other surface moves the header, so the frame shifts under a
user who only changed what's inside it.

## What I could establish from the source — and it's inconsistent

```
CHANNEL         ProjectChannel.tsx     height: 44, padding: '0 16px'   (baseline-aligned row)
PageShell       settings/PageShell     padding: '16px 24px 0'          (no fixed height)
SessionToolbar  SessionToolbar.tsx     padding: '0 12px'
```

Three surfaces, three different horizontal insets (16 / 24 / 12) and two different vertical
models (a fixed 44px row vs top padding). **I could not determine from the code which of these is
the intended standard**, which is itself the finding: there is no single header position, so
"align the channel to the others" has no unambiguous target yet.

Establish the canonical one and move the channel to it. If that means touching more than the
channel, say what and why — but see the guardrail below before you do.

## The guardrail — do not flatten these into one thing

There is a recorded decision (`dev/settings-page-template.md`) that **`ProjectView` and
`ProjectGallery` are TOOLBAR headers and must NOT be converted to the page-title treatment.** So
there are legitimately (at least) two header families:

- **Page headers** — a title and description over a measured column. `PageShell`'s job.
- **Toolbar headers** — a compact bar of controls at the top of a working surface.

**The channel is a toolbar header**, not a page header: it carries `#` + name + the agent↔agent
kill switch, which is pane chrome. So the target to match is the *toolbar* family —
`SessionToolbar` and `ProjectView` — not `PageShell`. Confirm that read before acting on it; if
you conclude the channel is actually a page header, argue it, because that changes the answer.

What must be true when you're done: **switching between the channel and the surfaces it swaps with
must not move the header.** That's the user-visible property, and it's the acceptance test.

## Watch the left edge

The channel's header inset is `INSET = 16`, and that constant is deliberately **shared with every
feed row and the composer** — the shared left edge from the layout pass, measured at three widths.
If the canonical toolbar inset turns out to be 12 or 24, decide carefully whether the channel's
header follows the toolbar family or stays welded to its own body column. Both are defensible and
they conflict:

- header matches other toolbars → consistent across views, but the header no longer lines up with
  the messages beneath it;
- header stays at 16 → the pane reads as one column, but it disagrees with the neighbouring views.

**Pick one, state the trade, and say what you gave up.** My lean is that the vertical position and
height must match the toolbar family unconditionally — that's what the user is seeing — while the
horizontal inset is the one that may legitimately stay welded to the body. But it's your call.

## Constraints

- Traffic lights: the rail hosts them now (`paddingTop: 40`). Don't reintroduce a second clearance.
- The header is a `DragRegion` — it must stay draggable.
- Don't disturb the shared 16px left edge of the feed rows and composer without saying so.
- No colour-changing border on a radiused element; no browser focus rings.

## Verify

- **Measure the header's height and its title's baseline offset in the channel and in every surface
  it swaps with**, before and after. A table of those numbers is the deliverable — "looks aligned"
  is what got us here.
- Switch between surfaces and confirm nothing in the header moves.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `fed6f31`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-header-alignment-RESULT.md`: which family the channel belongs to and why, the
canonical numbers you established, the before/after measurement table, and the left-edge trade you
chose. Then one OPERATOR-REPLY line.
