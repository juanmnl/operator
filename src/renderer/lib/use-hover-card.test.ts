import { describe, it, expect, vi } from 'vitest'
import { installHoverCloseListeners, type HoverCloseTargets } from './use-hover-card'

// THE WIRING, not the reducer. `hover-card-machine.test.ts` proves that a `close` event closes a
// card; nothing proved that a pointer leaving the WINDOW ever produces one, and that is the exact
// shape of the defect these listeners exist for — a stuck card over the rail is a path that
// reached no listener, not a transition that went wrong.

type Registered = { type: string; handler: (e: unknown) => void; capture?: boolean }

function recorder() {
  const on: Registered[] = []
  const add = (type: string, handler: unknown, capture?: unknown) => {
    on.push({ type, handler: handler as (e: unknown) => void, capture: capture === true })
  }
  const targets = {
    win: { addEventListener: add },
    doc: { addEventListener: add, documentElement: { addEventListener: add } },
  } as unknown as HoverCloseTargets
  return { on, targets }
}

describe('every way a pointer stops being over a row closes the card', () => {
  it('registers all six dismiss paths', () => {
    const { on, targets } = recorder()
    installHoverCloseListeners(targets, () => {})
    expect(on.map((r) => r.type).sort()).toEqual(
      ['blur', 'keydown', 'mouseleave', 'mouseout', 'resize', 'scroll', 'visibilitychange'].sort(),
    )
  })

  it('closes on window blur, resize and visibilitychange', () => {
    const close = vi.fn()
    const { on, targets } = recorder()
    installHoverCloseListeners(targets, close)
    for (const type of ['blur', 'resize', 'visibilitychange']) {
      on.find((r) => r.type === type)!.handler({})
    }
    expect(close).toHaveBeenCalledTimes(3)
  })

  // THE POINTER LEAVING THE WINDOW, which is the one the old hardening missed. `mouseout` fires
  // constantly while moving WITHIN the document, so the null-relatedTarget guard is the whole
  // test: without it the card would close on every internal move, with it inverted the card
  // survives the cursor leaving the app.
  it('closes on mouseout ONLY when the pointer left the document', () => {
    const close = vi.fn()
    const { on, targets } = recorder()
    installHoverCloseListeners(targets, close)
    const mouseout = on.find((r) => r.type === 'mouseout')!.handler

    mouseout({ relatedTarget: {} }) // moved onto another element — still inside
    expect(close).not.toHaveBeenCalled()

    mouseout({ relatedTarget: null }) // left the document
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on documentElement mouseleave — the browsers that prefer that signal', () => {
    const close = vi.fn()
    const { on, targets } = recorder()
    installHoverCloseListeners(targets, close)
    on.find((r) => r.type === 'mouseleave')!.handler({})
    expect(close).toHaveBeenCalledTimes(1)
  })

  // Capture, or the sidebar scroller's own scroll never reaches it — and a scroll is precisely
  // what moves a row out from under a cursor that never moved.
  it('listens for scroll and keydown in the CAPTURE phase', () => {
    const { on, targets } = recorder()
    installHoverCloseListeners(targets, () => {})
    expect(on.find((r) => r.type === 'scroll')!.capture).toBe(true)
    expect(on.find((r) => r.type === 'keydown')!.capture).toBe(true)
  })
})
