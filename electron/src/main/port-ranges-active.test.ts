import { describe, it, expect, vi, afterEach } from 'vitest'

// `activePortRanges` reads the real inputs: electron's `app.isPackaged` and OPERATOR_DIR.
const app = { isPackaged: true, getAppPath: () => '/tmp' }
vi.mock('electron', () => ({ app }))

const { activePortRanges } = await import('./terminals')
const { DEV_INSTANCE_RANGES, INSTALLED_RANGES } = await import('./port-ranges')

describe('activePortRanges', () => {
  const saved = process.env.OPERATOR_DIR
  afterEach(() => { app.isPackaged = true; process.env.OPERATOR_DIR = saved })

  it('an unpackaged build allocates from the dev-instance windows', () => {
    app.isPackaged = false
    expect(activePortRanges()).toBe(DEV_INSTANCE_RANGES)
  })

  it('a packaged build with a non-default OPERATOR_DIR (this suite\'s sandbox) does too', () => {
    expect(process.env.OPERATOR_DIR).toBeTruthy()
    expect(activePortRanges()).toBe(DEV_INSTANCE_RANGES)
  })

  it('only a packaged build on the default ~/.operator gets the installed app\'s windows', () => {
    delete process.env.OPERATOR_DIR // read only; nothing is written
    expect(activePortRanges()).toBe(INSTALLED_RANGES)
  })
})
