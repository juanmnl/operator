import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { PreviewOverlayConfig } from '../../../src/shared/types'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  webFrameMain: { fromId: () => ({ name: 'x', parent: null, executeJavaScript: async () => {} }) },
}))

import * as inspect from './preview-inspect'

// 0.28.3: after a V8 OOM, `close` ran from the `render-process-gone` handler and the frame lookup
// threw "Render frame was disposed before WebFrameMain could be accessed" as an uncaught exception
// in main, which also skipped the crash log and the reload.
describe('previewApi on a dead renderer', () => {
  const disposed = () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed') }

  const setup = () => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    const win = {
      isDestroyed: () => false,
      webContents: {
        get mainFrame() { return disposed() },
        on: (ev: string, fn: (...a: unknown[]) => void) => { listeners.set(ev, fn) },
      },
    } as unknown as BrowserWindow
    const anchors: boolean[] = []
    inspect.installPreviewInspect(() => win, (a) => anchors.push(a))
    return { listeners, anchors }
  }

  const config = { scale: 1, inspect: true, redlines: false, grid: null, tokens: {} } as unknown as PreviewOverlayConfig

  it('close and the other frame lookups do not throw when mainFrame is gone', async () => {
    const w = setup()
    const api = inspect.previewApi
    expect(() => api.open('', 0, 0, 0, 0)).not.toThrow()
    expect(() => api.configure(config)).not.toThrow()
    expect(() => api.clearAnchor()).not.toThrow()
    await expect(api.hideOutline()).resolves.toBeUndefined()
    expect(() => api.close()).not.toThrow()
    expect(w.anchors).toEqual([false])
  })

  it('a subframe load on a renderer that went away is ignored, not thrown', () => {
    const w = setup()
    const api = inspect.previewApi
    api.open('', 0, 0, 0, 0)
    api.configure(config)
    const onLoad = w.listeners.get('did-frame-finish-load')!
    expect(() => onLoad({}, false, 1, 2)).not.toThrow()
    expect(w.anchors).toEqual([])
  })
})
