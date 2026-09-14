import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// `?raw` rather than fs, as diff-parse.test.ts does: the renderer's tsconfig has no node types.
import OVERLAY_JS from './preview-overlay.js?raw'
import INSPECTOR_JS from './preview-inspector.js?raw'
import { layoutGrid } from './layout-grid'
import { measureBetween, formatPx, placeChip, describeRelation } from './redlines'
import type { PreviewOverlayConfig } from './types'

// The scripts that run inside the Preview's native inspect view, run here in jsdom. jsdom has no
// layout (every box is 0×0), so this checks what needs none: that ⌥-click and Esc are taken from
// the page and ordinary input is not, the anchor's lifecycle, and the hand-off to the inspector.
// The geometry is tested in redlines.test.ts and layout-grid.test.ts.

type Inspector = { selector: (el: Element) => string; configure?: (o: unknown) => void; label?: (el: Element) => string }
type AnchorInfo = { node: Element; box: { left: number; top: number; right: number; bottom: number }; name: string }
type PageWindow = Window & {
  __operatorOverlay?: {
    configure: (c: PreviewOverlayConfig) => void; clearAnchor: () => void; redraw: () => void; redlinesOn: () => boolean
    anchorInfo: () => AnchorInfo | null
  }
  __operatorBeacon?: (data: Record<string, unknown>, onOk: () => void, onFail: () => void) => void
  __operatorOverlayFns?: unknown
  __operatorAnchorBridge?: (anchored: boolean) => void
  __operatorInspector?: Inspector
}
const page = window as PageWindow

const TOKENS = { measure: '#c98bff', measureInk: '#d9b0ff', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' }
const config = (over: Partial<PreviewOverlayConfig> = {}): PreviewOverlayConfig => ({
  scale: 1, inspect: false, redlines: true, grid: null, tokens: TOKENS, ...over,
})

const run = (js: string) => new Function(js)()
const add = (id: string) => document.body.appendChild(Object.assign(document.createElement('div'), { id }))
const altClick = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })
  el.dispatchEvent(e)
  return e
}

let bridge: ReturnType<typeof vi.fn>

beforeEach(() => {
  // No frame ever fires on its own: draws happen only through `redraw()`, synchronously.
  vi.useFakeTimers()
  document.body.innerHTML = ''
  page.__operatorOverlayFns = { layoutGrid, measureBetween, formatPx, placeChip, describeRelation }
  bridge = vi.fn()
  page.__operatorAnchorBridge = bridge as unknown as (anchored: boolean) => void
  page.__operatorInspector = { selector: (el) => `#${el.id}` }
  delete page.__operatorOverlay
  run(OVERLAY_JS)
})

afterEach(() => {
  // Every load adds window listeners that outlive the test. Switching the instance off makes its
  // listeners return early, so it cannot answer the next test's events.
  page.__operatorOverlay?.configure(config({ redlines: false }))
  document.querySelectorAll('[data-operator-overlay]').forEach((n) => n.remove())
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('preview-overlay — ⌥-click and Esc belong to the measurement', () => {
  it('an ⌥-click sets the anchor, and neither the press nor the click reaches the app', () => {
    const card = add('card')
    const app = vi.fn()
    card.addEventListener('mousedown', app)
    card.addEventListener('click', app)
    page.__operatorOverlay!.configure(config())
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true }))
    const click = altClick(card)
    expect(app).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(true)
    expect(bridge).toHaveBeenCalledWith(true)
  })

  it('an ⌥-click on the anchor again, or on empty space, clears it', () => {
    const card = add('card')
    page.__operatorOverlay!.configure(config())
    altClick(card)
    altClick(card)
    expect(bridge.mock.calls).toEqual([[true], [false]])
    altClick(card)
    altClick(document.body)
    expect(bridge).toHaveBeenLastCalledWith(false)
  })

  it('Esc clears the anchor and is kept from the page', () => {
    const card = add('card')
    const app = vi.fn()
    document.body.addEventListener('keydown', app)
    page.__operatorOverlay!.configure(config())
    altClick(card)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(esc)
    expect(bridge).toHaveBeenLastCalledWith(false)
    expect(esc.defaultPrevented).toBe(true)
    expect(app).not.toHaveBeenCalled()
  })

  it('Esc with no anchor is left to the page', () => {
    const app = vi.fn()
    document.body.addEventListener('keydown', app)
    page.__operatorOverlay!.configure(config())
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(app).toHaveBeenCalledTimes(1)
  })

  it('a plain click reaches the app while redlines are on', () => {
    const card = add('card')
    const app = vi.fn()
    card.addEventListener('click', app)
    page.__operatorOverlay!.configure(config())
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(app).toHaveBeenCalledTimes(1)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('with redlines off an ⌥-click reaches the app', () => {
    const card = add('card')
    const app = vi.fn()
    card.addEventListener('click', app)
    page.__operatorOverlay!.configure(config({ redlines: false }))
    altClick(card)
    expect(app).toHaveBeenCalledTimes(1)
  })
})

describe('preview-overlay — the anchor', () => {
  it('turning redlines off clears it', () => {
    page.__operatorOverlay!.configure(config())
    altClick(add('card'))
    page.__operatorOverlay!.configure(config({ redlines: false }))
    expect(bridge.mock.calls).toEqual([[true], [false]])
  })

  it('clearAnchor clears it, and does nothing without one', () => {
    page.__operatorOverlay!.configure(config())
    page.__operatorOverlay!.clearAnchor()
    expect(bridge).not.toHaveBeenCalled()
    altClick(add('card'))
    page.__operatorOverlay!.clearAnchor()
    expect(bridge.mock.calls).toEqual([[true], [false]])
  })

  it('after HMR replaces the node it is found again by its selector, and cleared when nothing matches', () => {
    const first = add('card')
    page.__operatorOverlay!.configure(config())
    altClick(first)
    first.remove()
    add('card')
    page.__operatorOverlay!.redraw()
    expect(bridge.mock.calls).toEqual([[true]])
    document.getElementById('card')!.remove()
    page.__operatorOverlay!.redraw()
    expect(bridge.mock.calls).toEqual([[true], [false]])
  })
})

/** jsdom has no layout; give an element the box a real page would. */
const placeAt = (el: Element, left: number, top: number, right: number, bottom: number) => {
  el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  return el
}

describe('preview-overlay — anchorInfo, for the inspector\'s note', () => {
  it('is null without an anchor, and null again once redlines are off', () => {
    page.__operatorOverlay!.configure(config())
    expect(page.__operatorOverlay!.anchorInfo()).toBeNull()
    altClick(add('card'))
    expect(page.__operatorOverlay!.anchorInfo()).not.toBeNull()
    page.__operatorOverlay!.configure(config({ redlines: false }))
    expect(page.__operatorOverlay!.anchorInfo()).toBeNull()
  })

  it('reports the anchor node, its box and the inspector\'s name for it', () => {
    page.__operatorInspector = { selector: (el) => `#${el.id}`, label: () => 'Header' }
    page.__operatorOverlay!.configure(config())
    const head = placeAt(add('head'), 0, 0, 300, 50)
    altClick(head)
    expect(page.__operatorOverlay!.anchorInfo()).toEqual({ node: head, box: { left: 0, top: 0, right: 300, bottom: 50 }, name: 'Header' })
  })

  it('falls back to the tag name when the inspector cannot name it', () => {
    page.__operatorOverlay!.configure(config())
    altClick(add('head'))
    expect(page.__operatorOverlay!.anchorInfo()!.name).toBe('div')
  })
})

describe('preview-overlay — drawing and hand-off', () => {
  it('draws into its own shadow root, attached outside the page\'s <body>', () => {
    page.__operatorOverlay!.configure(config())
    altClick(add('card'))
    page.__operatorOverlay!.redraw()
    const hosts = document.querySelectorAll('[data-operator-overlay]')
    expect(hosts).toHaveLength(1)
    expect(hosts[0].parentElement).toBe(document.documentElement)
    expect(hosts[0].shadowRoot!.querySelectorAll('div').length).toBeGreaterThan(2)
  })

  it('hands the inspector its on/off switch, the palette and the scale', () => {
    const configure = vi.fn()
    page.__operatorInspector = { selector: (el) => `#${el.id}`, configure }
    page.__operatorOverlay!.configure(config({ inspect: true, scale: 0.5 }))
    expect(configure).toHaveBeenLastCalledWith({ enabled: true, colors: TOKENS, scale: 0.5 })
  })
})

describe('preview-inspector — switched by the overlay', () => {
  let target: HTMLElement

  beforeEach(() => {
    delete page.__operatorInspector
    run(INSPECTOR_JS)
    // jsdom has no hit testing; the inspector asks for the element under the pointer.
    target = document.body.appendChild(document.createElement('button'))
    document.elementFromPoint = () => target
  })

  afterEach(() => {
    page.__operatorInspector?.configure?.({ enabled: false })
    document.getElementById('__op_compose')?.remove()
  })

  it('captures a click to compose a note when nothing configures it (the Tauri shell)', () => {
    const app = vi.fn()
    target.addEventListener('click', app)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(app).not.toHaveBeenCalled()
    expect(document.getElementById('__op_compose')).not.toBeNull()
  })

  it('lets clicks reach the app once it is switched off', () => {
    page.__operatorInspector!.configure!({ enabled: false })
    const app = vi.fn()
    target.addEventListener('click', app)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(app).toHaveBeenCalledTimes(1)
    expect(document.getElementById('__op_compose')).toBeNull()
  })

  it('puts the measurement to the redline anchor on the card and in the note it sends', () => {
    const sent = vi.fn((_data: Record<string, unknown>, onOk: () => void) => onOk())
    page.__operatorBeacon = sent
    page.__operatorOverlay!.configure(config({ inspect: true }))
    const head = placeAt(add('head'), 0, 0, 300, 50)
    placeAt(target, 0, 66, 300, 120)
    altClick(head)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const card = document.getElementById('__op_compose')!
    expect(card.querySelector('[data-op-measurement]')!.textContent).toBe('16px below div#head')
    card.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(sent.mock.calls[0][0]).toMatchObject({ measurement: '16px below div#head', target: 'tasks' })
    delete page.__operatorBeacon
  })

  it('adds no measurement without an anchor, or when the picked element is the anchor', () => {
    page.__operatorOverlay!.configure(config({ inspect: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(document.querySelector('#__op_compose [data-op-measurement]')).toBeNull()
    // Close it the way a person does, so the inspector knows it is no longer composing.
    document.querySelector('#__op_compose textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.getElementById('__op_compose')).toBeNull()
    altClick(target)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(document.getElementById('__op_compose')).not.toBeNull()
    expect(document.querySelector('#__op_compose [data-op-measurement]')).toBeNull()
  })

  it('exposes the selector the overlay re-finds an anchor with', () => {
    expect(page.__operatorInspector!.selector(target)).toBe('html:nth-of-type(1) > body:nth-of-type(1) > button:nth-of-type(1)')
  })
})
