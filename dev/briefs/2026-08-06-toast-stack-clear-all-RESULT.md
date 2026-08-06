# RESULT — Toast stack: coalesce, Dismiss all, cap

**Brief:** `dev/briefs/2026-08-06-toast-stack-clear-all.md` · **Lane:** Design · **2026-08-06**
**Status:** built and verified. `npm test` 686 passed (56 files) · `npx tsc --noEmit` clean ·
`npm run build` clean · six-palette GUI pass green.

---

## What landed

| File | Change |
|---|---|
| `src/renderer/components/Toast.tsx` | `coalesceToasts()` (exported, pure), `×N` count chip, stack-level **Dismiss all**, overflow cap + `+N earlier` marker, per-card `exiting` for the group fade |
| `src/renderer/views/DashboardView.tsx` | `dismissAllToasts` next to `dismissToast` (line ~395); `onDismissAll` passed at the render site (line ~4403). Nothing else. |
| `src/renderer/components/toast-stack.test.ts` | **new** — 15 unit tests for coalescing, group dismissal, thresholds, cap, mid-fade race |
| `dev/toast-preview.tsx` | **dev-only** — two new burst samples (the real 4-identical+1 pile-up, and a 7-distinct overflow case) + `onDismissAll` wired |
| `dev/drive-toast-stack.mjs` | **new dev-only** — Playwright pass over 3 identities × light/dark: card counts, count chip, Dismiss-all behaviour, cap, contrast, stack height |

`reportUndelivered` (~1288) and `src/renderer/lib/submit-queue.ts` were **not touched** —
`git diff` on DashboardView is the two hunks above and nothing else.

---

## Decisions

### 1. Coalesce key — `kind ‖ text ‖ detail`

Deliberately **not** keyed on `action`/`onClick`. Those are closures, and the burst that
motivated this is precisely N identical sentences whose `Show` buttons each target a
*different* terminal — keying on the closure would have grouped nothing. What the user
perceives as "the same toast" is the sentence, so that is the key.

The card is keyed on the **oldest** occurrence's id. A repeat therefore increments a count
**in place** rather than re-entering at the bottom of the stack; the card doesn't jump.
`count` is in the auto-dismiss effect deps, so a repeat re-arms the 3.5s dwell instead of
inheriting the first occurrence's remaining time.

### 2. The discarded actions — resolved, not swallowed

The brief flagged this ("if that reads badly, decide it and say why"). It *does* read badly:
four `Show` buttons collapse to one, and the count `×4` silently implies the surviving button
covers all four. It does not — it reaches the newest.

**Decision: keep the newest occurrence's action, and say so in the label.** When 2+ occurrences
each carried an action, the button renders `Show latest` (and carries
`title="Applies to the most recent occurrence"`). One word, no new UI, and it is true. The
alternative — a menu of four `Show` targets inside a toast — is more machinery than a transient
notice can justify, and the lanes are all one click away in the rail regardless.

A later action-less occurrence never blanks out an earlier action (tested).

### 3. Threshold for Dismiss all — **2 cards, after coalescing**

Below two, the ✕ on the single card is exactly as fast, so the control would be pure noise.
Note the interaction with coalescing: **four identical toasts are ONE card and get no
Dismiss all** — the ✕ on that card already clears all four occurrences. The control appears
only when there is genuinely more than one thing to clear.

### 4. Cap — **4 cards**, keeping the newest

A card is ~56–72px plus an 8px gap and the column starts at `top: 52`, so four cards plus both
stack rows land at **368px** in an 820px viewport — measured in all six palettes, comfortable
clearance. Overflow keeps the **newest** cards: hidden ones are the older news, and in a stack
that grows downward they belong above, which is exactly where the `+N EARLIER` marker sits.
Dismiss all clears the hidden ones too.

### 5. Two verbs, two names

Per the house rule the stack control is **worded** (`DISMISS ALL`), never another bare ✕.
The GUI pass caught the same collision one layer down: the coalesced card's ✕ was
`aria-label="Dismiss all 4"`, which a screen reader announces identically to the stack control.
Renamed to `Dismiss these 4`. Playwright's strict-mode violation is what surfaced it.

### 6. Mid-fade race

`Dismiss all` snapshots the ids on click and clears **only those** 180ms later — it does not
empty the array. A toast pushed during the fade is not in the snapshot, so it neither animates
out nor gets swallowed. `clearingIds` is a `Set`, not a boolean, for the same reason.

### 7. Dismissal is presentation only

`dismissAllToasts` filters the `toasts` array and nothing else. No `DispatchRecord`, no
`setDispatchOutcome`, no `rejectDispatch`. An `undelivered` dispatch stays `undelivered` in the
project log after its toast is gone — the log is the record, the toast is the notice.

---

## Verification

`dev/drive-toast-stack.mjs` drives the **real** `<Toasts>` through `dev/toast-preview.html`
(not a copy) — Mission Control / Mr Pink / 1984, light **and** dark. Shots in
`/tmp/operator-shots/toast-stack/`.

Per palette: burst 4+1 → **2 cards**, `×4` chip present, `Show latest` present, Dismiss all
present · Dismiss all → **0 remaining** · 7 distinct → **4 cards + "+3 earlier"** · stack
bottom **368px of 820**.

**One real defect found by the contrast probe.** The `×N` chip originally used an
`--overlay-subtle` fill. That reads fine on the dark palettes, but on light ones the wash drags
the chip's backdrop *toward* `--fg-muted`: **2.85:1 on Mr Pink light, 2.94:1 on 1984 light** —
under the 3:1 floor for supporting ink. Changed to a transparent chip with a `1px var(--border)`
hairline, so the ink keeps the card's own backdrop. Now **3.17–5.70:1** across all six.

| Palette | ×N chip | Dismiss all | +N earlier |
|---|---|---|---|
| Mission Control dark | 5.19 | 5.63 | 5.63 |
| Mission Control light | 3.49 | 3.84 | 3.84 |
| Mr Pink dark | 5.70 | 6.22 | 6.22 |
| Mr Pink light | 3.17 | 3.48 | 3.48 |
| 1984 dark | 4.87 | 5.13 | 5.13 |
| 1984 light | 3.27 | 3.57 | 3.57 |

Also fixed on inspection of the shots: the `×N` chip was a flex sibling of the headline, so it
anchored to the card's right edge and floated away from any headline that wrapped. It is now
inline, immediately after the sentence it counts.

House rules held: semantic vars only, no hardcoded colour, no accent fill, no focus ring, no
coloured left-border stripe, no group opacity, no opacity stacked on `--fg-muted`, no
colour-changing border on a rounded element (the hairline is static `var(--border)`).

---

## Notes for whoever picks this up

- Thresholds are exported — `MAX_VISIBLE` (4) and `DISMISS_ALL_THRESHOLD` (2) in `Toast.tsx`.
- The overflow marker renders as a `<div>`, not a disabled `<button>` — it is a statement, not a
  control, and a disabled button would put a dead tab stop in the stack.
- `dev/drive-toast-stack.mjs` is a permanent gate: `npx vite --port <free>` then
  `MOCK_PORT=<port> node dev/drive-toast-stack.mjs`. It fails loudly on card counts, the cap,
  the marker text, contrast floors, and the aria-name collision.
- The cause of the pile-up remains the Code lane's `dev/briefs/2026-08-06-false-undelivered-toasts.md`.
  This change is the affordance only; it makes any future burst survivable, not rarer.
