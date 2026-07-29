# Stacked `opacity` on `--fg-muted` — sweep + guard

**Done 2026-07-28.** 66 violations cleared across 23 files, and the rule is now enforced by
`npm test` instead of by review.

## The guard (the point of the task)

`src/renderer/lib/muted-opacity.guard.test.ts` — runs in `npm test`, no browser, ~13ms.

It parses every `style={{ … }}` object in `src/renderer/**/*.tsx` and fails when one both
colours its text `var(--fg-muted)` **and** sets a partial `opacity`.

Four things it deliberately does:

- **Strips comments first**, so the prose explaining this rule (`PageShell`, `Sidebar`,
  `InstructionsSection`, and this file's own header) doesn't trip it. The brief called this out.
- **Matches whole style objects, not lines.** The original grep counted lines carrying both
  tokens; a style object is the unit the rule actually applies to, which is why this found 66
  where the line-grep found 63.
- **Treats `0` and `1` as not-a-fade.** `opacity: hover ? 1 : 0` is a reveal, not a recede, and
  stays legal. Any value strictly between 0 and 1 is the violation, including inside a ternary.
- **Asserts the glob resolved >30 files.** A guard that reads nothing passes vacuously — that is
  the failure mode that would quietly return us to sweeping by hand.

Reads sources through `import.meta.glob('../**/*.tsx', { query: '?raw' })` rather than
`node:fs`, so it needs no `@types/node` in the renderer tsconfig.

**Proven to catch:** reintroducing a single `opacity: 0.55` in `RecentLists.tsx` fails the test
with the exact file:line. Restored, it passes.

**Scope:** the guard fails only on muted *ink* (`color:`). A muted **border** or **fill** beside
an opacity is a weaker case — real, but not what the rule says — so it is judged by eye rather
than failed automatically. Worth revisiting if it starts recurring.

## The sweep

**57 unconditional fades** (`opacity: 0.4`–`0.85` on muted text) removed mechanically. Heaviest:
`DiffPanel` (6), `CommandPalette` (6), `AgentLibraryView` (5), `SessionInfoBar` (5),
`PluginsSection` (4), `RecentLists` (3), `Sidebar` (3).

**9 conditionals judged individually:**

| Site | Was | Now | Why |
|---|---|---|---|
| `AgentsHubView:244`, `ProjectGallery:319` | `hover ? 0.9 : 0` | `hover ? 1 : 0` | Reveals, kept as reveals — but the *visible* half must be full strength; 0.9 on muted was still a stacked fade. |
| `AgentLibraryView` tool chip | `on ? 1 : 0.7` | removed | Off-state is already `--fg-muted`; the token is the difference. |
| `GeneralSection` read-only | `isReadOnly ? 0.5 : 1` | removed | The inputs are genuinely disabled; the fade only pushed the label under the floor. |
| `ChatComposer` IconBtn + Pill | `disabled ? 0.4 : 1` | removed | Disabled only when there is no live session, and the composer already says "No live session". |
| `PlanPanel` done item | `done ? 0.6 : 1` | removed | Done already reads from muted ink + strike-through. |
| `TaskQueue` assignee chip | `role ? 1 : 0.5` | removed | Unassigned already reads from the word "Unassigned". |
| `SessionItem` close × | `confirmingClose ? 1 : 0.5` | removed | Confirm state changes the glyph (`×` → `×?`) and the background. |

**Kept deliberately** (not violations — the alpha is not on muted ink):

- `SessionToolbar:153,173` — `opacity` on `var(--fg)`, not muted. Legal.
- `RosterPanel:248,300` — `dragId === role.id ? 0.45 : 1` on a **drag ghost**. This is the
  group-opacity-on-a-card pattern the brief asks about, but it is *transient drag feedback*, not
  a resting recede: it exists only while the pointer holds the card. Reporting it here as asked
  rather than changing it; if the rule is meant to cover drag ghosts too, that is a one-line
  change in both places.
- Assorted `opacity` on backgrounds/swatches/borders (e.g. `PrefsView` theme swatches) — not ink.

## Verification

- `npm test` — 228 tests, 31 files, including the new guard.
- `dev/drive-theme-pass.mjs` across all six palettes: **0 below floor** (4.5:1 body, 3:1 meta).
- `tsc --noEmit` clean.

## What this does not fix

The guard prevents *reintroduction* in `src/renderer`. It does not measure contrast — the
six-palette sweep still does that, and still needs running when tokens or backdrops change. It
also cannot see a muted colour composed at runtime (a variable holding `var(--fg-muted)`), which
is why it flags on the literal token only.
