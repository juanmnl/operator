import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CDP_BINDING, CDP_BRIDGE_JS, inputCommand, parseTargets, routeBinding } from './preview-cdp'
import { allocateCdpPort, cdpLaunchNote, CDP_PORT_BASE, dependsOnElectron, isElectronProject, ownCdpPort } from './preview-cdp-port'
import { CDP_BINDING as BINDING, editCommandExpression } from './preview-cdp'

describe('target discovery', () => {
  const ws = (id: string) => `ws://127.0.0.1:9340/devtools/page/${id}`
  it('offers page targets only, dropping DevTools windows, workers and entries without a socket', () => {
    const list = [
      { id: 'A', type: 'page', title: 'Main Window', url: 'file:///app/index.html', webSocketDebuggerUrl: ws('A') },
      { id: 'B', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: ws('B') },
      { id: 'C', type: 'service_worker', title: 'sw', url: 'http://x/sw.js', webSocketDebuggerUrl: ws('C') },
      { id: 'D', type: 'page', title: 'Being inspected elsewhere', url: 'http://x/' },
      { id: 'E', type: 'page', url: 'http://localhost:5173/settings', webSocketDebuggerUrl: ws('E') },
    ]
    expect(parseTargets(list)).toEqual([
      { id: 'A', title: 'Main Window', url: 'file:///app/index.html', webSocketDebuggerUrl: ws('A') },
      { id: 'E', title: '', url: 'http://localhost:5173/settings', webSocketDebuggerUrl: ws('E') },
    ])
  })
  it('is empty for anything that is not a list', () => {
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets({ id: 'A' })).toEqual([])
  })
})

describe('message routing from the app page', () => {
  it('routes a pick and an anchor from our binding, and nothing else', () => {
    expect(routeBinding({ name: CDP_BINDING, payload: JSON.stringify({ kind: 'pick', data: '{"tag":"div"}' }) }))
      .toEqual({ kind: 'pick', data: '{"tag":"div"}' })
    expect(routeBinding({ name: CDP_BINDING, payload: JSON.stringify({ kind: 'anchor', value: true }) })).toEqual({ kind: 'anchor', value: true })
    expect(routeBinding({ name: 'someoneElse', payload: JSON.stringify({ kind: 'pick', data: 'x' }) })).toBeNull()
    expect(routeBinding({ name: CDP_BINDING, payload: 'not json' })).toBeNull()
    expect(routeBinding({ name: CDP_BINDING, payload: JSON.stringify({ kind: 'anchor', value: 'yes' }) })).toBeNull()
  })

  it('the injected bridge calls the binding in exactly the shape routeBinding accepts', () => {
    const calls: string[] = []
    const window: Record<string, unknown> = { [CDP_BINDING]: (s: string) => calls.push(s), addEventListener: () => {} }
    runInNewContext(CDP_BRIDGE_JS, { window, JSON, String, Error })
    let ok = false
    ;(window.__operatorBeacon as (d: unknown, a: () => void, b: () => void) => void)({ target: 'console', message: 'hi' }, () => { ok = true }, () => {})
    ;(window.__operatorAnchorBridge as (v: boolean) => void)(true)
    expect(ok).toBe(true)
    const routed = calls.map((payload) => routeBinding({ name: CDP_BINDING, payload }))
    expect(routed).toEqual([
      { kind: 'pick', data: JSON.stringify({ target: 'console', message: 'hi' }) },
      { kind: 'anchor', value: true },
    ])
  })

  it('reports a failed pick when the binding is missing (not attached)', () => {
    const window: Record<string, unknown> = { addEventListener: () => {} }
    runInNewContext(CDP_BRIDGE_JS, { window, JSON, String, Error })
    let failed = false
    ;(window.__operatorBeacon as (d: unknown, a: () => void, b: () => void) => void)({}, () => {}, () => { failed = true })
    expect(failed).toBe(true)
  })
})

describe('input commands', () => {
  it('maps mouse, wheel and keys to Input.dispatch*Event', () => {
    expect(inputCommand({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 1 })).toEqual({
      method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 1 },
    })
    expect(inputCommand({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: 0 }).params).toMatchObject({ type: 'mouseWheel', deltaY: 120 })
    expect(inputCommand({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', keyCode: 65, modifiers: 0 }).params)
      .toMatchObject({ type: 'keyDown', text: 'a', windowsVirtualKeyCode: 65 })
    // No text: a raw key (arrows, ⌃ shortcuts), which must not insert anything.
    expect(inputCommand({ kind: 'key', type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, modifiers: 0 }).params)
      .toMatchObject({ type: 'rawKeyDown', text: undefined })
    expect(inputCommand({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', text: 'a', keyCode: 65, modifiers: 0 }).params)
      .toMatchObject({ type: 'keyUp', text: undefined })
  })
})

describe('the debugging port', () => {
  it('skips ports already handed out and ports something else holds', async () => {
    const busy = new Set([CDP_PORT_BASE + 1])
    const port = await allocateCdpPort(new Set([CDP_PORT_BASE]), async (p) => !busy.has(p))
    expect(port).toBe(CDP_PORT_BASE + 2)
  })
  it('is undefined when the window is exhausted', async () => {
    expect(await allocateCdpPort(new Set(), async () => false, 9000, 9002)).toBeUndefined()
  })
  it('tells the lane the one-line opt-in and the port', () => {
    const n = cdpLaunchNote(9345)
    expect(n).toContain("app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)")
    expect(n).toContain('--remote-debugging-port=9345')
  })
})

describe('Electron project detection', () => {
  it('reads electron from dependencies or devDependencies only', () => {
    expect(dependsOnElectron({ devDependencies: { electron: '^43' } })).toBe(true)
    expect(dependsOnElectron({ dependencies: { electron: '43' } })).toBe(true)
    expect(dependsOnElectron({ dependencies: { 'electron-store': '1' }, peerDependencies: { electron: '*' } })).toBe(false)
    expect(dependsOnElectron(null)).toBe(false)
  })
  it('finds it in the project package.json or one of the known subpackages, and never throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operator-cdp-detect-'))
    try {
      const web = join(root, 'web'); mkdirSync(web)
      writeFileSync(join(web, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }))
      expect(await isElectronProject(web)).toBe(false)

      const sub = join(root, 'sub'); mkdirSync(join(sub, 'electron'), { recursive: true })
      writeFileSync(join(sub, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }))
      writeFileSync(join(sub, 'electron', 'package.json'), JSON.stringify({ devDependencies: { electron: '43' } }))
      expect(await isElectronProject(sub)).toBe(true)

      const broken = join(root, 'broken'); mkdirSync(broken)
      writeFileSync(join(broken, 'package.json'), '{ not json')
      expect(await isElectronProject(broken)).toBe(false)
      expect(await isElectronProject(join(root, 'missing'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("Operator's own debugging port (dev builds only)", () => {
  it('opens the lane port in a dev build, and never in a packaged app, on the --mcp-serve path, or for a non-port', () => {
    expect(ownCdpPort(false, { OPERATOR_CDP_PORT: '9341' }, ['electron', '.'])).toBe('9341')
    expect(ownCdpPort(true, { OPERATOR_CDP_PORT: '9341' }, ['Operator'])).toBeNull()
    expect(ownCdpPort(false, { OPERATOR_CDP_PORT: '9341' }, ['electron', '.', '--mcp-serve'])).toBeNull()
    expect(ownCdpPort(false, {}, ['electron', '.'])).toBeNull()
    expect(ownCdpPort(false, { OPERATOR_CDP_PORT: '9341 --inspect' }, ['electron', '.'])).toBeNull()
  })
})

describe('CSS controls over CDP', () => {
  it('routes the edit engine state forwarded through the binding', () => {
    expect(routeBinding({ name: BINDING, payload: JSON.stringify({ kind: 'edit', data: '{"count":1}' }) })).toEqual({ kind: 'edit', data: '{"count":1}' })
    expect(routeBinding({ name: BINDING, payload: JSON.stringify({ kind: 'edit', data: 5 }) })).toBeNull()
  })

  it('the bridge forwards the engine state message the page posts to itself, once, and nothing else', () => {
    const calls: string[] = []
    const listeners: Array<(ev: { source: unknown; data: unknown }) => void> = []
    const window: Record<string, unknown> = {
      [CDP_BINDING]: (s: string) => calls.push(s),
      addEventListener: (type: string, fn: (ev: { source: unknown; data: unknown }) => void) => { if (type === 'message') listeners.push(fn) },
    }
    runInNewContext(CDP_BRIDGE_JS, { window, JSON, String, Error })
    runInNewContext(CDP_BRIDGE_JS, { window, JSON, String, Error }) // evaluated again on re-attach
    expect(listeners).toHaveLength(1)
    const fire = (source: unknown, data: unknown) => listeners.forEach((l) => l({ source, data }))
    fire(window, { __operatorEdit: 'state', data: '{"count":2}' })
    fire({}, { __operatorEdit: 'state', data: '{"count":3}' })           // another window
    fire(window, { __operatorEditCmd: 'undo' })                         // a command, not state
    expect(calls.map((payload) => routeBinding({ name: CDP_BINDING, payload }))).toEqual([{ kind: 'edit', data: '{"count":2}' }])
  })

  it('delivers only edit commands, JSON-encoded into the expression', () => {
    expect(editCommandExpression({ __operatorEditCmd: 'set', uid: 'u1', prop: 'padding-top', value: "8px'); alert(1); ('" }))
      .toBe(`window.postMessage(${JSON.stringify({ __operatorEditCmd: 'set', uid: 'u1', prop: 'padding-top', value: "8px'); alert(1); ('" })}, '*')`)
    expect(editCommandExpression({ something: 'else' })).toBeNull()
    expect(editCommandExpression('undo')).toBeNull()
  })
})
