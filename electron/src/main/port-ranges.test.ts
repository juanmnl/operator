import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEV_INSTANCE_RANGES, DEV_RENDERER_DEFAULT_PORT, INSTALLED_RANGES, isDevInstance, portRangesFor, rangesOverlap,
} from './port-ranges'
import { allocatePort, PORT_BASE, type PortAllocDeps } from './port-alloc'
import { allocateCdpPort, CDP_PORT_BASE } from './preview-cdp-port'

const DEFAULT = '/Users/x/.operator'

describe('which windows an instance uses', () => {
  it('the installed app (packaged, default OPERATOR_DIR) keeps 1420-1520 and 9340-9440', () => {
    expect(portRangesFor({ isPackaged: true, operatorDir: DEFAULT, defaultOperatorDir: DEFAULT })).toBe(INSTALLED_RANGES)
    expect(portRangesFor({ isPackaged: true, operatorDir: `${DEFAULT}/`, defaultOperatorDir: DEFAULT })).toBe(INSTALLED_RANGES)
    expect(INSTALLED_RANGES.dev).toEqual({ base: 1420, max: 1520 })
    expect(INSTALLED_RANGES.cdp).toEqual({ base: 9340, max: 9440 })
  })

  it('an unpackaged build is a dev instance, even on the default OPERATOR_DIR', () => {
    expect(isDevInstance({ isPackaged: false, operatorDir: DEFAULT, defaultOperatorDir: DEFAULT })).toBe(true)
  })

  it('a packaged build pointed at another OPERATOR_DIR is a dev instance', () => {
    expect(portRangesFor({ isPackaged: true, operatorDir: '/tmp/scratch/operator-dir', defaultOperatorDir: DEFAULT })).toBe(DEV_INSTANCE_RANGES)
  })
})

describe('the windows never overlap', () => {
  it('no window of one kind of instance overlaps any window of the other, or its own other kind', () => {
    const all = [INSTALLED_RANGES.dev, INSTALLED_RANGES.cdp, DEV_INSTANCE_RANGES.dev, DEV_INSTANCE_RANGES.cdp]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(rangesOverlap(all[i], all[j]), `${i}/${j}`).toBe(false)
    }
  })

  it('npm run dev\'s own renderer default is outside every window, and dev.mjs and vite.config.ts agree on it', () => {
    for (const r of [INSTALLED_RANGES.dev, INSTALLED_RANGES.cdp, DEV_INSTANCE_RANGES.dev, DEV_INSTANCE_RANGES.cdp]) {
      expect(rangesOverlap(r, { base: DEV_RENDERER_DEFAULT_PORT, max: DEV_RENDERER_DEFAULT_PORT })).toBe(false)
    }
    const root = join(__dirname, '..', '..')
    for (const file of ['scripts/dev.mjs', 'vite.config.ts']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain(`OPERATOR_ELECTRON_PORT) || ${DEV_RENDERER_DEFAULT_PORT}`)
    }
  })

  it('the exported constants the older tests use are the installed windows', () => {
    expect(PORT_BASE).toBe(INSTALLED_RANGES.dev.base)
    expect(CDP_PORT_BASE).toBe(INSTALLED_RANGES.cdp.base)
  })
})

describe('allocation from a dev instance\'s windows', () => {
  const deps = (over: Partial<PortAllocDeps> = {}): PortAllocDeps => ({
    isFree: async () => true, leased: async () => new Set(), sharedHolderIsOurs: async () => false,
    range: DEV_INSTANCE_RANGES.dev, ...over,
  })

  it('hands out dev ports only from 1620-1720, never the installed app\'s 1422', async () => {
    const map = new Map<string, number>()
    const got: number[] = []
    for (const cwd of ['/a', '/b', '/c']) got.push((await allocatePort(cwd, map, deps())).port!)
    expect(got).toEqual([1620, 1621, 1622])
  })

  it('still bind-tests every candidate: a bound port is skipped even with no lease anywhere', async () => {
    const bound = new Set([1620, 1621])
    const r = await allocatePort('/a', new Map(), deps({ isFree: async (p) => !bound.has(p) }))
    expect(r.port).toBe(1622)
  })

  it('an exhausted dev window returns no port rather than spilling into the installed app\'s', async () => {
    const r = await allocatePort('/a', new Map(), deps({ isFree: async (p) => p < 1620 || p > 1720 }))
    expect(r.port).toBeUndefined()
  })

  it('hands out CDP ports only from 9540-9640, bind-tested', async () => {
    const { base, max } = DEV_INSTANCE_RANGES.cdp
    expect(await allocateCdpPort(new Set(), async () => true, base, max)).toBe(9540)
    expect(await allocateCdpPort(new Set([9540]), async (p) => p !== 9541, base, max)).toBe(9542)
    expect(await allocateCdpPort(new Set(), async (p) => p < base, base, max)).toBeUndefined()
  })
})
