// THE HEADER BAND — one height, for every strip that draws a rule across the top of a panel.
//
// It exists because two of them drifted and a COMMENT covered for it: `CanvasPanel`'s tab row was
// 36 with a note saying "same 36px height … as the main panel's SessionToolbar", and the toolbar
// had since become 44. So when the right panel opened there were two horizontal rules 8px apart
// across one window, and the file that would have told you asserted the opposite.
//
// Two numbers that happen to match today is not the fix; one number is. Anything that draws a
// header band with a `borderBottom` imports this — if a band ever genuinely needs a different
// height, that is a decision to write down here, not a literal to type into a component.
//
// It lives in `lib/` so the session components and `AppShell` can all reach it without one
// importing another.

/** 44. The toolbar is the band with a content FLOOR — it carries chips sized from `CHIP_H` plus
 *  padding — so it sets the height and the roomier rows follow it. The tab rows have slack; a
 *  content floor does not.
 *
 *  Every band pairs this with `boxSizing: 'border-box'` and centres by FLEX, never by
 *  line-height: the 1px `borderBottom` is inside the box, and a line-height centring drifts the
 *  moment the font does. */
export const TOOLBAR_BAND_H = 44

/** 30 — the SECOND tier: a header band INSIDE a panel (the plan's title row, the preview's URL
 *  bar, the conversation's own head). Shorter on purpose; it sits under a toolbar band rather
 *  than beside one, so it is a sub-head and reads as one.
 *
 *  Named for the same reason as the one above, not because it drifted: three components had typed
 *  `30` independently, which is the identical setup — three numbers that agree until one of them
 *  is edited by someone who cannot see the other two. Nothing moved when this was introduced. */
export const PANEL_SUBHEAD_H = 30

/** THE FILL FOR A SURFACE DROPPED INTO A BLOCK SLOT — and both of this app's slots are blocks.
 *
 *  The main view mounts Chat / Files / Preview into a `position: absolute; inset: 0;
 *  overflow: hidden` div that covers the still-mounted terminal without resizing it. The right
 *  panel mounts its tab into a `flex: 1; minHeight: 0` div. Neither is `display: flex`, so a
 *  surface that asks for its height with `flex: 1` alone gets NOTHING: it sizes to its content,
 *  grows past the slot, and the slot clips it.
 *
 *  The Files view shipped that way in 0.18.0, in both placements. With no bounded height anywhere
 *  down the chain, neither the tree nor the file viewer's scroller ever overflowed — so neither
 *  could scroll, by wheel or by key, and everything below the fold was unreachable. It reads as
 *  "scrolling is broken"; it is really "nothing knows how tall it is".
 *
 *  An EXPLICIT height is the fix. `flex: 1` stays alongside it, harmless and correct for any
 *  parent that IS a flex column. `chrome.test.ts` holds every such surface to it. */
export const SURFACE_FILL = { flex: 1, height: '100%', minHeight: 0, minWidth: 0 } as const
