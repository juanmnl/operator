import { describe, it, expect, beforeEach, vi } from 'vitest'
// `?raw` rather than fs, as preview-overlay.test.ts does: the renderer's tsconfig has no node types.
import INSPECTOR from './preview-inspector.js?raw'
import OVERLAY from './preview-overlay.js?raw'
import { layoutGrid, gridInk, DEFAULT_GRID_SPEC } from './layout-grid'
import { measureBetween, formatPx, placeChip, describeRelation } from './redlines'
import { PREVIEW_BRIDGE_JS, PREVIEW_MESSAGE_TAG, previewFrameMessage } from './preview-frame'
import type { PreviewOverlayConfig } from './types'

// THE INVARIANT behind the 2026-09-17 fix: turning Redlines, the grid or Inspect on and off inside the
// preview page must not change the page's layout. What the scripts may do to the document is checked
// here directly: add nothing to <body>, leave <html> and <body> attributes alone, and put everything
// they draw in fixed-position, click-through elements that take no part in layout.

const run = (src: string) => new Function(src)()

const tokens = { measure: '#c98bff', measureInk: '#c98bff', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' }
const cfg = (over: Partial<PreviewOverlayConfig> = {}): PreviewOverlayConfig =>
  ({ scale: 0.5, inspect: false, redlines: false, grid: null, tokens, ...over })

type OverlayApi = { configure: (c: PreviewOverlayConfig) => void; redraw: () => void }

function freshPage() {
  document.documentElement.innerHTML = '<head></head><body style="margin:0" class="app"><main id="app"><section id="card" style="width:200px;height:100px">x</section></main></body>'
  for (const k of ['__operatorOverlay', '__operatorInspector', '__operatorOverlayFns', '__operatorBeacon', '__operatorPickBridge', '__operatorAnchorBridge']) {
    delete (window as unknown as Record<string, unknown>)[k]
  }
  ;(window as unknown as Record<string, unknown>).__operatorOverlayFns = { layoutGrid, gridInk, measureBetween, formatPx, placeChip, describeRelation }
  run(INSPECTOR)
  run(PREVIEW_BRIDGE_JS)
  run(OVERLAY)
  return (window as unknown as { __operatorOverlay: OverlayApi }).__operatorOverlay
}

/** Everything that decides the page's own layout, as a comparable snapshot. */
const snapshot = () => ({
  html: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`),
  body: [...document.body.attributes].map((a) => `${a.name}=${a.value}`),
  bodyHtml: document.body.innerHTML,
  head: document.head.innerHTML,
})

describe('the preview overlay takes no part in the page layout', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('turning every overlay on and off leaves <html>, <head> and <body> exactly as they were', () => {
    const overlay = freshPage()
    const before = snapshot()
    overlay.configure(cfg({ redlines: true, grid: DEFAULT_GRID_SPEC, inspect: true }))
    document.getElementById('card')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    overlay.redraw()
    expect(snapshot()).toEqual(before)
    overlay.configure(cfg())
    expect(snapshot()).toEqual(before)
  })

  it('draws only in fixed, click-through elements attached to <html>, outside <body>', () => {
    const overlay = freshPage()
    overlay.configure(cfg({ redlines: true, grid: DEFAULT_GRID_SPEC, inspect: true }))
    const added = [...document.documentElement.children].filter((n) => n !== document.head && n !== document.body) as HTMLElement[]
    expect(added.length).toBeGreaterThan(0)
    for (const el of added) {
      expect(el.style.position).toBe('fixed')
      expect(el.style.pointerEvents).toBe('none')
    }
  })

  it('never scrolls or navigates the page', () => {
    const overlay = freshPage()
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const href = location.href
    overlay.configure(cfg({ redlines: true, grid: DEFAULT_GRID_SPEC, inspect: true }))
    overlay.configure(cfg())
    expect(scroll).not.toHaveBeenCalled()
    expect(scrollBy).not.toHaveBeenCalled()
    expect(location.href).toBe(href)
  })
})

describe('the page → renderer bridge', () => {
  it('posts a pick and an anchor in the shape the renderer accepts', () => {
    freshPage()
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const w = window as unknown as { __operatorBeacon: (d: unknown, ok: () => void, fail: () => void) => void; __operatorAnchorBridge: (v: unknown) => void }
    const ok = vi.fn(), fail = vi.fn()
    w.__operatorBeacon({ target: 'console', message: 'hi' }, ok, fail)
    w.__operatorAnchorBridge(true)
    expect(ok).toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    const [pick, anchor] = post.mock.calls.map((c) => previewFrameMessage(c[0]))
    expect(pick).toEqual({ [PREVIEW_MESSAGE_TAG]: 'pick', data: JSON.stringify({ target: 'console', message: 'hi' }) })
    expect(anchor).toEqual({ [PREVIEW_MESSAGE_TAG]: 'anchor', value: true })
  })

  it('the renderer ignores anything that is not one of the two messages', () => {
    expect(previewFrameMessage(null)).toBeNull()
    expect(previewFrameMessage('pick')).toBeNull()
    expect(previewFrameMessage({ [PREVIEW_MESSAGE_TAG]: 'pick', data: 5 })).toBeNull()
    expect(previewFrameMessage({ [PREVIEW_MESSAGE_TAG]: 'anchor', value: 'yes' })).toBeNull()
    expect(previewFrameMessage({ [PREVIEW_MESSAGE_TAG]: 'reload' })).toBeNull()
  })
})
