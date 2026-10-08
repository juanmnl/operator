import { describe, it, expect } from 'vitest'
import { layersOver, layerOf, runTileLoop, withTimeout, type StageBox, type TileLoopDeps } from './preview-screenshot'
import type { PreviewScreenshotTileRequest } from '../../shared/types'

/** A loop's surroundings: a 500×700 stage at (23, 57), a 2x screen, a 1280 preset at scale 0.390625.
 *  `wantTransform` is what React renders now, which a test can change mid-capture. */
function harness(over: Partial<TileLoopDeps> = {}) {
  const log: string[] = []
  const frame = { style: { transform: 'scale(0.390625)' } }
  let stage: StageBox = { left: 23, top: 57, width: 500, height: 700 }
  let dpr = 2
  let want = 'scale(0.390625)'
  const requests: PreviewScreenshotTileRequest[] = []
  const deps: TileLoopDeps = {
    frame,
    stage: () => stage,
    viewport: () => ({ w: 1440, h: 900 }),
    dpr: () => dpr,
    wantTransform: () => want,
    hide: async (hidden) => { log.push(`hide ${hidden}`) },
    tile: async (req) => { requests.push(req); log.push(`tile ${frame.style.transform}`); return true },
    paint: async () => {},
    id: 'cap',
    tileTimeoutMs: 30,
    hideTimeoutMs: 30,
    ...over,
  }
  return {
    log, frame, requests, deps,
    setStage: (s: StageBox) => { stage = s },
    setDpr: (n: number) => { dpr = n },
    setWant: (t: string) => { want = t },
  }
}

const PAGE = { w: 1280, h: 1792 }

describe('runTileLoop', () => {
  it('captures every tile at scale 1, shifted, then puts the transform back and shows the drawing', async () => {
    const h = harness()
    const r = await runTileLoop(PAGE, h.deps)
    expect(r).toEqual({ ok: true, id: 'cap' })
    expect(h.requests).toHaveLength(9)
    expect(h.log[0]).toBe('hide true')
    expect(h.log[1]).toBe('tile translate(0px, 0px)')
    expect(h.log[9]).toBe('tile translate(-1000px, -1400px)')
    expect(h.log[10]).toBe('hide false')
    expect(h.frame.style.transform).toBe('scale(0.390625)')
  })

  it('a tile that never answers times out, and the page, its drawing and the transform come back', async () => {
    const h = harness({ tile: () => new Promise<boolean>(() => {}) })
    const r = await runTileLoop(PAGE, h.deps)
    expect(r).toEqual({ ok: false, reason: 'A tile was not captured within 0 s.' })
    expect(h.log).toEqual(['hide true', 'hide false'])
    expect(h.frame.style.transform).toBe('scale(0.390625)')
  })

  it('a resize mid-capture aborts, and restores the transform React wants now, not the one before', async () => {
    const h = harness()
    h.deps.tile = async (req) => {
      h.requests.push(req)
      // The panel was dragged narrower: the stage shrinks and React renders a new scale.
      h.setStage({ left: 23, top: 57, width: 400, height: 700 })
      h.setWant('scale(0.3125)')
      return true
    }
    const r = await runTileLoop(PAGE, h.deps)
    expect(r).toEqual({ ok: false, reason: 'The preview moved or changed size during the capture.' })
    expect(h.requests).toHaveLength(1)
    expect(h.frame.style.transform).toBe('scale(0.3125)')
  })

  it('a change of pixel ratio (another display, or ⌘+) aborts', async () => {
    const h = harness()
    h.deps.tile = async () => { h.setDpr(1); return true }
    const r = await runTileLoop(PAGE, h.deps)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/pixel density changed/)
    expect(h.frame.style.transform).toBe('scale(0.390625)')
  })

  it('a fitting preview gets no transform back', async () => {
    const h = harness()
    h.frame.style.transform = ''
    h.setWant('')
    h.setStage({ left: 23, top: 57, width: 500, height: 700 })
    const r = await runTileLoop({ w: 500, h: 700 }, h.deps)
    expect(r.ok).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(h.frame.style.transform).toBe('')
  })

  it('a failed tile and a thrown tile both stop the loop and restore', async () => {
    for (const tile of [async () => false, async () => { throw new Error('gone') }]) {
      const h = harness({ tile })
      const r = await runTileLoop(PAGE, h.deps)
      expect(r).toEqual({ ok: false, reason: 'The preview could not be captured.' })
      expect(h.log).toEqual(['hide true', 'hide false'])
      expect(h.frame.style.transform).toBe('scale(0.390625)')
    }
  })

  it('a hide that never answers does not hold the capture', async () => {
    const h = harness({ hide: () => new Promise<void>(() => {}) })
    const r = await runTileLoop(PAGE, h.deps)
    expect(r.ok).toBe(true)
  })

  it('refuses an image past the size cap before touching the page', async () => {
    const h = harness()
    const r = await runTileLoop({ w: 1280, h: 8534 }, h.deps)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/2560×17068 px/)
    expect(h.log).toEqual([])
    expect(h.frame.style.transform).toBe('scale(0.390625)')
  })
})

describe('withTimeout', () => {
  it('gives the fallback for a promise that rejects or never settles', async () => {
    expect(await withTimeout(Promise.reject(new Error('x')), 50, 'f')).toBe('f')
    expect(await withTimeout(new Promise<string>(() => {}), 5, 'f')).toBe('f')
    expect(await withTimeout(Promise.resolve('v'), 50, 'f')).toBe('v')
  })
})

describe('the layers over the stage', () => {
  /** root > card > stage > (frame, shield); root > panel > button; root > toasts > toast. */
  function dom() {
    const root = document.createElement('div')
    const card = document.createElement('div')
    const stage = document.createElement('div')
    const frame = document.createElement('iframe')
    const shield = document.createElement('div')
    const panel = document.createElement('div')
    const button = document.createElement('button')
    const toasts = document.createElement('div')
    const toast = document.createElement('div')
    stage.append(frame, shield)
    card.append(stage)
    panel.append(button)
    toasts.append(toast)
    root.append(card, panel, toasts)
    document.body.append(root)
    return { root, card, stage, frame, shield, panel, button, toasts, toast }
  }

  it('a layer is the outermost ancestor that does not hold the stage', () => {
    const d = dom()
    expect(layerOf(d.button, d.stage)).toBe(d.panel)
    expect(layerOf(d.toast, d.stage)).toBe(d.toasts)
  })

  it('finds what is drawn over the stage, passes over the stage\'s own children, and stops at the frame', () => {
    const d = dom()
    const hit = (x: number) => x < 100
      ? [d.shield, d.button, d.panel, d.frame, d.stage, d.card, d.root]
      : [d.toast, d.toasts, d.frame, d.stage, d.card, d.root]
    const found = layersOver(d.stage, d.frame, { x: 0, y: 0, w: 200, h: 100 }, hit, 2)
    expect([...found]).toEqual([d.panel, d.toasts])
  })
})
