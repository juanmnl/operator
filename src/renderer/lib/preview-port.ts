// Pure port-selection logic for the Preview panel, extracted from AppPreviewPanel so the
// choice of WHICH server to show is unit-testable. The panel keeps the polling/effects.
//
// Background: a session can serve on several ports (a web server plus an API). The backend
// attributes them from the session's own candidate set — the port Operator reserved for it
// plus the ones its own output announced — so every port here belongs to THIS session. But
// we still have to pick one to display when the user hasn't pinned a choice, and that pick
// has to be stable.

/** The port in an http(s) URL, or null when it has none / the URL is unparseable. */
export function portOf(url: string | null): number | null {
  if (!url) return null
  try {
    return Number(new URL(url).port) || null
  } catch {
    return null
  }
}

/** Which of a session's live servers to preview when nothing is pinned.
 *
 *  Prefers the RESERVED port when the session is actually serving on it (the dev server
 *  followed Operator's instruction); otherwise the lowest-numbered one. Lowest — rather
 *  than "first" — because the pick must not flip as the OS reorders its socket list; the
 *  backend already sorts, and this keeps the guarantee explicit and tested.
 *
 *  With nothing discovered it falls back to `reservedUrl`, which renders the correct
 *  "not serving yet" empty state instead of a blank panel. */
export function pickPreviewUrl(
  servers: number[],
  reservedUrl: string | null,
): string | null {
  if (!servers.length) return reservedUrl
  const reserved = portOf(reservedUrl)
  const pick = reserved && servers.includes(reserved) ? reserved : Math.min(...servers)
  return `http://localhost:${pick}`
}
