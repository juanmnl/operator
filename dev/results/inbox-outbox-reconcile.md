# Inbox panel — design reconciliation against 297b670

**Design, 2026-08-24.** Read `InboxPanel.tsx`, `lib/inbox.ts` and the CanvasPanel/DashboardView
wiring as they landed. Five items, ranked. Two are adopt-yours-over-mine; three are defects
against rules already written down in this repo.

## Adopt from the build, drop from my design

**A1. Ack-on-open beats an `Ack` button.** *"Expanding a report is the only moment the system can
honestly claim someone read it"* is a stronger claim than a button someone can click past. My
design's separate `Ack` action should go. **One caveat**: it is now irreversible and reachable by
a stray click, and an acked report loses the only mark saying it was never read. Add `mark unread`
on the expanded row — one line, restores reversibility, keeps the honesty.

**A2. One chronological list beats my two segments.** *"The question a user has is 'what happened
with this lane', and the answer is chronological"* — right, and it dodges the tab-row width
problem my design was working around. Drop the `Received · Sent` segment switch.

**A3. `outboxFor` — a worker seeing whether its own report was opened.** Not in my design, and it
is the other half of an ack being worth having. Keep.

## Defects against existing rules

**D1 — `BLOCK_REASON` is a second vocabulary, and it disagrees with the first.**
`lib/dispatch-outcome.ts` already maps all ten outcomes, and its header records this exact
failure: *"`DispatchLog` had its own six-entry copy … Two half-vocabularies for one concept is how
a `pair-brake` ends up rendering as 'pair-brake'."* `BLOCK_REASON` is a seven-entry copy in a new
file. Where they disagree, the shared one is deliberate:

- `undelivered` — `chipForOutcome` labels it **"sent · never started"** and its comment is explicit
  that it is *not* held: *"this one was SENT and then observed not to arrive, which is a different
  and worse thing than never leaving."* `BLOCKED_OUTCOMES` puts it in the blocked set, so the row
  now reads `Not delivered — the bytes went out…`, which contradicts itself in one sentence.
- `rejected` and `unassigned` are `muted` tone in the shared vocabulary — the quietest ink,
  because nothing is wrong and nothing retries. As `blocked` they now render in warning colour,
  so a declined dispatch shouts as loudly as a hop-limit.

Fix: import `chipForOutcome` for the label and tone; keep `BLOCK_REASON` only as the *extra
sentence* for the three genuine brakes, or better, render `evaluateDelivery`'s own `note` — those
are already written as sentences to a human and are currently shown nowhere.

**D2 — `var(--yellow)` as 9px and 11px text fails contrast on three of six palettes.**
`WARN_INK = color-mix(in srgb, var(--color-warning) 50%, var(--fg))` exists in both `RosterPanel`
and `DispatchLog` precisely because the raw token measured **3.05 / 3.03 / 1.86:1** on the light
palettes — invisible on 1984-light. `--yellow` is the same hue (`#ffb454` = `--color-warning` on
Mission Control). Two sites: the kind column and the `Not delivered —` line. Swap in the mix.

**D3 — the unread count is invisible until you open the tab that shows it.**
`unackedCount` is exported and tested, and has **zero production callers**. `InboxPanel` is the
only thing that fetches reports, and it mounts only on `mode === 'inbox'` — so the number exists
solely inside the surface it was meant to point you toward. No tab badge, no rail marker, no
coordinator toolbar chip; the brief's whole "unread count on the orb and toolbar" is unbuilt.

The fix is already half-written: `artifactUndelivered(role, limit)` proves a cheap targeted
query is available. Add `artifactUnackedCounts(): Record<roleId, number>`, poll it once in
`DashboardView` beside the announcement effect, and feed three consumers.

Placement, and this one is load-bearing: **a marker beside the orb, never a change to the orb.**
`StatusWave`'s house rule is written down — *"a state gets a MARKER, never a dimmer"* — with the
CIELAB measurements behind the 0.17.2 mute, and `waiting` lost its brightness notch for exactly
this reason. A count in `laneTextColor(accent)` at the orb's top-right adds ink to the row and
none to the disc, so the mute stands as shipped.

**Also:** `fontWeight: 600` on unread titles is a second unread channel next to the `●`. On a
dense list the weight shift is what makes resting rows stop receding; the dot alone carries it.
