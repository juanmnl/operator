# Chat view: get to a ChatGPT/Claude-grade baseline

**User, 2026-07-28:** *"i need something closer to chatgpt and claude just to start"* and
*"the send message and idle button in the chat box, should be the orb"*.

Read `dev/chat-view-critique.md` first — this brief extends it, it does not replace it. The
structured-transcript decision still stands. This is about the **reading and composing experience**
being recognisably in the same class as the two references.

## 1. The orb replaces the send/stop button — DECIDED, not a question

The composer's send control (`ChatComposer.tsx:284`, currently a plain 28px `borderRadius:'50%'`
circle) becomes **the status orb**. One control carries identity and state:

- The orb is already Operator's state language (sidebar, roster, gallery). The composer having its
  own unrelated circle is the app speaking two dialects on one screen.
- It should carry the **lane accent**, like every other orb.
- **Motion stays the busy signal** — `running`/`compacting` animate, `waiting`/`idle` rest static.
  This is an app-wide rule; do not invent a second motion idiom here.
- Stop must stay unmistakable. Code's own note on the current implementation is right and worth
  keeping: *stop reads from the square glyph and an error-tinted ring, not from red ink.*
- Resolve what the orb means at rest: it is simultaneously "this lane's state" and "send". Say
  explicitly how a disabled/no-live-session state reads, and how it reads when the composer has
  text versus none.

Note `ChatComposer` was just rewritten (11:26) to flip send→stop on `busy`. Build on that, do not
restart it.

## 2. Measure — the biggest single readability gap

`CanvasConversation.tsx:308`: `contentW = Math.max(120, cssW - MARGIN * 2)` with `MARGIN = 18`. The
transcript is **full-bleed to the panel width**. Both references cap the column (~48rem / 700–800px)
and centre it. On a wide window our lines run to a length neither reference would allow.

Cap the measure and centre it. Prose typography is otherwise good (13.5/21, code chips, real lists
and tables) — the critique is explicit that it should not be rebuilt.

## 3. Turn identity

`:336` labels every turn `'You'` or `'Agent'`. In an app whose whole premise is *named lanes with
distinct models*, "Agent" is a wasted signal — this should be the lane name, with its accent.
Decide whether user and agent turns are visually differentiated beyond the header (ChatGPT and
Claude both give the user turn a distinct container; our document style deliberately does not — say
which way we go and why).

## 4. What both references have that we do not

Spec these; flag any that you think we should deliberately skip:

- **Per-message actions** — copy, and retry/edit on a user turn. Currently there is nothing.
- **Code blocks** — copy button and language label.
- **Streaming.** Text arrives in tailer chunks, so there is no token-by-token feel. Decide whether we
  fake nothing (honest but flat), or show a live "writing" affordance. Do not propose a fake
  typewriter that misrepresents when work actually happened.
- **Composer shape.** Ours is a 14px-radius box with a pill row; both references use a taller
  rounded capsule with the send control inline. This is where the orb lands, so the two decisions
  are one decision.
- **Empty state.** What the panel says before a session has any turns.

## 5. The constraint you must design around

The transcript is **painted on a `<canvas>`** (parse once → positioned line ops → virtualized
paint). That is why it never freezes and has no size cap — real wins, do not casually discard them.
But it means every affordance is hand hit-tested, and it is why there is still no native text
selection.

Several items above (per-message hover actions, code-block copy buttons, selection) are cheap in DOM
and expensive on canvas. **Research has a spike in flight** comparing a DOM text overlay, a hybrid
where prose is DOM and only code/tables stay canvas, and a contenteditable mirror.

So: **spec the experience, and mark each item as renderer-independent or renderer-dependent.** Do not
pick the renderer — that is Research's recommendation and Code's call. But if your design is only
achievable in DOM, say so plainly; that is exactly the evidence the renderer decision needs.

## Deliverable

`dev/chat-baseline-spec.md`. Ordered by what to build first. Say which items get us most of the way
to "recognisably in the same class" — the user said *"just to start"*, so a credible baseline beats
a complete one.

Verify against the mock harness on a free port (**not** 1433 — bare Python server, not the app);
`MOCK_CHAT` on session `s-code` has multi-turn content with code, lists and thinking. All six
palettes. House rules: no solid accent fills for state, no browser focus rings, no colored
left-border marker stripe, and never stack `opacity` on `var(--fg-muted)`.
