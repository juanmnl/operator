# Chat baseline spec — ChatGPT/Claude-grade, "just to start"

**Design, 2026-07-28.** Extends `dev/chat-view-critique.md` (structured transcript stands); implements `dev/briefs/chat-baseline-chatgpt-claude.md`. Ordered by what to build first — a credible baseline beats a complete one.

Driven against the mock harness on a free port (1440 was held by another session; used 1447. Not 1433 — that's a bare Python server on an empty directory). Observed at 1680×950 with `MOCK_CHAT` on `s-code`.

**Already landed since the critique, do not restart:** the foot-of-transcript status line with send→stop on `busy`. `lib/chat-signal.ts` is the right spine — it already speaks `running/compacting/waiting/ended` with human verbs, which is exactly `StatusWave`'s vocabulary. Everything below builds on it.

> **Correction (2026-07-28).** The critique's #3 finding — "thinking is discarded, give it a collapsed third state" — **was wrong and is retracted**; see `dev/chat-view-critique.md` §3. Claude Code's thinking blocks are signature-only with empty text (verified: 1091/1091 empty across 40 real transcripts), so the collapsible Thought control built from that finding had a body that could never open. It has since been removed — `isRenderableTurn` drops signature-only thinking, the parse path stays, and a test asserts it. **Nothing in this spec depends on thinking content.** The status line's "Thinking" label is unaffected: it derives from `phase === 'running'` with no tool open, which is honest and is the bit the user liked — do not touch it.

Each item is marked **[RI]** renderer-independent or **[RD]** renderer-dependent, as the brief asks. The renderer choice is Research's recommendation and Code's call — but §7 records where this design is genuinely cheaper in DOM, which is the evidence that decision needs.

---

## 1. Cap the measure — biggest single win, smallest change **[RI]**

Measured at a 1680px window: the canvas is 1436px and content runs **1400px** — roughly **180 characters per line**. Neither reference would ship that. It is the reason the panel reads as a log rather than as writing, and it costs nothing to fix.

- Cap the text column at **720px** and centre it. That's `MEASURE_FORM`, already the app's prose measure (settings pages) — reuse it rather than inventing a chat-specific number.
- **Code blocks and tables may exceed the measure**, up to a wider cap (~960px). They are scanned, not read line-by-line, and both references let code run wider than prose. Wrapping a code sample to 720 to match a paragraph helps nobody.
- Centre the column in the panel, not in the window — the panel already sits beside the sidebar.
- The status line and composer keep the **same measure and centre line** as the transcript. A composer that spans 1400px under a 720px column is the header/grid misalignment bug again, in a different costume.

Everything else in the typography stays: 13.5/21 prose, code chips, real lists and tables. The critique was explicit that this part is good.

---

## 2. The orb becomes the composer's send/stop control **[RI]** — decided

Today's control is a plain 28px circle, visually unrelated to the orb language the rest of the app speaks. Replacing it resolves that, and also kills a redundancy the screenshot exposed: **there are currently two stop controls on screen at once** — a `STOP` button in the status line and the circle in the composer.

### The rule that makes it coherent

> **The orb tells the truth about the lane. The ring is the verb.**

The core is a `StatusWave` carrying the **lane accent** and the state from `chatSignal` — the same component, colour and motion rule as the sidebar, roster and gallery. It never becomes a "send icon"; it is always the lane's state. What changes around it is a ring and an optional glyph, which is where the *action* lives.

| Session state | Composer | Orb core | Ring + glyph | Click does | Cursor |
|---|---|---|---|---|---|
| idle / waiting | empty | lane accent, **static** | none | nothing — it's a status light | default |
| idle / waiting | has text | lane accent, static | accent ring + **send arrow** | send | pointer |
| running / compacting | either | lane accent, **animating** | error-tinted ring + **square** | **stop** | pointer |
| no live session | — | grey, static, reduced presence | none, `aria-disabled` | nothing | default |

- **Motion stays the busy signal.** `running`/`compacting` animate; `waiting`/`idle` rest static. Do not invent a second motion idiom in the composer.
- **Stop reads from the square glyph and the error-tinted ring, never from red ink.** Code's existing note is right — `--color-error` measures 2.81:1 on 1984-light. Keep that.
- **Size up to 32px** with a 16–18px wave inside. 28px is fine for a button and too small for something that must also read as a status.
- **Remove `STOP` from the status line.** One stop control. The status line becomes purely informational: what it's doing, and for how long.

### The two questions the brief asked to resolve

**At rest with an empty composer, is it a button?** No. It is a status light and is not clickable, because there is no action to take. This is the honest reading and it avoids a control that looks live but does nothing. The affordance appears exactly when the action does — the ring is the tell.

**Running, with text typed?** The orb stays **stop**. Stop must be unambiguous, and both references behave this way. But Operator hosts Claude Code, where sending *into* a running turn is a real and useful thing — so **Enter still sends, queued into the current turn**, and while running with a non-empty composer a quiet inline hint (`↵ sends into this turn`) sits beside the orb. The asymmetry is deliberate and explained rather than surprising: the button is for stopping, the keyboard is for talking.

---

## 3. Turn identity and rhythm **[RI]**

Every turn currently reads `You` / `Agent` with the same header and the same gap, so a one-word turn costs what a decision costs. Observed: three consecutive short turns burned ~200px on six words.

**Agent turns** — the header carries the **lane name and its accent** (`CODE`, in the Code lane's green), not a generic `AGENT`. In an app whose premise is named lanes on different models, "Agent" is a wasted signal. Prose stays flush to the column: the answer is the content.

**User turns** — get a **quiet container**: a `--overlay-subtle` tint, rounded, generous padding, flush left. Both references give the user turn a distinct container and it is genuinely useful — it lets you find your own instructions when skimming back. It is *not* a bubble: no right-alignment, no accent fill. (House rule: never a coloured left-border stripe — the tint is the marker.)

Because the tint already says "you", the user turn **drops its `YOU` label**; timestamp on hover. A short turn like "ok" collapses from ~60px to ~28px, which is most of the density problem solved without a single collapse control.

**Consecutive same-speaker turns** continue without repeating the header.

---

## 4. What both references have that we don't

### 4a. Per-message actions **[RI — the mechanism already exists]**
A hover toolbar is already hit-tested over the turn under the pointer (copy / star / dismiss). Extend it rather than build it: **copy** on any turn, and **edit + retry** on a user turn. Retry is the one users reach for most and we have none.

### 4b. Code blocks: language label + copy **[RD-ish]**
The language tag already renders. A per-block copy button is the same hit-test the hover toolbar already does, so it is *achievable* on canvas — but it is per-block, positioned, and multiplies with every block on screen. Cheap in DOM, fiddly on canvas. **Build it after §1–3**, and let the renderer decision land first if it's close.

### 4c. Streaming **[RI]**
Text arrives in tailer chunks, so there is no token-by-token feel and we should not fake one — a typewriter that misrepresents when work happened is worse than flat. Instead the honesty is already available: the **status line says what it's doing and for how long**, and the running orb animates. That is a live affordance without a lie. Chunked text simply appearing is acceptable for a baseline. **Do not build a fake typewriter.**

### 4d. Composer shape **[RI]**
Taller rounded capsule, closer to both references: increase the corner radius, give the textarea more vertical padding, and let it grow to ~6 lines before scrolling. The orb sits inline at the right, vertically centred against the first line. Model/effort pills stay but recede — they are configuration, not composition.

### 4e. Empty state **[RI]**
Before any turns: the lane's name and what it is (from the role's charter), the model it's pinned to, and one line about what to type. Not a generic "start chatting" — the specific lane you're about to talk to. Quiet, centred in the measure, no illustration.

---

## 5. Build order

1. **§1 measure cap** — one constant, biggest readability jump. Do this first even if nothing else lands.
2. **§2 orb** — decided; also removes the duplicate stop.
3. **§3 turn identity + user container** — rhythm and density.
4. **§4d composer shape** — pairs naturally with §2, same file.
5. **§4a per-message actions** (extend the existing toolbar), **§4e empty state**.
6. **§4b code copy** — after the renderer decision if that lands soon.
7. **§4c streaming** — explicitly nothing to build.

**§1–3 are the "recognisably in the same class" set.** Measure, a coherent send control, and turn rhythm are what make it read like ChatGPT/Claude. Everything after is polish.

---

## 6. Deliberately skipped

- **Fake token streaming** (§4c) — misrepresents when work happened.
- **Regenerate on agent turns** — retry-from-user-turn covers it, and regenerating an agent turn mid-session has murky semantics when tool calls already ran against the filesystem.
- **Message-level branching / edit-and-fork.** Both references have it; it implies conversation trees, which is a much bigger idea than "just to start".
- **Avatars.** The orb is the identity; a second identity mark per turn is noise.

---

## 7. Renderer evidence

Per the brief, this is the input to Research's spike, not a renderer pick.

**Renderer-independent** (canvas or DOM, no change to this design): the measure cap, the orb and composer entirely (already DOM), the status line, turn identity and the user-turn container, empty state, streaming stance.

**Cheaper in DOM, achievable on canvas:** per-message actions and code-block copy — both are hit-tested affordances, and the existing hover toolbar proves the pattern works. The cost is per-block positioning, which grows with content.

**Only achievable in DOM:** native text selection, and with it find-in-page and screen-reader access to the transcript. Nothing in §1–5 depends on it, so **this spec does not force the renderer decision** — but a canvas transcript cannot be selected or read by assistive tech, and no amount of hit-testing changes that. That is the honest statement of the trade.

---

## 8. Verification

Extend the theme pass with a chat sweep across all six palettes: prose, lane-name header, user-turn container, status line, and the orb in each of its four states. Expect 0 below floor (4.5:1 body / 3:1 meta). Assert mechanically: transcript, status line and composer share one centre line and one measure; exactly **one** stop control exists while running; the orb's core colour equals the lane accent; and `animate` is true only for `running`/`compacting`.

House rules apply throughout: no solid accent fills for state, no browser focus rings, no coloured left-border marker stripe, and never stack `opacity` on `var(--fg-muted)`.
