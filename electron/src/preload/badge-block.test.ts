import { describe, it, expect, vi } from 'vitest'
import { blockBadging } from './badge-block'

/** A stand-in for `Navigator.prototype` whose badge methods record calls. */
function fakeNavigatorProto() {
  const setAppBadge = vi.fn(() => Promise.resolve())
  const clearAppBadge = vi.fn(() => Promise.resolve())
  return { proto: { setAppBadge, clearAppBadge } as Record<string, unknown>, setAppBadge, clearAppBadge }
}

describe('blockBadging', () => {
  it('replaces setAppBadge and clearAppBadge with no-ops that resolve', async () => {
    const { proto, setAppBadge, clearAppBadge } = fakeNavigatorProto()
    blockBadging(proto)
    await expect((proto.setAppBadge as (n: number) => Promise<void>)(3)).resolves.toBeUndefined()
    await expect((proto.clearAppBadge as () => Promise<void>)()).resolves.toBeUndefined()
    expect(setAppBadge).not.toHaveBeenCalled()
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it('keeps the methods present, so feature detection still finds them', () => {
    const { proto } = fakeNavigatorProto()
    blockBadging(proto)
    expect('setAppBadge' in proto).toBe(true)
    expect(typeof proto.clearAppBadge).toBe('function')
  })

  it('adds nothing to a navigator that has no Badging API', () => {
    const proto: Record<string, unknown> = {}
    blockBadging(proto)
    expect(proto).toEqual({})
  })

  // `contextBridge.executeInMainWorld` serializes the function and rebuilds it in the page, so a
  // reference to anything outside its body would be a ReferenceError there and nothing here.
  it('still works after being serialized and rebuilt, as executeInMainWorld does', async () => {
    const rebuilt = new Function(`return (${blockBadging.toString()})`)() as typeof blockBadging
    const { proto, setAppBadge } = fakeNavigatorProto()
    rebuilt(proto)
    await (proto.setAppBadge as (n: number) => Promise<void>)(3)
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('with no argument, targets the global Navigator.prototype', async () => {
    const { proto, setAppBadge } = fakeNavigatorProto()
    vi.stubGlobal('Navigator', { prototype: proto })
    try {
      blockBadging()
      await (proto.setAppBadge as (n: number) => Promise<void>)(3)
      expect(setAppBadge).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('with no argument, targets WorkerNavigator.prototype in a service worker', async () => {
    const { proto, setAppBadge } = fakeNavigatorProto()
    vi.stubGlobal('WorkerNavigator', { prototype: proto })
    try {
      blockBadging()
      await (proto.setAppBadge as (n: number) => Promise<void>)(9)
      expect(setAppBadge).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
