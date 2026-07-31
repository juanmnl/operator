# Channel composer — one surface

Answers `dev/briefs/channel-composer.md`.

---

## Addressing: one control, not seven pills

**Chosen: a compact target control inside the container that opens the full list on demand.**
`to everyone ▾` — one element, whatever the roster size.

The seven-pill bank was a radio group wearing chip clothing, and checking the one-lane case first
(as you asked) settled it: after the prune most projects have **one lane**, so the row read
`to · everyone · Operator` — a permanent row spent on a choice between two, and the row grows with
the roster rather than with the need.

Measured, one lane vs six: **identical composer** — same height (65px), same controls, `pills: 0`.
That is the win. The old design went from 3 pills to 8 across the same range.

### Rejected

- **Inline `@lane` parsing.** Closest to the reference apps and it composes with the dispatch
  grammar — but it's a parser plus autocomplete plus a new addressing grammar, and it makes prose
  that merely *mentions* `@design` ambiguous with addressing it. The brief says keep the send
  contract (⌘↵, the cap, the disabled state), which reads as "this is a layout pass, not a
  semantics one". Worth its own brief.
- **Pills sized to the actual roster.** Still spends a row on addressing at one lane, and still
  scales with roster size — it makes the symptom smaller rather than removing it.

**Reused `PopMenu` rather than writing a menu.** It was private to `ChatComposer`; it is now
`src/renderer/components/PopMenu.tsx`, imported by both. A second menu implementation is how an
app ends up with two menus that drift — the same reasoning as the shared `Segmented`.

## The container

One bordered surface holding the textarea and, beneath it, a row with the target control on the
left and the count + Send on the right. Previously two bordered boxes side by side, which read as
two adjacent controls rather than one place you write.

- **Focus ring is an inset `box-shadow`**, never a border colour change — a composer that
  highlights on focus is exactly the WKWebView re-rasterization trap the brief names.
- **`rows={1}`, auto-grown** to a 160px ceiling. It was a fixed 2 on a surface whose typical
  message is one line. `grow()` resets height to `auto` before measuring, or the box can only ever
  grow; it also re-runs on resize, since it writes an explicit inline height that would otherwise
  be stale at the new width.
- **The chord is stated once.** It was in the placeholder *and* on the button; it is now only on
  the button (`Send ⌘↵`), with the placeholder naming the target instead.
- **The count moved inside** the container, beside Send.

## The clipped feed edge

A short **fade** at the scroller's bottom (`mask-image`, 14px), so the feed passes *under* the
composer rather than ending at it. Bottom only — a top fade would eat the sticky header. The
composer's rule stays, softened to the same 70%-mixed `--border` the rail now uses.

## Focus states

Every control has its own, measured by focusing each in turn:

```
[data-channel-composer]       own ring: —      surface ring: yes   outline: none
[data-channel-send-target]    own ring: yes    surface ring: yes   outline: none
[data-channel-send]           own ring: yes    surface ring: yes   outline: none
```

The textarea's ring *is* the surface ring — that is the "you are typing here" signal and a second
ring inside it would be noise. The two buttons get their own, because tabbing must show *which*
control you are on.

**Send showed no ring on my first probe** — because it is disabled on an empty draft and a
disabled button cannot take focus. The probe types first now. The inert state is still reachable
and inert (`disabled: true`, `cursor: not-allowed`).

⌘↵ still sends (draft clears). Narrow pane unaffected: 43 chars, no horizontal overflow.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `drive-project-channel.mjs` — all **33** assertions pass. It drove the old pills, so it now opens
  the menu and picks an item via a `pickTarget()` helper.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**.
- Left edges still shared: header / row / composer all at **16** at every pane width.
- One-lane and six-lane screenshots: `/tmp/operator-shots/composer-{one-lane,six-lane}.png`.

### Two bugs I introduced and fixed en route

- **A data-attribute collision.** I named the target button `data-channel-target`, which was
  already the feed row's `→ Design` span from the P8 pass — the driver matched 8 elements and died.
  Renamed `data-channel-send-target`.
- **The theme pass died** with `__contrast is not a function`. Section 3 relied on section 2c's
  injection surviving, and it stopped doing so once `main`'s new "entering a project lands on the
  channel" behaviour merged in — a navigation drops the injected probe. It re-injects now, as the
  other sections already did.

---

## Open regression — scroll drift, NOT fixed

**`4g` went from 0px to 19px.** On a 1400→900 pane resize, the row under the reader moves 19px.
Body-expansion anchoring is still 0px; it is specifically the width-change path.

What I established, so the next attempt doesn't start cold:

- The correction **is** wired and the anchor **is** recorded (38 `rememberAnchor` calls in the run).
- `scrollTop` does move (381 → 442) but lands 19px short of where the anchor needs it — 442 rather
  than the 461 my correction would produce. So something moved the scroll and it was **not** my
  correction firing for that resize.
- Re-running the correction on the next frame, the frame after, **and** on an 80ms timeout all
  produced exactly 19px — unchanged. Late settling is therefore not the cause, which is what I
  first assumed twice.
- 19px is suspiciously close to one "Show more" control appearing above the fold as bodies re-wrap
  narrower, so the height change above the anchor is real; the question is why the correction
  doesn't absorb it.

I reverted my speculative multi-pass attempts rather than leave code that looks like a fix and
isn't, and left a comment at the site pointing here. I would rather hand this over as a known,
characterised regression than claim it closed.

## Not done

- **Inline `@lane` addressing** — argued above; belongs in its own brief.
- The menu is `PopMenu`'s existing styling; I did not restyle it, since it is now shared with
  ChatComposer and a visual change there is a separate decision.
