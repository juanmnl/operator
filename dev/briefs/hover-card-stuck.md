# Sidebar hover cards stick on screen ("tooltips hanging")

**Reported:** 2026-07-28, live app, second sighting ("still hanging from time to time").
Screenshot: `/tmp/operator-shots/2026-07-28-tooltip-hang.png` — **two cards visible at once**,
frozen mid-screen over the transcript, neither under the cursor. Contents were stale lane tasks.

These are not native tooltips. They are the fixed-position lane hover cards:
`SessionItem.tsx:370` and `SidebarRail.tsx:216` (both `position:'fixed'`, `maxWidth:260`).

## Diagnosis

`SessionItem` was **already hardened once** for this class of bug — see the comment at
`SessionItem.tsx:75-83`. That fix addressed *rows moving under a stationary cursor*: a reorder
slides the row away with no `mousemove` and therefore no `mouseleave`, so `syncHover` re-verifies
after every render by hit-testing the last known pointer position with `elementFromPoint`.

**The blind spot is the exact complement: the cursor leaving the window while the row stays put.**

- `onMouseEnter` seeds `pointerRef` (`:149`); the `mousemove` listener only updates it while hovered
  (`:103`).
- If the pointer exits the document — ⌘Tab to another app, cursor flicked off-window, focus lost
  while stationary over a row — no further `mousemove` arrives, and WKWebView does not reliably
  deliver `mouseleave` in those transitions.
- `syncHover` then hit-tests a **stale in-window coordinate that is still over the row**, so
  `el.contains(hit)` is true, hover is re-confirmed, and the card is repositioned rather than
  dismissed. It never expires.

That also explains two cards at once: hover row A → leave the window (A sticks) → later hover row B
→ leave again (B sticks).

`SidebarRail` (`:71`, `:180-190`) has the same fixed-card pattern with **none** of the
`elementFromPoint` re-verification — it trusts enter/leave alone, so it is exposed to both the
original failure and this one.

## Fix

1. **Dismiss on pointer-left-the-document.** `mouseout` on `document` with a null `relatedTarget`
   is the reliable signal; `window` `blur` and `visibilitychange` cover app switches where no mouse
   event arrives at all.
2. **Treat an unfocused document as no-hover** inside `syncHover` — if `document.hasFocus()` is
   false, the cursor is not meaningfully over anything.
3. **Enforce one card app-wide.** Two simultaneous cards is a state no correct implementation
   should permit, so make it structurally impossible rather than relying on every dismissal path
   firing: a single shared hover owner (module-level or context) that a new card claims, evicting
   the previous holder. This turns any *future* leak into a self-healing bug instead of a pile-up.
4. **Share one implementation between `SessionItem` and `SidebarRail`.** They are the same widget
   with two copies of the logic and only one of them hardened; the rail will otherwise keep
   drifting behind. Extract the hover-card behaviour once and use it in both.

Do not fix this with a dismissal timeout alone — a card that vanishes while genuinely hovered is a
new bug, and a timeout hides the state error rather than removing it.

## Verify

Reproduce headlessly against the mock harness (`npx vite --port <free>`, **not** 1433): hover a
lane row, then dispatch `document.dispatchEvent(new MouseEvent('mouseout', {relatedTarget: null}))`
and a `window` blur, and assert no card remains in the DOM. Add a case for the original regression
too — reorder the list under a stationary cursor and assert the card follows or dismisses. Cover
both `SessionItem` and `SidebarRail`.
