# Chat: the transcript should feed upward, not snap

**User, 2026-07-28:** *"chat messages should go up like a typewriter."* Confirmed as **smooth
upward feed** — the paper rising continuously as content lands. **Not** a character-by-character
reveal: Design's refusal of synthetic streaming stands (we receive transcript text in chunks, so a
typed-out reveal would misrepresent when the work happened).

## Today

`CanvasConversation.tsx:720` (auto-stick) and `:874` (jump-to-latest) both do
`el.scrollTop = el.scrollHeight` — an instant jump. Content teleports rather than arrives, which is
what makes the panel read as a log rather than a conversation.

## The traps — these are the actual work, not the animation

The animation itself is nearly free. Everything below is where it goes wrong:

1. **The stick threshold will fight the animation.** `onScroll` (`:728`) recomputes
   `stickRef.current = scrollHeight - scrollTop - clientHeight < 80` on *every* scroll event. A
   smooth scroll fires a stream of them, and while the animation is still mid-flight that distance
   exceeds 80 — so stick switches itself **off partway through its own animation** and the feed
   stalls. Suppress the recompute while a programmatic scroll is in flight, and restore it on
   settle.
2. **A user scrolling up mid-animation must win immediately.** Never fight the pointer or the
   trackpad. Cancel the programmatic scroll on any real user input and leave stick off.
3. **Only animate small deltas.** Session switch, history load and first paint drop thousands of
   pixels at once; smooth-scrolling that is a slow slide through content nobody asked to see. Above
   a threshold (roughly a viewport), snap. Land at the bottom instantly on session switch and on
   initial load — no animation at all on those paths.
4. **The canvas repaints on scroll.** `paint()` runs per scroll event, so a smooth scroll multiplies
   repaints across the animation. Verify it stays smooth on a long session — this is a virtualized
   canvas, so the visible-slice calculation runs each frame too. If it costs too much, drive the
   scroll from a rAF loop you control rather than native `behavior: 'smooth'`, so paint and position
   advance together on one frame budget.
5. **Honour `prefers-reduced-motion`** — snap when it is set.

## Interaction with what already exists

- **Jump-to-latest** (`:874`) should animate too, so returning to the live edge feels like the same
  mechanism rather than a different one. Same distance guard applies — from far up the document, it
  should snap.
- **The status-line/orb motion rule is unaffected.** Motion still means busy; this is view movement,
  not a state signal. Do not let the feed animation borrow the busy idiom's timing or easing — it
  should read as paper moving, not as something working.

## Verify

Extend the chat harness: assert that appending a turn while stuck at the bottom leaves the view at
the bottom **and** that `stickRef` survives the animation (trap 1 — assert the end state, not just
that a scroll happened); that a large content jump does not animate; that user scroll during an
animation cancels it; and that `prefers-reduced-motion` disables it. Test on a long transcript, not
a three-turn fixture — the perf question only appears with real content, and a fixture that is too
small will pass while the real thing stutters (see `feedback_fixtures_must_match_reality`).

**Not a release blocker** — this is polish on a surface that now works. Land it after the v0.10.0
blockers unless they are already clear.
