import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { blockBadging } from './badge-block'

// The preload runs in the Preview <iframe> as well as the app's own frame (the window sets
// `nodeIntegrationInSubFrames`). What each frame gets is the security property: the app's frame
// gets the native API, a subframe — a lane's dev server — gets the badge stub and nothing else.
const exposeInMainWorld = vi.fn()
const executeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (...a: unknown[]) => exposeInMainWorld(...a),
    executeInMainWorld: (...a: unknown[]) => executeInMainWorld(...a),
  },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))

/** Load the preload fresh inside a fake window that is, or is not, the top frame. */
async function loadPreloadIn(frame: 'top' | 'subframe') {
  const win: Record<string, unknown> = { addEventListener: vi.fn() }
  win.top = frame === 'top' ? win : {}
  vi.stubGlobal('window', win)
  vi.resetModules()
  await import('./index')
  return win
}

beforeEach(() => { exposeInMainWorld.mockClear(); executeInMainWorld.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('preload frame routing', () => {
  it('the top frame gets the native API and the drop guard, and keeps its own Badging API', async () => {
    const win = await loadPreloadIn('top')
    expect(exposeInMainWorld.mock.calls.map((c) => c[0])).toEqual(['__operatorNative', '__operatorNativeMethods'])
    expect(win.addEventListener).toHaveBeenCalledWith('drop', expect.any(Function))
    expect(executeInMainWorld).not.toHaveBeenCalled()
  })

  it('a subframe gets the badge stub and nothing else', async () => {
    const win = await loadPreloadIn('subframe')
    // By name: `resetModules` gives the preload its own instance of badge-block.ts.
    expect(executeInMainWorld).toHaveBeenCalledTimes(1)
    expect((executeInMainWorld.mock.calls[0][0] as { func: () => void }).func.name).toBe(blockBadging.name)
    expect(exposeInMainWorld).not.toHaveBeenCalled()
    expect(win.addEventListener).not.toHaveBeenCalled()
  })
})
