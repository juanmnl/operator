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

export interface RendererGate<E> {
  /** Send `e` now if a renderer is ready, otherwise keep it. */
  send: (e: E) => void
  /** The renderer went away or is being replaced: keep everything from now on. */
  hold: () => void
  /** A renderer is ready: hand over what was kept, oldest first, and send directly from now on. */
  release: () => void
  /** How many events are being kept. */
  held: () => number
}

/** `deliver` returns false when there is no window to deliver to; the event is then kept and the
 *  gate stays held, so later events cannot overtake it. The gate starts held: at launch no
 *  renderer is ready yet. */
export function createRendererGate<E>(deliver: (e: E) => boolean, limit = HELD_LIMIT): RendererGate<E> {
  let ready = false
  let kept: E[] = []

  const keep = (e: E) => {
    kept.push(e)
    if (kept.length > limit) {
      console.error(`[shell] no renderer ready for ${kept.length} events; dropping the oldest`)
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
      const out = kept
      kept = []
      ready = true
      for (const e of out) {
        if (ready && deliver(e)) continue
        ready = false
        keep(e)
      }
    },
    held: () => kept.length,
  }
}

/** Whether a `did-start-navigation` replaces the window's document, and with it the renderer's
 *  state: a main-frame, cross-document navigation (Cmd+R, a recovery reload, the error page).
 *  Fragment links and pushState keep the document; subframe navigations are the Preview iframe. */
export function replacesDocument(nav: { isMainFrame: boolean; isSameDocument: boolean }): boolean {
  return nav.isMainFrame && !nav.isSameDocument
}
