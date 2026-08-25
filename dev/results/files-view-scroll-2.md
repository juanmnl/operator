# Files view, round 2 — what was actually wrong

Two separate things, and only one of them was a bug in the code.

---

## 1. The vertical scroll was already fixed. The app you are running predates the fix.

`6cf4495` is correct and it works. The build on disk does not contain it:

```
/Applications/Operator.app   CFBundleShortVersionString 0.18.1
Contents/Resources/app.asar  built  Aug 25 08:53:19 2026
6cf4495                      authored  Aug 25 09:25:59 2026   ← 32 minutes later
```

Unpacking that asar and reading the bundled renderer settles it — the packaged `FilesPanel` root is

```js
a.jsxs("div",{ref:s,style:{flex:1,          // ← and nothing else
```

`flex: 1` alone, no `height: "100%"`, and no `data-files-panel` attribute at all. That is the
pre-fix source, verbatim. Every symptom of the original bug is therefore still on screen in that
window, and will be until the app is rebuilt from a tree containing `6cf4495`.

I have not rebuilt or reinstalled anything — that is your call, and there is a live fleet attached
to the running instance.

## 2. The horizontal overflow is real, and `6cf4495` never touched it.

It is not a regression from the scroll fix; it is a deliberate decision in `cm-theme.ts` that this
brief overturns. The comment there read:

> Long lines scroll horizontally; they never wrap. Wrapping renumbers nothing but destroys the
> one-line-one-number contract a deep link depends on.

The premise is wrong. CodeMirror 6's `lineWrapping` wraps a LOGICAL line across several visual
rows and the gutter still prints exactly one number for it, beside the row the line starts on. So
the addressing scheme a deep link depends on is untouched — verified on screen at both widths,
gutter reads 1,2,3…8,9 with line 8 occupying six visual rows.

Measured before, main-view placement at a 1440px window: `.cm-scroller` `clientWidth 912`,
`scrollWidth 2337`. Two and a half panes of content, reachable only by dragging sideways.

### Fix

- `EditorView.lineWrapping` in `FileViewer`.
- `.cm-content { overflow-wrap: anywhere }` in the theme — wrapping alone still leaves a token
  with no break opportunity (a base64 blob, a minified bundle, a long URL) pushing the line out.
- `.cm-scroller` keeps `overflow-x: auto` rather than `hidden`: if something genuinely cannot be
  broken, being wide is honest and being clipped is not.
- `FileTree` caps drawn indent at 8 levels. 12px a level in a 240px column means a deep path
  eventually spends the row on whitespace and pushes the name out; the `title` still carries the
  full path.

Measured after, same window: `clientWidth 912`, `scrollWidth 912`. At 900px: `372 / 372`. The
document itself never scrolls sideways at either width.

## 3. Found while verifying — the footer wrapped and pushed the surface out of its own box

Not reported, and visible at any width where the file's stats stop fitting on one line. The
viewer's footer is a 24px flex row of loose `<span>`s; each one shrank below its own text and
wrapped, so the row grew to two lines, overlapped the last line of code, and made the surface 2px
taller than the box it sits in (measured `scrollHeight 800` in a `clientHeight 798` root at 900px).

The metadata now lives in its own shrinkable, clipping, `nowrap` box, and the `Ask the lane →`
action is `flexShrink: 0`. At a narrow width the byte count is what disappears; the action never
moves. Measured after: `798 / 798`.

## 4. Hardening — the slots, not each surface

`SURFACE_FILL` fixes the surfaces by having each one state `height: 100%`. That works, but only
because every ancestor happens to have a definite height: a percentage height silently falls back
to `auto` the moment one does not, and the failure is invisible until someone tries to scroll.

Both mount slots are now flex columns:

- the main view's absolute overlay in `DashboardView`
- the right panel's body div in `CanvasPanel`

which makes the `flex: 1` every surface already declares mean something — for these tabs and for
the next one added. `SURFACE_FILL` stays; the two are belt and braces, and the existing guard test
still holds every surface to it. Column rather than row, so a child still stretches to full width
exactly as it did under a block — Chat and Preview lay out unchanged, asserted by S5.

---

## Verification

`dev/drive-files-scroll.mjs`, extended: the fixture now has lines far wider than any pane (a
fixture whose lines all fit cannot tell a wrapping viewer from a sideways-scrolling one), a new
S7 group measures the horizontal axis and the surface's own vertical overflow, and the viewport
width is a parameter.

```
W=1440 node dev/drive-files-scroll.mjs   18/18
W=900  node dev/drive-files-scroll.mjs   18/18
```

Both placements, both axes, wheel and keyboard, Console/Chat/Preview asserted unchanged. Run
against WebKit (the driver's engine) and re-measured independently under Chromium, which is what
the Electron shell actually renders in — same numbers.

Screenshots taken at both widths: wrapping holds, one gutter number per logical line, the footer
is one line at 900px, and the body scrolls (the wide capture is at line 55 after a wheel).

`tsc --noEmit` clean. +4 static guards in `chrome.test.ts` (the two slots are flex columns;
`lineWrapping` and `overflow-wrap` are present). Root suite 928 passing; the 33 failures are
pre-existing and unrelated (`localStorage` undefined in several suites — identical on the main
checkout).

**Not verified in the installed app**, for the reason in §1: the binary in `/Applications` is
older than the fix. The verification above is the dev renderer under the real browser engines, at
two widths, measured rather than eyeballed.

Port note: the session's reserved port 1425 was already held by another project's vite
(`enfant-terrible`), so the harness ran on 1461. Nothing was killed.

## Diff summary

| File | Change |
|------|--------|
| `src/renderer/components/files/FileViewer.tsx` | `EditorView.lineWrapping`; footer metadata in a clipping nowrap box, action `flexShrink: 0` |
| `src/renderer/components/files/cm-theme.ts` | `overflow-wrap: anywhere`; the no-wrap rationale replaced |
| `src/renderer/components/files/FileTree.tsx` | indent capped at 8 levels |
| `src/renderer/views/DashboardView.tsx` | main-view overlay is a flex column |
| `src/renderer/components/session/CanvasPanel.tsx` | right-panel body is a flex column |
| `src/renderer/lib/chrome.test.ts` | globs `.ts` too; +4 guards |
| `dev/drive-files-scroll.mjs` | wide-line fixture, `W` parameter, S7 horizontal group (18 checks) |
