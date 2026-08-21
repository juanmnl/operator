import { describe, it, expect } from 'vitest'
import { trayLaneItems } from './tray'

// Ported from what `refresh_tray_menu` builds (src-tauri/src/transcript.rs:1159-1177) plus the
// label the tailer hands it (`transcript.rs:1098-1103`). The menu is the only place the tray
// says anything, so the label format IS the feature.
describe('trayLaneItems', () => {
  it('labels a lane "<project>  ·  <phase>" — two spaces around the dot, the raw phase word', () => {
    expect(trayLaneItems([{ terminalId: 't1', project: 'operator', phase: 'running' }])).toEqual([
      { id: 'session:t1', label: 'operator  ·  running', enabled: true },
    ])
  })

  it('an empty fleet says so, and the row is not clickable', () => {
    // Under Tauri this was a normal item whose id matched no handler — it already did nothing.
    expect(trayLaneItems([])).toEqual([{ id: 'none', label: 'No active sessions', enabled: false }])
  })

  it('rows are sorted by id, so a lane cannot swap places between two refreshes', () => {
    const items = trayLaneItems([
      { terminalId: 't3', project: 'zeta', phase: 'idle' },
      { terminalId: 't1', project: 'alpha', phase: 'waiting' },
      { terminalId: 't2', project: 'mid', phase: 'compacting' },
    ])
    expect(items.map((i) => i.id)).toEqual(['session:t1', 'session:t2', 'session:t3'])
    expect(items.map((i) => i.label)).toEqual(['alpha  ·  waiting', 'mid  ·  compacting', 'zeta  ·  idle'])
  })

  it('every lane gets a row — the tray does not summarise', () => {
    const lanes = Array.from({ length: 9 }, (_, i) => ({ terminalId: `t${i}`, project: `p${i}`, phase: 'idle' }))
    expect(trayLaneItems(lanes)).toHaveLength(9)
  })
})
