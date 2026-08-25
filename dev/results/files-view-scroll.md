# Files view could not be scrolled — fixed (both placements)

**Date:** 2026-08-25 · **Branch:** `operator/51cf00`
**Files:** `src/renderer/lib/chrome.ts`, `src/renderer/lib/chrome.test.ts` (new),
`src/renderer/components/files/{FilesView,FilesPanel,FileTree}.tsx`,
`dev/drive-files-scroll.mjs` (new)

## The cause — not an overflow rule

Nothing was swallowing wheel events, and no scroller was missing `overflow-y`. **Nothing in the
chain had a bounded height.**

`DashboardView` mounts the main-view surfaces into a plain block:

```
<div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>   ← NOT display:flex
```

`FilesView`'s root asked for its height with `flex: 1`, which a block parent ignores. The root
therefore sized to its **content**, grew past the overlay, and the overlay's `overflow: hidden`
clipped the excess. With the root unbounded, the tree column's `overflow: auto` and CodeMirror's
`.cm-scroller` never overflowed either — `scrollHeight === clientHeight` on both — so there was
nothing to scroll, by wheel or by key, and everything below the fold was unreachable.

`CanvasConversation` (Chat) says `height: '100%'` on its root, which is why Chat never showed it.

**The same bug in the second placement.** Driving the fix surfaced it: the right panel's Files tab
lands in `CanvasPanel`'s `<div style={{ flex: 1, minHeight: 0 }}>` — also a **block** — and
`FilesPanel`'s root was sized the same way. Measured before the fix: `.cm-scroller` 6831/6831,
i.e. the panel's viewer could not be scrolled either. Reported as one bug, it was two instances of
one cause.

## The fix

`lib/chrome.ts` gains `SURFACE_FILL = { flex: 1, height: '100%', minHeight: 0, minWidth: 0 }`,
next to the header-band constants and documented with the failure it prevents: **both** of this
app's mount slots are blocks, so a surface must state an explicit height; `flex: 1` stays for the
placements whose parent is a flex column. `FilesView` and `FilesPanel` both spread it on their
root.

Two smaller things, both required by the brief's "verify keyboard scroll":

- **`tabIndex={-1}` on the tree column** (`outline: 'none'`, so the app's no-focus-ring rule
  holds). A plain div takes no focus, so the tree could be wheeled but never paged from the
  keyboard. `-1` rather than `0` keeps it out of the tab order — CodeMirror does exactly this to
  its own scroller (`scrollDOM.tabIndex = -1`), which is why the viewer needed no change.
- **`data-files-view` / `data-files-panel` / `data-file-row`** for the driver, matching the
  `data-session-row` / `data-preview-host` convention already in the tree.

## Reproduction and verification — `dev/drive-files-scroll.mjs`

Playwright/WebKit against the real renderer on the mock harness at 1440×900. The mock bridge has
no `fileTree`/`fileRead`, so the driver supplies them (60-entry root, 400-line file) by wrapping
the `window.operator` setter, the way `drive-rail-fold.mjs` does.

**Before the fix — the bug, measured:**

```
FAIL S1  — FilesView 1238px inside a 798px overlay
FAIL S2a — tree scrollHeight 1208 > clientHeight 1208      (equal: nothing to scroll)
FAIL S2b — wheel moved the tree to scrollTop 0
FAIL S3a — cm-scroller scrollHeight 6831 > clientHeight 6831
FAIL S3b — wheel moved the viewer to scrollTop 0
FAIL S4a/S4b — PageDown moved nothing
5/12 checks passed
```

**After:**

```
PASS S1   — FilesView 798px inside a 798px overlay
PASS S2a/b/c — tree 1208/768, wheel → scrollTop 400, last row reachable
PASS S3a/b/c — viewer 6831/744, wheel → 600, and back to 0
PASS S4a  — PageDown moved the viewer to scrollTop 704
PASS S4b  — PageDown moved the tree to scrollTop 440
PASS S5a  — Console still renders its terminal
PASS S5-Chat / S5-Preview — both still fill the overlay without overflowing
PASS S6a/b — panel Files fits its block slot, and its viewer scrolls (752/6831)
14/14 checks passed
```

Both wheel and keyboard are verified, in both placements; Console, Chat and Preview are asserted
unchanged in the same run.

## The test — `src/renderer/lib/chrome.test.ts`

jsdom has no layout engine, so the layout itself can only be measured in the driver above. What
`npm test` can hold is the rule that would have prevented it: every surface mounted into a block
slot must declare an **explicit height** on its root. Same shape as `muted-opacity.guard.test.ts`
— sources through `import.meta.glob`, comments stripped (a comment naming the rule is exactly how
a guard passes over the code it was written to fail), and the match confined to the **root** style
object, since an inner pane saying `height: '100%'` proves nothing about the box the slot
measures.

Proven in both directions: with `FilesView`'s root put back to `flex: 1` alone the guard fails
(`components/files/FilesView.tsx declares an explicit height`); with the fix it passes. 7 tests.

## Verification

- `npx tsc --noEmit` exit 0.
- `npm test` → **917 pass**, 33 fail across 5 files (`forgotten projects`, `ghost probe`, rail-fold
  `persistence`). Those 33 are **pre-existing** — same count and same files on the untouched tree
  before this change; jsdom/localStorage-environment failures in files this diff does not touch.
- `node dev/drive-files-scroll.mjs` → 14/14.

## Notes / left out

- **Port.** The session's reserved 1421 was already occupied by another process (a server that
  404s on `/`, not this app), so the harness ran on **1460**. `MOCK_PORT` overrides it, as with
  every other driver here.
- **Not fixed, worth knowing:** `CanvasPanel`'s body div (`flex: 1; minHeight: 0`) is a block, and
  that is the trap `FilesPanel` fell into. Making it `display: 'flex'` would remove the trap for
  every panel tab at once, but it changes the layout contract for tabs I have not exercised
  (Plan / Diff / Chat / Inbox), so I fixed the surface rather than the slot and put the slot on
  the guard's list instead. Say the word if the slot should change.
- Untouched: the terminal panes, the main-view overlay itself, and every other surface's sizing.
