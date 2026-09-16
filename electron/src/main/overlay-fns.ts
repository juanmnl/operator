// The renderer's pure functions, as source for the page inside the Preview's inspect view. The
// overlay script (`src/shared/preview-overlay.js`) draws the layout grid and redlines with them, so
// the page and the renderer run the same code and cannot disagree about a column or a distance.
import { layoutGrid, gridInk } from '../../../src/shared/layout-grid'
import { measureBetween, formatPx, placeChip, describeRelation } from '../../../src/shared/redlines'

/** Defines `window.__operatorOverlayFns` in the page. Each function is self-contained by contract
 *  (see the files they come from), which is what makes `String(fn)` a working copy. */
export const OVERLAY_FNS_JS = `
;window.__operatorOverlayFns = {
  layoutGrid: ${String(layoutGrid)},
  gridInk: ${String(gridInk)},
  measureBetween: ${String(measureBetween)},
  formatPx: ${String(formatPx)},
  placeChip: ${String(placeChip)},
  describeRelation: ${String(describeRelation)},
};
`
