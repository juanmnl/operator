import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { act, createElement as h, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppPreviewPanel } from './AppPreviewPanel'
import { ToolbarIcon, TOOLBAR_ICON_NAMES } from '../ToolbarIcon'
import { DEFAULT_GRID_SPEC } from '../../../shared/layout-grid'

// EVERY TOOLBAR CONTROL THAT IS NOT A WORD IS AN SVG. The bar used to draw ◀ ▶ ⟳ ↩ ↗ ▾ ● as text,
// and each glyph fell back to a different font with its own size. This renders the real panel with
// its tools row up (server reachable, grid and redlines on) and checks the rendered bar.

/** Symbols and arrows a control might be tempted to use as text. Words (Fit, 1280, Interact,
 *  Grid, Redlines) are labels and stay text by design. */
const GLYPH = /[←-⇿⌀-⏿■-◿⟰-⟿⤀-⥿⬀-⯿]/

let host: HTMLDivElement
let root: Root
const saved: Record<string, unknown> = {}

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>
  for (const k of ['ResizeObserver', 'fetch']) saved[k] = g[k]
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  // The panel pings the URL to decide the server is up; the tools row only renders then.
  g.fetch = async () => new Response('')
  ;(window as { operator?: unknown }).operator = {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    // createElement rather than JSX: the renderer suite collects `*.test.ts` only.
    root.render(h(AppPreviewPanel, {
      url: 'http://localhost:5173/',
      storageKey: 'test-preview',
      onDispatch: () => {},
      grid: { on: true, spec: DEFAULT_GRID_SPEC, editing: false, savedTo: null },
      onGridToggle: () => {},
      onGridEditingChange: () => {},
      redlines: { on: false },
      onRedlinesToggle: () => {},
    }))
  })
  // Let the reachability ping resolve and the tools row render.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
})

afterAll(() => {
  act(() => root.unmount())
  host.remove()
  const g = globalThis as Record<string, unknown>
  for (const k of Object.keys(saved)) g[k] = saved[k]
  delete (window as { operator?: unknown }).operator
})

describe('the Preview toolbar draws its icons as SVG', () => {
  it('rendered the tools row, so the check below covers both groups', () => {
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toContain('Grid')
    expect(labels).toContain('Redlines')
    expect(host.querySelector('button[title="Reload"]')).not.toBeNull()
  })

  it('every button with no word in it renders an svg, and no button text is a symbol glyph', () => {
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(8)
    for (const b of buttons) {
      const text = (b.textContent ?? '').trim()
      expect(text, `button "${b.title}" has glyph text "${text}"`).not.toMatch(GLYPH)
      if (!/[A-Za-z0-9]/.test(text)) {
        expect(b.querySelector('svg'), `button "${b.title}" has no svg`).not.toBeNull()
      }
    }
  })

  it('draws back, forward, reload, open in browser and the grid caret as named icons', () => {
    const icon = (title: string) => host.querySelector(`button[title="${title}"] svg`)?.getAttribute('data-toolbar-icon')
    expect(icon('Reload')).toBe('reload')
    expect(icon('Open in browser')).toBe('external')
    expect(icon('Grid settings')).toBe('caret-down')
    expect(host.querySelector('button[title^="Back to the last address"] svg')?.getAttribute('data-toolbar-icon')).toBe('back')
    expect(host.querySelector('button[title^="Forward to the next address"] svg')?.getAttribute('data-toolbar-icon')).toBe('forward')
  })

  it('has no glyph text anywhere in the bar, including the origin chip', () => {
    const bar = host.firstElementChild!.firstElementChild!
    expect(bar.textContent ?? '').not.toMatch(GLYPH)
  })
})

describe('ToolbarIcon — one grid', () => {
  it('every icon has the same viewBox, stroke and caps', () => {
    const el = document.createElement('div')
    const r = createRoot(el)
    act(() => r.render(h(Fragment, null, TOOLBAR_ICON_NAMES.map((n) => h(ToolbarIcon, { key: n, name: n })))))
    const svgs = [...el.querySelectorAll('svg')]
    expect(svgs).toHaveLength(TOOLBAR_ICON_NAMES.length)
    for (const s of svgs) {
      expect(s.getAttribute('viewBox')).toBe('0 0 16 16')
      expect(s.getAttribute('stroke-width')).toBe('1.5')
      expect(s.getAttribute('stroke-linecap')).toBe('round')
      expect(s.getAttribute('stroke')).toBe('currentColor')
      expect(s.getAttribute('width')).toBe('12')
    }
    act(() => r.unmount())
  })

  it('Back and Back to / are different glyphs', () => {
    expect(TOOLBAR_ICON_NAMES).toContain('back')
    expect(TOOLBAR_ICON_NAMES).toContain('root')
  })
})
