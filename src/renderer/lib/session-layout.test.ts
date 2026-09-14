import { describe, it, expect } from 'vitest'
import {
  applyLayout, coerceLayouts, previewInBothSlots, panelDragBounds, clampPanelW, halfPanelW,
  DEFAULT_LAYOUT, PANEL_MIN_W, PANEL_MAX_W, PREVIEW_PANEL_MIN_W, MIN_CONSOLE_W,
  type SessionLayout, type MainView, type PanelTab, type ReadingTab,
} from './session-layout'

const layout = (over: Partial<SessionLayout>): SessionLayout => ({ ...DEFAULT_LAYOUT, ...over })

// Every state the three enums and the open flag can spell, INCLUDING the ones that break the rule
// (a stored layout can hold one), so the invariant test covers recovery as well as prevention.
const ALL_STATES: SessionLayout[] = (() => {
  const out: SessionLayout[] = []
  for (const mainView of ['terminal', 'preview'] as MainView[])
    for (const panelOpen of [false, true])
      for (const panelTab of ['plan', 'diff', 'preview'] as PanelTab[])
        for (const readingTab of ['plan', 'diff'] as ReadingTab[])
          out.push(layout({ mainView, panelOpen, panelTab, readingTab }))
  return out
})()

/** The user actions of the design's §1 table, as the patches DashboardView sends. */
const ACTIONS: Record<string, (prev: SessionLayout) => Partial<SessionLayout>> = {
  'toolbar Preview': () => ({ mainView: 'preview' }),
  'toolbar Console': () => ({ mainView: 'terminal' }),
  'panel tab PREVIEW': () => ({ panelTab: 'preview' }),
  'panel tab PLAN': () => ({ panelTab: 'plan' }),
  'panel tab DIFF': () => ({ panelTab: 'diff' }),
  'panel toggle': (prev) => ({ panelOpen: !prev.panelOpen }),
  '⌘K Side panel: Preview': () => ({ panelTab: 'preview', panelOpen: true }),
}

describe('applyLayout — one preview surface per session', () => {
  it('never leaves the preview in both slots, from any state, after any action', () => {
    for (const prev of ALL_STATES) {
      for (const [name, patchOf] of Object.entries(ACTIONS)) {
        const next = applyLayout(prev, patchOf(prev))
        expect(previewInBothSlots(next), `${name} from ${JSON.stringify(prev)}`).toBe(false)
      }
    }
  })

  it('toolbar Preview moves the preview out of the panel, which stays open on the reading tab', () => {
    const prev = layout({ mainView: 'terminal', panelOpen: true, panelTab: 'preview', readingTab: 'diff' })
    expect(applyLayout(prev, { mainView: 'preview' })).toMatchObject({ mainView: 'preview', panelOpen: true, panelTab: 'diff' })
  })

  it('toolbar Preview also clears a closed panel\'s Preview tab, so opening the panel cannot collide', () => {
    const prev = layout({ mainView: 'terminal', panelOpen: false, panelTab: 'preview', readingTab: 'plan' })
    expect(applyLayout(prev, { mainView: 'preview' })).toMatchObject({ mainView: 'preview', panelOpen: false, panelTab: 'plan' })
  })

  it('toolbar Preview leaves a reading tab alone', () => {
    const prev = layout({ mainView: 'terminal', panelOpen: true, panelTab: 'diff' })
    expect(applyLayout(prev, { mainView: 'preview' })).toMatchObject({ mainView: 'preview', panelOpen: true, panelTab: 'diff' })
  })

  it('toolbar Console touches nothing in the panel', () => {
    const prev = layout({ mainView: 'preview', panelOpen: true, panelTab: 'plan' })
    expect(applyLayout(prev, { mainView: 'terminal' })).toEqual({ ...prev, mainView: 'terminal' })
  })

  it('panel tab PREVIEW moves the preview out of the main view: Console and Preview side by side', () => {
    const prev = layout({ mainView: 'preview', panelOpen: true, panelTab: 'plan' })
    expect(applyLayout(prev, { panelTab: 'preview' })).toMatchObject({ mainView: 'terminal', panelOpen: true, panelTab: 'preview', readingTab: 'plan' })
  })

  it('panel tab PREVIEW with the Console showing only changes the tab', () => {
    const prev = layout({ mainView: 'terminal', panelOpen: true, panelTab: 'diff', readingTab: 'diff' })
    expect(applyLayout(prev, { panelTab: 'preview' })).toMatchObject({ mainView: 'terminal', panelTab: 'preview', readingTab: 'diff' })
  })

  it('⌘K Side panel: Preview opens a closed panel and moves the preview', () => {
    const prev = layout({ mainView: 'preview', panelOpen: false, panelTab: 'diff' })
    expect(applyLayout(prev, { panelTab: 'preview', panelOpen: true })).toMatchObject({ mainView: 'terminal', panelOpen: true, panelTab: 'preview' })
  })

  it('panel tabs PLAN / DIFF record the reading tab and leave the main view', () => {
    const prev = layout({ mainView: 'preview', panelOpen: true, panelTab: 'plan', readingTab: 'plan' })
    expect(applyLayout(prev, { panelTab: 'diff' })).toMatchObject({ mainView: 'preview', panelTab: 'diff', readingTab: 'diff' })
    expect(applyLayout(prev, { panelTab: 'plan' })).toMatchObject({ readingTab: 'plan' })
  })

  it('panel toggle only toggles', () => {
    const prev = layout({ mainView: 'terminal', panelOpen: true, panelTab: 'preview', readingTab: 'diff' })
    expect(applyLayout(prev, { panelOpen: false })).toEqual({ ...prev, panelOpen: false })
    expect(applyLayout({ ...prev, panelOpen: false }, { panelOpen: true })).toEqual(prev)
  })

  it('a patch that would reopen onto both slots keeps the panel and shows the Console', () => {
    // Unreachable through the actions above; possible from a stored layout.
    const prev = layout({ mainView: 'preview', panelOpen: false, panelTab: 'preview' })
    expect(applyLayout(prev, { panelOpen: true })).toMatchObject({ mainView: 'terminal', panelOpen: true, panelTab: 'preview' })
  })

  it('round trip main → panel → main lands the panel on the last reading tab', () => {
    let l = layout({ mainView: 'preview', panelOpen: true, panelTab: 'diff', readingTab: 'diff' })
    l = applyLayout(l, { panelTab: 'preview' })
    expect(l).toMatchObject({ mainView: 'terminal', panelTab: 'preview', readingTab: 'diff' })
    l = applyLayout(l, { mainView: 'preview' })
    expect(l).toMatchObject({ mainView: 'preview', panelOpen: true, panelTab: 'diff' })
  })

  it('merges a tools patch field by field', () => {
    const prev = layout({ tools: { grid: false, redlines: true } })
    expect(applyLayout(prev, { tools: { grid: true } }).tools).toEqual({ grid: true, redlines: true })
  })

  it('carries tools through untouched', () => {
    const prev = layout({ tools: { grid: true, redlines: false } })
    expect(applyLayout(prev, { panelTab: 'preview', panelOpen: true }).tools).toEqual({ grid: true, redlines: false })
  })
})

describe('coerceLayouts', () => {
  it('fills readingTab and tools on a layout written before they existed', () => {
    expect(coerceLayouts({ s1: { mainView: 'preview', panelOpen: true, panelTab: 'diff' } })).toEqual({
      s1: { mainView: 'preview', panelOpen: true, panelTab: 'diff', readingTab: 'diff', tools: { grid: false, redlines: false } },
    })
  })

  it('accepts the preview tab and keeps a stored reading tab', () => {
    expect(coerceLayouts({ s1: { mainView: 'terminal', panelOpen: true, panelTab: 'preview', readingTab: 'diff', tools: { grid: true, redlines: true } } }).s1)
      .toEqual({ mainView: 'terminal', panelOpen: true, panelTab: 'preview', readingTab: 'diff', tools: { grid: true, redlines: true } })
  })

  it('resolves a stored layout with the preview in both slots to the Console beside the panel', () => {
    expect(coerceLayouts({ s1: { mainView: 'preview', panelOpen: true, panelTab: 'preview' } }).s1)
      .toMatchObject({ mainView: 'terminal', panelOpen: true, panelTab: 'preview' })
  })

  it('keeps the preview in the main view when the panel holding the Preview tab is closed', () => {
    expect(coerceLayouts({ s1: { mainView: 'preview', panelOpen: false, panelTab: 'preview' } }).s1)
      .toMatchObject({ mainView: 'preview', panelOpen: false, panelTab: 'preview' })
  })

  it('coerces removed and junk values to defaults', () => {
    expect(coerceLayouts({ s1: { mainView: 'chat', panelOpen: 'yes', panelTab: 'files', readingTab: 'preview', tools: { grid: 1 } } }).s1)
      .toEqual(DEFAULT_LAYOUT)
  })

  it('drops non-object entries and non-object input', () => {
    expect(coerceLayouts({ s1: null, s2: 'x', s3: {} })).toEqual({ s3: DEFAULT_LAYOUT })
    expect(coerceLayouts(null)).toEqual({})
    expect(coerceLayouts('nope')).toEqual({})
  })
})

describe('side panel width', () => {
  it('reading tabs keep the existing 300–1000 drag range whatever the row', () => {
    expect(panelDragBounds('plan', 3000)).toEqual({ min: PANEL_MIN_W, max: PANEL_MAX_W })
    expect(panelDragBounds('diff', 600)).toEqual({ min: 300, max: 1000 })
  })

  it('the Preview tab may grow until the card is MIN_CONSOLE_W wide', () => {
    expect(panelDragBounds('preview', 2000)).toEqual({ min: PREVIEW_PANEL_MIN_W, max: 2000 - MIN_CONSOLE_W })
  })

  it('the Preview minimum wins in a row too narrow for both', () => {
    expect(panelDragBounds('preview', 700)).toEqual({ min: 360, max: 360 })
  })

  it('clamps and rounds', () => {
    expect(clampPanelW(250.4, { min: 300, max: 1000 })).toBe(300)
    expect(clampPanelW(1200, { min: 300, max: 1000 })).toBe(1000)
    expect(clampPanelW(512.6, { min: 300, max: 1000 })).toBe(513)
  })

  it('double-click splits the row in half, within the tab\'s bounds', () => {
    expect(halfPanelW('preview', 1400)).toBe(700)
    expect(halfPanelW('plan', 1400)).toBe(700)
    expect(halfPanelW('plan', 2600)).toBe(1000)
    expect(halfPanelW('preview', 2600)).toBe(1300)
    expect(halfPanelW('plan', 500)).toBe(300)
  })
})
