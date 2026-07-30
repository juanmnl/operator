# Review — the typewriter feed in `CanvasConversation.tsx`

**Date:** 2026-07-28 · **Reviewer:** Review lane
**Reviewed:** the 113-line feed change (108 insertions / 5 deletions).

**Status note:** it was uncommitted when dispatched and **landed mid-review** as
`77b3a53 "Chat: the transcript feeds upward instead of snapping"` (also adding
`dev/drive-chat-feed.mjs`). I verified `git diff 77b3a53 -- CanvasConversation.tsx` is empty —
**what I reviewed is exactly what landed**, so nothing below is stale. It does mean these are
follow-ups on a commit rather than gates on a working tree; the two P1s below are still worth
holding 0.10.1 for, since both are reachable by a single click.

**Method.** Reading, plus a measured harness: I mounted the real `CanvasConversation` in headless
WebKit (same engine family as WKWebView) against a fixture matched to the **largest real transcript
in `~/.operator/chat.db`** — 846 turns / 283k chars, which lays out to an **87,357px document** in a
553px viewport. I instrumented `CanvasRenderingContext2D` (one `clearRect` per paint, plus
`measureText`/`fillText` counts and time) and drove scroll, feed and streaming scenarios. The
instrument was removed afterwards so the tree is exactly as I found it; it is ~120 lines and I can
restore it on request.

---

## Verdict

**The design is sound and the hard parts are right.** The WebKit scroll-pinning workaround is real
and load-bearing, the rAF loop is the correct choice over `behavior: 'smooth'` for a virtualized
canvas, and the `animatingRef` guard is not defensive padding — I measured that it is doing exactly
the job the comment claims.

Against the three areas asked about:

- **Paint cost on a long transcript: not a problem.** Measured, not assumed — see §4. The viewport
  cull holds up on an 87k-px document.
- **Stick-threshold race: the machinery is correct.** I could not construct a race in it, and the
  measurements show why the guard is necessary. See §3.
- **User-scroll cancellation: this is where the bugs are.** The cancellation is too eager in one
  direction and has a dead end in another. Two P1s, both measured.

---

## 🔴 P1 — A plain click stops the feed following

`CanvasConversation.tsx:925` (`onPointerDown={onUserScroll}`).

`onUserScroll` releases stick outright (`stickRef.current = false; setAtEdge(false)`), and it is wired
to `onPointerDown` — which fires on **every click**, not just on a drag.

The same scroller already carries three click-driven affordances, all of which fire `pointerdown`
first:

- `onClick` at `:899` — open a link, **and toggle a collapsed thought open/closed**
- `onDoubleClick` at `:918` — copy a message
- any click at all, e.g. to bring focus to the panel

**Measured**, at the live edge with nothing else happening:

```
--- A PLAIN CLICK IN THE TRANSCRIPT (no scroll at all) ---
  distance to live edge before: 0px   after a turn lands: 106px
  FEED STOPPED FOLLOWING · jump-to-latest visible: true
```

So: click once anywhere in the transcript and the app silently stops following the conversation, and
the jump-to-latest control appears as if the user had scrolled away. They didn't.

The thought-toggle path is the worst of the three, because it compounds: the click releases stick,
*then* `setExpandedThoughts` triggers a relayout, and the layout effect at `:784` runs with
`stickRef.current` already false — so opening a thought at the live edge both stops the feed and
skips the re-feed that would have absorbed the height change.

The comment above these handlers says *"A wheel, a trackpad gesture, a drag or a key"* — a drag is
the intent, but `pointerdown` cannot distinguish a drag from a click. Cancelling on
`pointermove`-while-down, or on the scroll the drag actually produces, would separate them.

---

## 🔴 P1 — A wheel at the live edge detaches the feed permanently

`CanvasConversation.tsx:924` (`onWheel={onUserScroll}`) with `onScroll` at `:816` as the only path
back.

`onUserScroll` is unconditional, and the comment at `:804-808` explains the design: releasing stick
is deliberate, and *"onScroll re-engages stick by itself if they end up back at the live edge."*
That recovery depends on a scroll event actually firing. **At the scroll limit, it doesn't** — a
downward wheel when already at the bottom scrolls nothing, so no `scroll` event is dispatched and
nothing ever re-engages stick.

**Measured:**

```
--- WHEEL AT THE LIVE EDGE (over-scroll flick, nothing left to scroll) ---
  scroll events that followed the wheel: 0
  distance to live edge after a turn lands: 85px
  FEED STOPPED FOLLOWING and cannot re-engage without a real scroll
```

The trigger is an ordinary gesture: flicking downward to "get to the end" is exactly what people do
when they want to follow output. After it, every subsequent turn pushes the view further behind, and
the only way back is to scroll up and back down by hand, or to hit jump-to-latest.

The same dead end exists whenever the transcript is **shorter than the viewport** — `scrollHeight ===
clientHeight`, so no scroll event can ever fire, and one wheel gesture disables the feed for the rest
of that session's short life.

Cheapest correct fix: make the release conditional on the scroller actually being able to move away
from the edge — or re-engage stick in `onWheel` itself when the scroller is already at its maximum.

---

## 🟠 P2 — `firstPaintRef` and `lastMaxRef` are never reset, and the component is not keyed per session

`CanvasConversation.tsx:569-572`, `:784-801`; `DashboardView.tsx:2371` renders
`<CanvasConversation session={activeSession} … />` **with no `key`**, so the component persists across
session switches rather than remounting.

Both refs are per-component-lifetime, and neither is reset when `session?.id` changes:

- `firstPaintRef` — the trap-3 protection ("the first layout snaps"). It is set to `false` after the
  first layout and never set back, so **it only ever protects the first session viewed in an app
  run.** Every subsequent session switch skips it.
- `lastMaxRef` — the "previous document height" the rewind is measured against. On a session switch
  it still holds **the previous session's** max.

Failure scenario: switch from a short session to a longer one whose document exceeds the old one by
less than a viewport. The layout effect sees `max > prev`, rewinds `el.scrollTop` to the *old
session's* height, and animates from there — a scroll animation on a session the user just opened,
through content they have never seen. Larger deltas are caught by the `tooFar` snap guard, so this is
a band rather than a certainty, but the guard is catching it by accident: it is sized for "one
append", not for "a whole different transcript".

Both are one-liners: reset in an effect keyed on `session?.id`, or give the component a
`key={session.id}` at the call site.

---

## 🟠 P2 — `lastMaxRef` is only written inside the stick branch, so it goes stale

`CanvasConversation.tsx:787-790`:

```js
if (el && stickRef.current && !q && !savedOnly) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const prev = lastMaxRef.current
  lastMaxRef.current = max        // ← only ever written in here
```

The variable is named and used as "the max as of the previous append", but it is only updated while
sticking. Any period of *not* sticking — the user reading back, a search, saved-only mode — freezes
it. The jump-to-latest handler at `:972` re-arms stick and calls `feedTo` directly without updating
it either, so it can stay stale across a re-engage.

Consequence: the rewind at `:795` (`el.scrollTop = prev`) is measured against an arbitrarily old
height, so its distance is unbounded rather than "one append". Large deltas snap (invisible, since
the rewind and the snap happen in the same task with no intervening paint), but anything inside one
viewport **animates a slide through up to 553px of already-read content** — precisely the "sliding
through content nobody asked to see" the `tooFar` guard exists to prevent.

Moving the write above the `if` (or into `onScroll`) makes the name true again.

---

## 🟡 P3 — `onKeyDown={onUserScroll}` is dead code, and the comment claims otherwise

`CanvasConversation.tsx:927`. The scroller has **no `tabIndex`** (I grepped the file — there is none)
and contains no focusable children: its only children are the spacer `<div>` and a `<canvas>` with
`pointerEvents: 'none'`. A plain `overflow: auto` div is not keyboard-focusable in WebKit, so it can
never receive `keydown` and the handler never fires.

That is two things at once: a dead handler, and a comment at `:920-923` asserting *"or a key cancels
our scroll"* when keyboard scrolling is in fact the one input the cancellation does **not** cover.
Harmless today only because the panel can't be focused to scroll with a key either — but the comment
will read as a guarantee to the next person.

---

## 🟡 P3 — Two paints per animation frame

`feedTo`'s `step` calls `paint()` (`:757`) and also writes `el.scrollTop` (`:756`), which fires a real
scroll event → `onScroll` (`:816`) → `paint()` again.

**Measured:**

```
--- ONE PROGRAMMATIC scrollTop WRITE (what feedTo's rAF step does per frame) ---
  landed at 1700px · scroll events fired: 1 · paints: 1

--- FEED WINDOW after one turn lands (700ms) ---
  paints: 33 over ~15 animation frames  → ~2.2 paints per frame
```

So the loop paints roughly twice per frame for its whole flight. **In absolute terms this is cheap**
(see §4 — a paint is ~235 `fillText` and sub-millisecond), so this is waste rather than a performance
problem, and I would not hold a release for it. Worth knowing before anyone makes paint more
expensive.

Related, and purely cosmetic: the *"Re-read the target each frame: content can land mid-flight"*
comment at `:753-754` describes a mechanism that doesn't exist. `feedRef.current.target` is only ever
written by `feedTo`, which calls `cancelFeed()` (nulling `feedRef.current`) first — so nothing ever
mutates `target` in place and `feedRef.current?.target ?? target` always yields the original. The
mid-flight case is genuinely handled, but by **restart**, not by re-reading — and restart demonstrably
works (§4).

---

## §3 — The stick threshold: correct, and the guard is load-bearing

This was the area I was asked to look hardest at, so stating the negative result explicitly.

**I could not construct a race.** Specifically, I checked and cleared:

- **No window between `cancelFeed()` and `animatingRef.current = true`.** `feedTo` runs both
  synchronously with no yield between them (`:735-750`), so no scroll event can interleave and find
  `animatingRef` false mid-feed.
- **The snap path is safe despite not setting `animatingRef`.** It writes `el.scrollTop = target`
  where target is the max, so the coalesced scroll event that follows computes a distance of 0 and
  leaves stick true.
- **The rewind at `:795` is safe.** `el.scrollTop = prev` queues an async scroll event; by the time it
  dispatches, `feedTo` has either set `animatingRef` (guarded) or already snapped to max (distance 0).
- **The settle recompute lands on `dest`**, so distance is 0 and stick re-arms correctly.

And the guard is not redundant — the measurements show it is the only thing preventing the feed from
cancelling itself every single time:

```
worst lag behind the live edge during a feed: 102–106px   (threshold is 80px)
```

The animation deliberately spends its whole flight **outside** the 80px stick threshold. Without the
`animatingRef` check in `onScroll`, every feed would flip stick off partway through its own
animation, exactly as the comment at `:818-821` predicts. The 26px margin between the measured
overshoot and the threshold is narrower than it looks, but it fails safe: a bigger overshoot just
means the guard matters more, not that stick breaks.

---

## §4 — Paint cost: measured, and not the problem

Against the largest real transcript shape (846 turns → **87,357px document**, 553px viewport):

| | |
|---|---|
| **One paint** (scroll handler, synchronous) | **235 `fillText`, ~0.0ms** |
| **One relayout** (full re-flow) | **39,874 `measureText`, 9.0ms** inside text APIs alone |
| Streaming, 10 turns @ 400ms | 401,566 `measureText` / 137ms · 342 paints |
| Streaming, 10 turns @ 150ms | 405,936 `measureText` / 93ms · 196 paints |
| Streaming, 10 turns @ 80ms | 410,296 `measureText` / 92ms · 123 paints |

**Paint is cheap and the viewport cull works.** `paint()` scans every op in the document, but the
cull at `:627` rejects almost all of them and only ~235 draw calls survive per frame regardless of
transcript length. The feed's extra paints (§P3 above) are therefore not a cost worth acting on.

**The cost that matters is `relayout`, and it is pre-existing — not introduced by this diff.**
`useEffect(() => relayout(), [visible])` at `:718` re-flows the *entire* document whenever `visible`
changes, and `visible` derives from `session.messages`, which changes on every `session:update`. That
is ~40,000 `measureText` calls and 9ms+ of pure text-API time **per arriving turn** on a long
transcript, before any of the surrounding JS. Ten turns cost ~400k `measureText`.

I flag it here because 0.10.1 ships an animation on top of it: each relayout now also schedules a
260ms rAF loop. The animation is not what costs — but if the feed ever feels heavy on a long
session, the relayout is where to look, and incremental layout (re-flow only the appended tail) is
the fix, not anything in this diff.

**Streaming keeps up.** The concern that a restarting animation would never settle is **not borne
out** — at every cadence tested, including turns arriving every 80ms (faster than the 260ms
animation), the view settled at **0px** from the live edge with a worst-case transient lag of ~106px:

```
--- STREAM: 10 turns, one every 80ms ---
  worst lag behind the live edge: 102px   after settle: 0px
```

---

## What else I checked and found clean

- **The WebKit pinning workaround** (`:791-796`) is real, correctly explained, and necessary — without
  the rewind the animation would be a no-op in the exact case it exists for, because WebKit moves a
  max-pinned scroller itself before the handler runs.
- **The `tooFar` guard** (`|delta| > clientHeight` → snap) is the right rule and the right threshold
  for session switches, history loads and first paint.
- **`prefers-reduced-motion`** is honoured, and the `< 2px` early-out avoids animating noise.
- **`useEffect(() => cancelFeed, [cancelFeed])`** cancels the rAF on unmount — no leak.
- **Search / saved-only suppression** (`!q && !savedOnly`) is preserved from the original stick logic,
  so filtered results still don't jump to the end.
- **jump-to-latest** (`:972`) correctly reuses `feedTo` so the motion matches, and inherits the
  `tooFar` snap so a jump from far up the document doesn't slide.
- The choice of a rAF loop over `behavior: 'smooth'` is well-reasoned and, given the measured
  1-scroll-event-per-write behaviour, correct: native smooth scrolling would have multiplied paints
  across a flight on a schedule the component doesn't control.

---

## Recommendation for 0.10.1

**Hold for the two P1s** — both are single-click reachable, both silently disable the feature the
release is named for, and both are small fixes:

1. Move cancellation off `pointerdown` onto something that means *drag* (pointermove-while-down, or
   the resulting scroll).
2. Don't release stick on a wheel that can't scroll — or re-engage when the scroller is at its max.

**Ship-then-fix** for the two P2s (`firstPaintRef`/`lastMaxRef` reset, and the stale-baseline write),
which are one-liners but only produce a wrong-looking animation, not a dead feature.

The P3s block nothing. The relayout cost in §4 is a separate, older thread worth its own task.
