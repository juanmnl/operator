# Agents hub — active only

Answers `dev/briefs/agents-hub-active-only.md`.

---

## What counts as active

Two things, and the second is the interesting one:

1. **A launched, non-ended session** — the view's existing `live` definition, reused rather than a
   second notion invented beside it.
2. **An idle lane with tasks queued against it.**

**I took your lean on queued lanes, and I think it's clearly right.** "Nothing is running but four
lanes are backed up" is precisely the state a fleet view exists to surface, and it is the most
actionable thing this surface can show. The rule is exact: an idle lane appears **if and only if**
work is queued against it — never as a bench.

Measured across the three states:

```
                       cards   live   queued badges   empty state
several running          5       4          2            no
nothing running,         2       0          2            no      ← 0 IN PLAY · 3 TASKS WAITING
  work queued
nothing at all           0       0          0            YES
```

## The chips

None of them counted idle lanes any more (that was fixed in the character-card pass), so they
mostly survive — but two now mean something different:

- **`N in play`** — unchanged, and now the headline number of the view rather than one of three.
- **`N tasks waiting … across N agents`** — unchanged, and it now has cards to point at.
- **`N teams`** — now counts only projects that *appear*, i.e. those with something running or
  queued. It read `13 projects` when the view listed every project; it reads `1 team` when one
  project has work.

A project with nothing running and nothing queued does not render at all — no empty group.

## The empty state

It is the **resting** state now, not an edge case, so it says what the surface is and where lanes
actually live:

> **Nothing is running.**
> This is every agent at work across your projects, and anything with tasks queued against it.
> Your teams and their idle lanes live on each project's roster — open a project and launch one
> from there.

Left-aligned in a 460px measure rather than centred: it is prose to read, not a placeholder to
look past, and centring it would have been the third alignment on a page that is otherwise
left-anchored.

## The animating-orbs question

You asked me to check rather than assume, so: **the count of moving things went down, not up.**

With the bench removed the view is much smaller — in the fixture it went from every lane across
every project to 5 cards, of which 4 animate. Four moving orbs is not a wall. What changed is the
*proportion*: previously most orbs were static idle ones, so motion was the exception; now it is
the norm.

I did nothing to damp it, deliberately, and the queued-lane decision is why that's safe: a
queued-but-idle card is **static** (its orb is `idle`), so a screen with both has a genuine
contrast — motion means running, stillness means waiting. If motion were universal here it would
stop carrying information, and that would be worth damping. It isn't, because of the exception.

The motion rule itself is untouched: only `running`/`compacting` animate, straight out of
`StatusWave`.

## Verified

- Three states driven: several running, queued-only, and none. Screenshots at
  `/tmp/operator-shots/hub-{many,queuedOnly,none}.png`.
- **Roster board and sidebar unchanged** — this touched `AgentsHubView` and the rail button's
  tooltip only. Idle lanes are still fully visible where you launch them.
- The rail's tooltip was `every agent across your projects`, which stopped being true. Now
  `what is running across your projects`. The page subtitle changed with it.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**; the agent-card probes are
  unchanged (live name 5.43–7.16, idle name 6.65–8.20, loadout 3.73–5.89, queued badge 4.76–10.06).
- `npm run build` clean. `npm test` **562/562**.

## Kept

The character-card anatomy is untouched — identity row, loadout line, live phase + task, queued
badge, shape vocabulary, no group opacity. This changed *which* cards the view contains, not what a
card is.

## Not done

I did not lean the card harder into live state, which you left open as a possibility now that it
never represents a bench. It still renders the same anatomy for both card kinds, because the queued
exception means it *does* still represent something that isn't running — a card that assumed
liveness would have no way to draw those two.
