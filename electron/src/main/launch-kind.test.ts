import { describe, it, expect } from 'vitest'
import { createLaunchTracker } from './launch-kind'

describe('launch or reload', () => {
  it('the first renderer in an app run is the launch', () => {
    expect(createLaunchTracker().claim()).toBe('launch')
  })

  it('every later renderer start in the same run is a reload (watchdog respawn, crash, ⌘R)', () => {
    const t = createLaunchTracker()
    t.claim()
    expect(t.claim()).toBe('reload')
    expect(t.claim()).toBe('reload')
  })

  it('a new app run starts over: a relaunch after quit or update is a launch again', () => {
    const run1 = createLaunchTracker()
    run1.claim()
    expect(createLaunchTracker().claim()).toBe('launch')
  })
})
