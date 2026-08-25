# Stuck rail hover cards

**Branch:** `operator/a30080` · 2026-08-24 · Code lane
**Evidence:** `/tmp/operator-shots/rail-hover-cards-stuck-2026-08-24.png` — seven cards open at
once down the left rail: two project headers (`Operator-landing`, `mantel`) and five lane orbs.

## What was actually wrong

The brief's diagnosis — "every orb/project row owns its own hover-card state, closed only by its
own `onMouseLeave`" — is right about the *shape* and worth one correction about the *code*: all
three call sites (`SessionItem`, the rail's project headers, the rail's orbs) already went
through a shared `useHoverCard`, and that hook already claimed the guarantee in its own header:

> **AT MOST ONE CARD EXISTS APP-WIDE.** Two at once is a state no correct implementation should
> permit, so a new card evicts the previous holder rather than every dismissal path having to fire.

The screenshot is what that guarantee was worth. It could not hold, and the reason is structural
rather than a missing event: the state still lived **in each row**, and the module-level owner slot
held only a *closure back into whoever was holding it*. Any path that left a row's `hovered` state
true without going through that closure — a remount under the cursor, a re-render that recreated
the row, a module re-evaluation — stranded a card that nothing afterwards could reach, because the
only handle on it had been replaced.

Adding more close events to that shape would not have fixed it. A stranded card had no listeners
of its own left to fire.

## The fix

**The state moved out of the rows.** `lib/hover-card-machine.ts` is a pure reducer over

```ts
{ openFor: string | null, pendingFor: string | null, pendingSince: number | null }
```

and `lib/use-hover-card.ts` is one module-level store over it, read by rows through
`useSyncExternalStore`. **At most one card is no longer a lock that can be defeated; it is the
shape of the data** — a row renders a card iff it is `openFor`, so a second one has nowhere to
exist. The call sites did not change: the hook keeps its old surface.

**The rest delay.** A card opens only after the pointer has rested `HOVER_REST_MS` (150ms). The
old behaviour opened one card per orb *passed over*, which is both the noise and the condition
that produced a pile — flicking down a column of orbs now shows nothing.

**Every close path is one transition.** A card that closes on six events and not the seventh is
how this survived its first fix, so the reducer has exactly one `close`, and the hook wires all of
these to it:

| | |
|---|---|
| `pointerleave` on the rail | catches leaving sideways into the content card faster than a row sees its own leave |
| `window` `blur` / `resize` | ⌘Tab, focus loss, window changes |
| `document` `visibilitychange` | app switches where no mouse event arrives at all |
| `document` `mouseout` with null `relatedTarget` | the reliable "pointer left the document" signal |
| `documentElement` `mouseleave` | the same thing, for engines that prefer it |
| `scroll`, **capture** | the sidebar scroller does not bubble, and a scroll is exactly what moves a row out from under a cursor that never moved |
| any `keydown`, **capture** | someone typing is not reading a hover card |
| target unmount | the stranding the old owner-slot could not reach |

Listeners are installed **once at module scope**, not per hovered row — "close everything" is not
a per-row concern, and per-row listeners were themselves a way for a stranded card to end up with
none.

**A late `leave` is scoped.** A row the pointer has already left can deliver its `mouseleave`
after the next row opened; closing on it would flicker the card out from under the cursor. `leave`
names its target and is a no-op for anything else.

**The card's styling is untouched.** This file owns *when*, never *how*.

## Tests

18 unit tests over the reducer, including the sequences that used to produce the screenshot:

- flicking through five targets opens **none** of them;
- no sequence of enters and rests can ever open two (asserted by counting open ids after each of
  seven hovers, not by inspecting one field);
- entering a new target closes the open one **immediately**, not after the new rest — two cards
  must not coexist even for 150ms;
- a stale `rest` for an abandoned target is a no-op, which is what makes the timer safe to leave
  un-cancelled;
- a **late** `leave` from an abandoned row does not close the card that replaced it;
- `close` is identity when nothing is open, so a keystroke does not re-render the rail.

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `npm test` (root) | **902 passed / 33 failed** — the 33 unchanged, pre-existing jsdom-under-Node-26 |
| `vite build` | green |

## Not verified

Not seen in a real window — GUI verification is yours. The reducer is exercised directly and the
listener list is exhaustive on paper, but the two things only a real pointer can settle are:
whether 150ms feels right when you *do* want a card, and whether the `pointerleave` on the rail
fires before a fast sideways exit reaches the content card. Reproducing the original needs the
same conditions the screenshot caught — a busy rail re-rendering under a moving cursor.
