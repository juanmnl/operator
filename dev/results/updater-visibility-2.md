# Updater visibility, part 2 — the two surfaces that were not listening

**Date:** 2026-08-25 · **Lane:** Code · **Base:** fresh worktree on `origin/main` @ `d22538b`
(0.18.1) · **Branch:** `code/updater-visibility-2`

`onUpdateProgress` / `onUpdateError` have existed since 0.18.1 and `DashboardView` subscribed to
them, but the two controls that actually offer the install did not. Both now do.

## What changed

**`src/renderer/lib/update-install.ts` (new)** — the install as a pure state machine. It exists
because the state it replaces was `useState(false)`, and a boolean set true on the press and
never set back cannot tell a running download from a finished one from one that died in its first
second. All three rendered as `Installing…`, forever. It also exists *here* rather than inside
either component because both surfaces need the same answers, and because the renderer suite has
no DOM renderer — the parts worth pinning are transitions, not markup.

```
idle ──press──► downloading(0%) ──ticks──► downloading(n%) ──100%──► installing
  ▲                   │                          │
  └──── (retry) ──── failed ◄────── error ───────┘
```

Decisions inside it, each of which a test pins:

- **100% is the handover, not a full bar.** Nothing arrives on the channel after it and the quit
  pre-empts the next render, so `downloading(100)` would be the same permanent-`Installing…` bug
  wearing a different number. It becomes `installing`, which now finally means what it says.
- **Percent is monotonic.** electron-updater recomputes it per chunk over a stream whose length
  it re-learns across a 302; a bar that jumps backwards reads as a fault in the app, not the
  number.
- **A tick from `idle` still shows the download.** The two controls drive ONE install: press the
  sidebar arrow, then open preferences, and preferences must not offer "Install & Restart" over
  bytes already moving.
- **A failure is pressable again**, and a retry's first tick clears it. Most causes are transient
  (dropped connection, full disk, a feed that 502'd) and the alternative to retrying in place is
  quitting the app. The label becomes `Retry v0.18.2 & Restart` — a verb, not a noun.
- **An empty message still says something actionable**, or we are back to a button that did
  nothing.

**`PrefsView.tsx`** — subscribes on mount (not on the press, for the reason above), and the
button's own fill is the progress bar: a `linear-gradient` stop at `percent`, no separate track,
since the button is already accent across its full width. `minWidth: 168` + tabular numerals so a
changing percent does not nudge the label. The status line beside it shows
`65.0 MB of 130.0 MB` while downloading and `<message> — see ~/.operator/updater.log` on failure,
in `--color-error`; `installStatus` returns null at rest, which is when the check's own words
("You're up to date.") show through unchanged.

**`ProjectRail.tsx`** (the `RailFoot` arrow) — downloading is a *state of the existing button*,
not a second control and not a new row: the ring is already there and already the accent, so a
`conic-gradient` sweeps it to `percent` inside the same 14px circle with the arrow held in place.
Nothing moves and nothing is added to the foot, which is the only way progress fits a strip whose
entire budget is 14px. Failure turns ring and arrow to `--color-error` and stays pressable.
`role="progressbar"` + `aria-valuenow` while downloading, and the tooltip carries every state's
sentence. The unfilled remainder is `color-mix(… 20%, transparent)`, **not** opacity on the
element — dimming the element would take the arrow and the ring with it.

**`DashboardView.tsx`** — holds the `InstallState` (it already had the subscription) and passes it
to the rail; its toasts are unchanged at 25% steps, because a toast is a moment and a download is
a duration. Its toast action and the rail arrow now share one `startInstall`, so both move the
same state.

## Tests

`src/renderer/lib/update-install.test.ts` — **15 tests**, matching the house style (pure module
under `lib/`, like `toast-stack.test.ts`; there is no `@testing-library/react` in this repo, so
component-render tests are not an option here). Every case is one the boolean could not express:
the optimistic 0%, the monotonic floor, 100%-is-handover, a nonsense percent, a tick with no
local press, a retry clearing a failure, an empty message, and each surface's rendered strings.

## Verification

| | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npm run build` | clean |
| `npm test` (renderer) | **33 failed / 971 passed** |
| baseline on the same checkout, changes stashed | **33 failed / 956 passed** |
| `electron: npm run typecheck` | clean |
| `electron: npm test` | 381 passed |

The 33 failures are **pre-existing and unrelated** — identical count and identical tests before
and after, in `forgotten-projects.test.ts` and `ghost-probe.test.ts` (localStorage/xterm-DOM
suites). My change adds exactly the 15 new passes.

**Not GUI-verified.** Per the standing constraint, running the app is the user's; the progress
ring, the gradient fill and the error colour have not been seen in a real window. The states are
reachable with `OPERATOR_UPDATE_FEED` pointed at a local feed.

## Left out, deliberately

- **The Tauri bridge (`src/operator-bridge.ts`) implements neither event.** Both are optional in
  `env.d.ts`, so under Tauri both surfaces simply stay at their idle labels — no worse than
  today. Wiring it is not worth it for a shell being retired.
- **No retry limit / backoff.** A failure is pressable again with no cooldown; a user holding
  down a retry against a dead feed will just get repeated failures. Correct-but-annoying beats a
  cooldown that locks someone out of a transient fix.
