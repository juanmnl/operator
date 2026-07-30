# Channel view — a feed you can skim

Answers `dev/briefs/channel-view-improvement.md`, all nine findings.

Driver: **`dev/drive-channel-view.mjs`** (new).

---

## The shape I chose, and what I rejected

The brief offered five directions and said *argue for one, don't do all five*. I took **clamped
bodies + author-run grouping + a distinct treatment for actionable chips**, and rejected two:

- **Rejected: a separate compact row form for one-line status reports.** A clamp already produces
  it. A one-line reply renders as one line; an 8-line dispatch renders as four plus a control. A
  second row *form* would be a second set of rules deciding which one you get, and the failure
  mode is a report that grows a line and silently changes shape.
- **Rejected: a different row form for dispatches vs replies.** The distinction is real but it is
  already carried by `→ target` (a dispatch is addressed, a broadcast reply is not) and by the
  chip vocabulary. Splitting the row form would fork every future change to this component in two,
  to encode something two existing fields already say.

## The nine findings

**1 · Unclamped bodies** → `ChannelBody` folds at **4 lines** with Show more / Show less. The
control appears only when the text *actually* overflows — measured against `scrollHeight`, and
re-measured through a `ResizeObserver`, because the panel is resizable and the same string wraps
differently at every width.

Four, not the brief's 2–3: at the new measure the median real dispatch is ~6.5 lines, and folding
to 2 would hide the *whole* ask on most rows. Four keeps "Read dev/briefs/X.md and do it…" — the
part a skim reads — and puts the rest one click away.

**2 · Line length** → prose is decoupled from the shell. `MEASURE` stays 720 for the header,
composer and meta line; the body alone gets `PROSE = 470`.

Sized by measuring the body's own computed font, not by assuming px-per-character — **my first
pass at 520 was arithmetically fine and came out at 87 chars/line, still outside the band.** 470
measures **79**. Top of the 60–80 band rather than the middle, deliberately: a narrower column
pushes the p90 dispatch into many more lines and makes the 4-line clamp hide more than it reveals.

**3 · Grouping** → new pure `isContinuation(prev, entry)` in `project-channel.ts`: same author,
within 8 minutes. A continuation drops the avatar and name and holds the 26px gutter open so every
body in a run keeps one left edge.

**I grouped by author only, not author+target as the brief suggests, and that is a deliberate
divergence.** The real store's dominant shape is a long run of one author to *varying* targets —
`operator→design`, then `operator→code`, then `operator→research`. Requiring the target to match
would collapse almost nothing on real data. So identity collapses and the target stays on every
row, which also keeps finding **8** honest: the routing is what varies inside a run and hiding it
would gut the reason to group at all. Measured: 12 author labels → **5**, longest consecutive
repeat 7 → **1** (the real store's longest run is 33).

**4 · Backticks** → `parseInline` from `lib/canvas-md`, memoised per text and capped at 8KB. No
react-markdown. 11% of real dispatch tasks and 2 of 6 chat.db replies carry backticks; **6 bodies
showing literal backticks → 0, and 8 code chips rendered.**

**5 · Flat chip vocabulary** → two changes.

- `chipForGroup` derives the **tone** from the records. It was hardcoded `accent`, so
  `delivered 6/6` and `delivered 4/6 · 2 queued` painted identically — the actionable case
  rendering as success. Now `warn` if anything is held, `progress` if anything is queued.
- Actionable chips (`warn`/`progress`) get a **shape**, not just an ink: a transparent tint at
  13%, `1.5px 6px`, radiused. No border and no solid fill, so nothing colour-changing lands on a
  radiused element. `delivered` / `posted` stay bare text.

Also fixed en route: `TONE.warn` was set to `ACCENT_INK` — **byte-identical to `TONE.accent`** — so
`held · needs your approval` and both agent→agent brakes painted the same colour as `delivered`.

**6 · The pause reads as decoration** → three things, only one of which is the banner:

- `chipForOutcome('paused')` returned tone `muted` — the *quietest* ink in the feed, the same one
  `declined` uses. A message that reached nobody was drawn more faintly than one that landed. Now
  `warn`, consistent with the two brakes, which already were.
- The `warn`/`accent` collision above.
- A notice that appears **only once the pause has actually cost something** (≥1 entry the data
  layer already marked paused), counts them, and carries the un-pause. No standing nag: the switch
  ships paused, so an unconditional banner would be furniture within a day. Verified it retires
  when delivery is switched on.

It is **sticky**, and that was a bug I shipped and caught: the feed opens scrolled to its newest
entry, so a notice parked at the top of the document is in the one place the reader never looks.
The driver now asserts `onScreenAtLanding`, not mere presence. The copy rule survives — the header
switch still states what IS, not what the click does.

**7 · Undated timestamps** → the day divider is now **sticky**, pinned under whatever chrome is
showing. A static divider only tells you the date while it happens to be on screen, which is
exactly when you don't need it; scrolled into a long feed every timestamp read `04:05` with
nothing saying which day.

This needed a small restructure: the header and the paused notice were two independent stickies at
`top: 0` and a hardcoded `top: 45`, and a hardcoded offset cannot know whether the notice is
showing. They are now one measured sticky block (`chromeH`, via `ResizeObserver`) so the divider
can pin below whatever is actually there. Verified visible with the feed scrolled hard to the
bottom.

**8 · `→ target` is tertiary ink** → the arrow stays muted (it is punctuation); the **name** steps
up from 9.5px muted mono to 11px at 82% `--fg`. Measured distinct from the timestamp beside it,
which is unchanged at 9px muted.

**9 · Send button looks clipped** → **not a bug.** Measured at 900 / 700 / 560px viewport heights:
the Send button and the composer note are fully inside the viewport in all three (`sendFullyVisible:
true`). The composer is `flexShrink: 0` against a `minHeight: 0` scroller, so it cannot be
squeezed. It was a screenshot crop.

## Verified

- `npm run build` clean. `npm test` **429/429**.
- `node dev/drive-theme-pass.mjs`, all 6 palettes: **`BELOW FLOOR (4.5 body / 3 meta): 0`**.
  Channel probes: author name 6.48–7.99, message body 12.99–17.15, chip·delivered 5.46–13.40,
  chip·held 3.85–11.42. **Note the held chip dropped from 4.55–15.42 to 3.85–11.42** — the badge
  tint costs ~1–1.5 points against its own backdrop. Still clear of the 3:1 meta floor everywhere,
  worst case 3.85 on 1984-light, but it is a real cost and worth knowing before anyone deepens
  that tint.
- **Skim measures:** tallest entry 275px → **124px** (37% → **17%** of the viewport); feed height
  1187 → 1137px with more information per row.
- **Scroll does not drift** (the brief's live-panel constraint): expanding a body moves the row you
  were reading by **0px**.
- Both chatter states (paused → notice; live → no notice, rows unchanged), the empty feed, the
  window-overflow case, and a long-version row all checked.

*(One theme-pass run died on `[data-page-tab="library"]` — a Playwright timeout in the Agent
Library step, unrelated. Clean re-run passed; recording it as flake rather than a pass I explained
away.)*

**Port note:** the brief says to use the live dev server on 1433. That port is serving a Python
`http.server` directory listing of an empty folder — not the app — so nothing could be eyeballed
there. I used 1436, this session's assigned port, and did not bind 1433. I also could not drive
`web27` specifically: the mock bridge's projects are fixture-defined. Instead the fixture is built
from the **real** stores — `~/.operator/projects.json` (332 dispatches: median task 520 chars, p90
1165, max 2790, 11% with backticks) and `chat.db` (6 replies verbatim, backticks and all) — which
is what the existing `drive-project-channel.mjs` fixture, at 20 characters a body, could never have
surfaced.

## Left alone deliberately

- **Semantics** — what gets posted, delivery rules, the pause default: untouched, as instructed.
- **`delivered` still owns the accent, and it is ~98% of real outcomes** (90 `sent` + 8 `launched`
  of 100). The brightest ink in the channel is spent on the outcome needing least attention. The
  actionable-chip tint narrows the gap from the other side, which is why I stopped there — but the
  underlying tone assignment is still backwards, and inverting it (`sent`/`launched` → `muted`) is
  one line plus a test update. It changes shipped data-layer semantics, so it is a call to make
  rather than slip in.
- **`drive-project-channel.mjs`'s fixture** still seeds 20-character bodies. Its 15 sections test
  *behaviour* and they pass, so I left it — but it will keep passing however unreadable the feed
  gets. The two drivers are complementary; neither alone is enough.
- **Hard newlines in a clamped body.** `pre-wrap` + `-webkit-line-clamp` is exercised here only on
  soft-wrapped text; no real entry in either store contains a newline.
