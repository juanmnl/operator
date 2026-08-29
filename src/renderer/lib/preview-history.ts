// Back / forward for the preview — and what they can HONESTLY do.
//
// `dev/results/preview-address-bar-design.md` §7, finding #5: the preview is a cross-origin
// iframe, so `contentWindow.history` throws. The panel's own code already conceded it — "the URL
// WE loaded, not any in-app navigation the user did afterwards".
//
// So these walk **the addresses this bar loaded**, and the design is emphatic that the UI must
// say so:
//
//   > the alternative — a control that looks like a browser's back button and silently behaves
//   > differently — is worse than not shipping it.
//
// Pure, and a plain stack rather than a cursor into an array, because the one operation that is
// easy to get wrong is what a NEW address does to the forward entries.

export interface PreviewEntry {
  /** Port, or null for an external URL. */
  port: number | null
  path: string
  /** Set only for an external target. */
  url?: string
}

export interface PreviewHistory {
  entries: PreviewEntry[]
  /** Index of the current entry, or -1 when the history is empty. */
  index: number
}

export const emptyHistory = (): PreviewHistory => ({ entries: [], index: -1 })

/** §7's cap. A preview bar is not a browser; fifty is far past the point anyone walks back to. */
export const HISTORY_CAP = 50

const same = (a: PreviewEntry, b: PreviewEntry): boolean =>
  a.port === b.port && a.path === b.path && a.url === b.url

/** Record an address the bar actually loaded.
 *
 *  A NEW ADDRESS TRUNCATES THE FORWARD ENTRIES, exactly like a browser: having gone back twice
 *  and then navigated somewhere else, the two you skipped are not reachable any more, and keeping
 *  them would make `forward` jump somewhere the user never chose from here.
 *
 *  Re-loading the SAME address is not a new entry. A reload, or a 3s re-ping that resolves to the
 *  same URL, must not fill the stack with duplicates — that is how `back` ends up doing nothing
 *  visible several times in a row. */
export function pushEntry(history: PreviewHistory, entry: PreviewEntry): PreviewHistory {
  const current = history.entries[history.index]
  if (current && same(current, entry)) return history
  const kept = history.entries.slice(0, history.index + 1)
  const entries = [...kept, entry].slice(-HISTORY_CAP)
  return { entries, index: entries.length - 1 }
}

export const canGoBack = (h: PreviewHistory): boolean => h.index > 0
export const canGoForward = (h: PreviewHistory): boolean => h.index >= 0 && h.index < h.entries.length - 1

/** Step back one address. A no-op at the start — the buttons disable by absence of ink rather
 *  than by grey chrome (§7), so this must be safe to call from a control that is still clickable. */
export function goBack(h: PreviewHistory): PreviewHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h
}

export function goForward(h: PreviewHistory): PreviewHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h
}

export const currentEntry = (h: PreviewHistory): PreviewEntry | null => h.entries[h.index] ?? null
