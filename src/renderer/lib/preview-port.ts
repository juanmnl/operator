import type { SessionPort } from '../../shared/types'

// WHICH server the Preview shows, and at WHAT path. Pure, so both decisions are unit-tested.
//
// Two bugs shaped this file:
//
// 1. **The wrong server.** The old rule was "prefer the reserved port when the session is serving
//    on it, else the lowest", under a comment claiming the backend had already established that
//    every port belonged to this session. It had not — the reserved port was reported whenever
//    ANYTHING was listening on it, so a stale orphan or a sibling lane squatting 1422 was shown
//    as this lane's app. The backend now says how confidently each port is attributed, and the
//    rule below is written in those terms: **sniffed beats reserved, and foreign is never shown.**
//
// 2. **No subpages.** The target was a bare port, so there was no way to preview `/admin` — and
//    when the server's port changed, any path the user had reached was lost with it. The target
//    is now `{port?, path}`, the path survives a port change, and a full external URL is still
//    accepted for previewing something that is not a localhost dev server at all.

/** Where the preview is pointed. `url` is set only for an external target (a full URL the user
 *  typed); otherwise the port is chosen from the lane's servers and `path` is appended. */
export interface PreviewTarget {
  /** Pinned port. Absent = "whatever this lane is serving on". */
  port?: number
  /** Always starts with `/`, or is empty. Never carries the query-less trailing slash a user did
   *  not type — `/` and `` address the same page and the box should show what was typed. */
  path: string
  /** A full off-localhost URL, which takes over entirely. */
  url?: string
}

export const EMPTY_TARGET: PreviewTarget = { path: '' }

/** The port in an http(s) URL, or null when it has none / the URL is unparseable. */
export function portOf(url: string | null): number | null {
  if (!url) return null
  try {
    return Number(new URL(url).port) || null
  } catch {
    return null
  }
}

/** Parse what the user typed into the address box.
 *
 *  Everything it accepts, because the box is one field doing four jobs:
 *
 *    `5173`               → port only
 *    `5173/admin`         → port + path
 *    `/admin`             → path only, keep whatever port is being served
 *    `localhost:5173/x`   → port + path
 *    `https://app.co/x`   → an external target, taken whole
 *
 *  A BARE NUMBER IS A PORT, not a path. `3000` typed into a browser bar would be a search; typed
 *  into this box it is unambiguously the thing the box is named for, and treating it as a path
 *  would make the common case the broken one. */
export function parseTarget(input: string): PreviewTarget {
  const raw = input.trim()
  if (!raw) return EMPTY_TARGET

  // A scheme means the user is pointing somewhere else entirely — take it whole and do not
  // second-guess it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      // A localhost URL is still one of ours: keep it as port+path so a later port change can
      // carry the path over, which is the whole point of storing them apart.
      if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port) {
        return { port: Number(u.port), path: normalizePath(u.pathname + u.search + u.hash) }
      }
      return { path: '', url: raw }
    } catch {
      return { path: '', url: raw }
    }
  }

  if (raw.startsWith('/')) return { path: normalizePath(raw) }

  const host = /^(?:localhost|127\.0\.0\.1):(\d+)(.*)$/.exec(raw)
  if (host) return { port: Number(host[1]), path: normalizePath(host[2]) }

  const portFirst = /^(\d+)(\/.*)?$/.exec(raw)
  if (portFirst) return { port: Number(portFirst[1]), path: normalizePath(portFirst[2] ?? '') }

  // Anything else is a hostname without a scheme (`app.example.com/x`). Give it one rather than
  // refusing — refusing teaches nothing and the user's intent is obvious.
  return { path: '', url: `http://${raw}` }
}

function normalizePath(p: string): string {
  if (!p || p === '/') return ''
  return p.startsWith('/') ? p : `/${p}`
}

/** What to show in the address box for a target. The inverse of `parseTarget` for everything the
 *  box can round-trip. */
export function formatTarget(t: PreviewTarget): string {
  if (t.url) return t.url
  if (t.port == null) return t.path
  return `${t.port}${t.path}`
}

/** Which of the lane's servers to preview when nothing is pinned.
 *
 *  SNIFFED FIRST, always. A port the lane announced in its own output is the only kind we have
 *  proof about; a reserved port is an inference. When the two disagree — the dev server ignored
 *  `PORT` and bound 5173 while something else answers on 1422 — the announced one is the app the
 *  user is working on.
 *
 *  Within a tier, the LOWEST port, so the pick cannot flip as the OS reorders sockets.
 *
 *  `foreign` is never eligible. That is the fix. */
export function pickPreviewPort(servers: readonly SessionPort[]): SessionPort | null {
  const byTier = (tier: SessionPort['attributed']) =>
    servers.filter((s) => s.attributed === tier).sort((a, b) => a.port - b.port)[0] ?? null
  return byTier('sniffed') ?? byTier('reserved') ?? null
}

export interface PreviewPick {
  /** What to load. `null` when there is nothing we can honestly show. */
  url: string | null
  /** Something IS answering on this lane's reserved port, but we cannot attribute it to this
   *  lane. The panel says so instead of silently showing a stranger's app. */
  foreign: boolean
  /** The port actually chosen, for the address box's placeholder. */
  port: number | null
}

/** The whole decision: pinned target first, then the lane's own servers, then the "not serving
 *  yet" fallback.
 *
 *  `reservedUrl` is the hint Operator handed the lane at spawn. With nothing discovered it is
 *  still what the empty state should name — "your server isn't up on 1422 yet" is a useful
 *  sentence and a blank panel is not. */
export function pickPreviewUrl(
  servers: readonly SessionPort[],
  reservedUrl: string | null,
  target: PreviewTarget = EMPTY_TARGET,
): PreviewPick {
  const foreign = servers.some((s) => s.attributed === 'foreign')

  // An external target takes over completely — it is not one of this lane's servers and none of
  // the attribution above applies to it.
  if (target.url) return { url: target.url, foreign: false, port: null }

  // A pinned port is the user overruling us, including overruling `foreign`: they may well know
  // that the thing on 1422 IS what they want to look at.
  if (target.port != null) {
    return { url: `http://localhost:${target.port}${target.path}`, foreign: false, port: target.port }
  }

  const picked = pickPreviewPort(servers)
  if (picked) return { url: `http://localhost:${picked.port}${target.path}`, foreign, port: picked.port }

  // Nothing attributable. If something foreign is answering we must NOT fall back to the reserved
  // url — that is precisely the port the stranger is on, and loading it is the original bug.
  if (foreign) return { url: null, foreign: true, port: null }

  const reserved = portOf(reservedUrl)
  if (reserved == null) return { url: reservedUrl, foreign: false, port: null }
  return { url: `http://localhost:${reserved}${target.path}`, foreign: false, port: reserved }
}
