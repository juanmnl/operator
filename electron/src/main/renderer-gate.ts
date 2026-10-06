// Events main must not lose while the window has no renderer able to act on them.
//
// A lane's `OPERATOR-DISPATCH` / `OPERATOR-REPLY` line is parsed once by the tailer and emitted
// once (`transcript.ts`, `pending*.splice(0)`); the renderer is the only thing that routes it. A
// renderer that is dead (crash → recovery delay → load → mount) or has not rebuilt its lane tabs
// yet (the reattach in DashboardView) either drops the event or cannot find the lane that sent it,
// and nothing retries. Both happen on every crash reload and on every Cmd+R.
//
// So main holds these events from the moment the renderer goes away until the new one says its
// tabs are back (`rendererReady`), then hands them over oldest first.

/** More than this many held events means no renderer has been ready for a long time. The oldest
 *  are dropped so a window that never comes back cannot grow main without bound. */
export const HELD_LIMIT = 200

/** Held longer than this, an event is not routed on release. A crash reload takes seconds; an
 *  event older than this was held while the window was closed (macOS keeps the app and its lanes
 *  running), and routing it now would launch lanes and type replies hours late (review M2). */
export const HELD_MAX_AGE_MS = 5 * 60_000

export interface RendererGate<E> {
  /** Send `e` now if a renderer is ready, otherwise keep it. */
  send: (e: E) => void
  /** The renderer went away or is being replaced: keep everything from now on. */
  hold: () => void
  /** A renderer is ready: hand over what was kept, oldest first, and send directly from now on.
   *  Events kept longer than the age limit go to `onExpired` instead. */
  release: () => void
  /** How many events are being kept. */
  held: () => number
  /** Whether a renderer is ready and events go straight through. */
  isReleased: () => boolean
}

export interface GateOptions<E> {
  limit?: number
  maxAgeMs?: number
  now?: () => number
  /** Kept too long to route, and how many were dropped past `limit`, since the last release.
   *  Called on release, before the fresh events are sent. */
  onExpired?: (expired: E[], dropped: number) => void
}

/** `deliver` returns false when there is no window to deliver to; the event is then kept and the
 *  gate stays held, so later events cannot overtake it. The gate starts held: at launch no
 *  renderer is ready yet. */
export function createRendererGate<E>(deliver: (e: E) => boolean, opts: GateOptions<E> = {}): RendererGate<E> {
  const limit = opts.limit ?? HELD_LIMIT
  const maxAgeMs = opts.maxAgeMs ?? HELD_MAX_AGE_MS
  const now = opts.now ?? Date.now
  let ready = false
  let kept: Array<{ e: E; at: number }> = []
  let dropped = 0

  const keep = (e: E, at = now()) => {
    kept.push({ e, at })
    if (kept.length > limit) {
      console.error(`[shell] no renderer ready for ${kept.length} events; dropping the oldest`)
      dropped += kept.length - limit
      kept = kept.slice(-limit)
    }
  }

  return {
    send(e) {
      if (ready && deliver(e)) return
      ready = false
      keep(e)
    },
    hold() { ready = false },
    release() {
      const t = now()
      const expired = kept.filter((k) => t - k.at > maxAgeMs).map((k) => k.e)
      const out = kept.filter((k) => t - k.at <= maxAgeMs)
      const lost = dropped
      kept = []
      dropped = 0
      ready = true
      if (expired.length || lost) opts.onExpired?.(expired, lost)
      for (const k of out) {
        if (ready && deliver(k.e)) continue
        ready = false
        keep(k.e, k.at)
      }
    },
    held: () => kept.length,
    isReleased: () => ready,
  }
}

/** The main-frame load after which no `rendererReady` came. The renderer sends it once its lane
 *  tabs are back, which takes seconds; a renderer that never does (its view threw before the
 *  reattach finished) would otherwise keep every dispatch held with nothing on screen (review M1). */
export const READY_FALLBACK_MS = 30_000

/** Arms on each main-frame `did-finish-load` of the app, disarms on `rendererReady` or when the
 *  renderer goes away, and calls `onTimeout` if neither came in time. */
export function createReadyFallback(onTimeout: () => void, ms = READY_FALLBACK_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null } }
  return {
    loaded() { cancel(); timer = setTimeout(() => { timer = null; onTimeout() }, ms) },
    ready: cancel,
    leaving: cancel,
  }
}

/** Whether a navigation replaces the window's document, and with it the renderer's state: a
 *  main-frame, cross-document navigation (Cmd+R, a recovery reload, the error page). Fragment links
 *  and pushState keep the document; subframe navigations are the Preview iframe. Read on
 *  `did-start-navigation` for the recovery timer, and on the committed navigation for the hold. */
export function replacesDocument(nav: { isMainFrame: boolean; isSameDocument: boolean }): boolean {
  return nav.isMainFrame && !nav.isSameDocument
}
