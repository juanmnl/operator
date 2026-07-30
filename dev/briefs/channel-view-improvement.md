# Brief — the channel view needs a lot of improvement

Component: `src/renderer/components/session/ProjectChannel.tsx` (386 lines — read it whole).
Screenshot: `/tmp/operator-shots/channel-view.png` (project `web27`, Mission Control dark).
User verdict: **"the channel view needs a lot of improvement."** Broad mandate — this is a
redesign of the reading experience, not a spacing tweak.

## What's on screen

Header `# channel  web27` … `AGENT↔AGENT PAUSED`. Then a feed of messages, each:
avatar circle (OP/CO/YO) · author name in lane accent · `→ target` · `HH:MM` · a status chip
(`DELIVERED` / `POSTED` / `DELIVERED 4/6 · 2 QUEUED`). A `2026-07-30` date divider. Composer at
the foot with `TO` chips (everyone / Operator / Research / Code / Review / Design / QA), a
textarea, and `Send ⌘↵`.

## The problems

1. **Long messages are dumped whole, unclamped.** `data-channel-text` is
   `whiteSpace: 'pre-wrap'` with no max height (line 234). Every dispatch renders in full — the
   screenshot is dominated by 6–8 line operational briefs. A one-line status report from Code
   ("Rebuilt Operator landing synced into web27 embed… pushed as 3e74be6b") is drawn at the
   **exact same weight** as an 8-line dispatch. The feed has no skim layer at all.
   → Clamp long bodies with an expand affordance. The first 2–3 lines are the message; the rest
   is detail.

2. **Line length is past the readable range.** `MEASURE = 720` (line 29) at `fontSize: 12`
   is roughly **115 characters per line** — well beyond the 60–80 comfortable measure, and this
   is dense operational prose. The header and composer legitimately want the wider column; the
   BODY does not. Consider decoupling the prose measure from the shell measure.

3. **No consecutive-message grouping.** Three `Operator → Code` messages in a row each repeat
   the avatar, the name, the arrow and the chip. In the screenshot that's ~4 lines of repeated
   chrome per message. Group runs by the same author (and target) — subsequent messages keep the
   timestamp, drop the rest.

4. **No inline formatting — backticks render literally.** The bodies are full of
   `` `https://uwazi.io` ``, `` `.note-drawer` ``, `` `max-height:100vh` ``, `` `npm run build` ``,
   and they display as raw backticks. **`parseInline` already exists** in
   `src/renderer/lib/canvas-md.ts:152` and is the pure tokenizer the chat canvas uses — reuse it
   here, at minimum for inline code and URLs. Do not add react-markdown (there's a documented
   freeze from re-parsing on every update; the whole reason `canvas-md` is a hand-rolled pure
   tokenizer).

5. **The status chips are one flat vocabulary.** `DELIVERED`, `POSTED`, and
   `DELIVERED 4/6 · 2 QUEUED` all render identically at `fontSize: 8.5` muted uppercase
   (line 226-231, coloured only by `TONE[entry.chip.tone]`). But they mean very different things:
   *posted* (went to the channel, nobody was interrupted) vs *delivered* (landed in a session) vs
   **2 QUEUED** (something is waiting and may never be picked up). The last is actionable and is
   currently the quietest thing on the row. Give the actionable states a distinct treatment.

6. **`AGENT↔AGENT PAUSED` is the most consequential state in the view and reads as decoration.**
   It's a 9px muted mono button in the top-right corner (lines 113-140). When paused — which is
   the shipped default, deliberately — **agents post but nothing reaches their sessions.** A user
   reading this feed can watch messages pile up as `POSTED` and reasonably believe they were
   received. The pause state needs to be legible IN THE FEED, not just in a corner badge. The
   existing copy rule is good and must survive: the label states what IS, not what the click does.

7. **Timestamps above the date divider have no date.** The feed shows `02:16`, `04:05`, `05:46`,
   then a `2026-07-30` divider, then `13:56`. Everything above the first divider is undated.

8. **`→ target` is styled identically to the timestamp** (same 9–9.5px muted mono). Who is
   talking to whom is the primary axis of a channel and it's currently tertiary ink.

9. **The `Send` button looks clipped at the bottom edge** in the screenshot. Verify the composer
   is not being cut by the viewport; if it is, that's a layout bug, not a style one.

## What I want back

A feed you can **skim** — where you can see at a glance who is talking to whom, which messages
carry real information, what's still waiting, and whether agent↔agent delivery is on. Long briefs
should be *available* without being the entire page.

Your call on the shape. Weigh at least: clamped bodies with expand; author-run grouping; a
distinct compact treatment for one-line status reports vs multi-line dispatches; and whether
dispatches (an instruction to a lane) deserve a different row form from replies (a report to the
room). Argue for one, don't do all five.

Do **not** change the channel's semantics — what gets posted, delivery rules, or the pause
default. This is the reading and scanning experience.

## Constraints (house rules)

- Reuse `canvas-md`'s `parseInline`; **never** react-markdown in a live-updating panel.
- Transparent badges. No solid accent fills for state. No browser focus rings.
- **Never a coloured left-border marker stripe** — no "unread bar" of that kind.
- **Never recede a message with group `opacity`**; recede by token.
- Never stack opacity on `--fg-muted`.
- No colour-CHANGING border on a radiused element (WKWebView freeze). The chatter toggle at
  line 128-136 already dodges this by riding state on the INK with a static border — keep that.
- `laneTextColor(accent)`, never a raw accent, for author names and initials.
- **Avatar vocabulary is load-bearing**: an author is a CIRCLE, a project is a rounded SQUARE
  (`ProjectChannel.tsx:24`, `ProjectRail.tsx:12-36`). Don't break it.
- Scroll position must not drift when a message arrives or a body expands — this is a live
  panel; anchor the scroll.

## Verify

- `npm run build` clean; `npm test`.
- Eyeball on the dev server at **port 1433** (already live — do NOT start another). Use a project
  with real history — `web27` is the one in the screenshot and has the long dispatches.
- Check BOTH chatter states (paused and live) and the empty state (`data-channel-empty`).
- `node dev/drive-theme-pass.mjs` — all 6 palettes.

## Output

Write `dev/briefs/channel-view-improvement-RESULT.md`: the shape you chose and what you rejected,
the new measure/clamp numbers, how grouping works, how the pause state now reads in the feed,
and what you deliberately left alone. Then one OPERATOR-REPLY line.
