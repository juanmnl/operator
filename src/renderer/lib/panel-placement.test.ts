import { describe, expect, it } from 'vitest'
import { CONSOLE_CHROME_W, MIN_CONSOLE_COLS, PANEL_MIN_W, consoleMinWidth, placePanel } from './session-layout'

// Rows are the width the card, the 8px gap and the panel share: window − 16 (root padding) − rail
// − 8 (rail gap). Cell 7.82px is SF Mono at 13px as the Electron shell measured it.
const CELL = 7.82
const MIN = consoleMinWidth(CELL)
const place = (wantW: number, rowW: number) => placePanel({ wantW, rowW, gap: 8, minPanelW: PANEL_MIN_W, minConsoleW: MIN })
const cols = (cardW: number) => Math.floor((cardW - CONSOLE_CHROME_W) / CELL)

describe('placePanel — the panel yields before the console drops below MIN_CONSOLE_COLS', () => {
  it('the minimum is Claude Code\'s own 70 columns', () => {
    expect(MIN_CONSOLE_COLS).toBe(70)
    expect(cols(MIN)).toBeGreaterThanOrEqual(70)
  })

  it('1440 wide, rail expanded (row 1152): docks at the user\'s 460, console keeps 85+ columns', () => {
    const p = place(460, 1152)
    expect(p).toEqual({ mode: 'dock', width: 460 })
    expect(cols(1152 - 8 - p.width)).toBeGreaterThanOrEqual(70)
  })

  it('1280 wide, rail expanded (row 992): docks NARROWER so the console keeps 70', () => {
    const p = place(460, 992)
    expect(p.mode).toBe('dock')
    expect(p.width).toBeLessThan(460)
    expect(p.width).toBeGreaterThanOrEqual(PANEL_MIN_W)
    expect(cols(992 - 8 - p.width)).toBeGreaterThanOrEqual(70)
  })

  it('1000 wide, rail expanded (row 712): overlays, and the console keeps its full width', () => {
    // Before the rule this row gave the terminal 29 columns.
    expect(cols(712 - 8 - 460)).toBeLessThan(30)
    const p = place(460, 712)
    expect(p).toEqual({ mode: 'overlay', width: 460 })
  })

  it('1000 wide, rail collapsed (row 906): docks at the minimum-or-more with 70 columns left', () => {
    const p = place(460, 906)
    expect(p.mode).toBe('dock')
    expect(cols(906 - 8 - p.width)).toBeGreaterThanOrEqual(70)
  })

  it('an overlay is never wider than the row', () => {
    expect(place(900, 500)).toEqual({ mode: 'overlay', width: 500 })
  })
})
