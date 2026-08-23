import { describe, it, expect } from 'vitest'
import { paneVisibility } from './pane-visibility'

// The rule the Preview bleed forced (2026-08-22): "the active pane always paints" was true under
// WKWebView and false under Chromium, where a cross-origin preview iframe composites in its own
// out-of-process layer and the terminal below it can land ON TOP of that layer.
describe('paneVisibility', () => {
  it('paints the active pane on Console — the ordinary case, unchanged', () => {
    expect(paneVisibility('t1', 't1', 'terminal')).toBe('visible')
  })

  it('HIDES the active pane while Chat or Preview covers it — the fix', () => {
    expect(paneVisibility('t1', 't1', 'preview')).toBe('hidden')
    expect(paneVisibility('t1', 't1', 'chat')).toBe('hidden')
  })

  it('never paints an inactive pane, whatever the main view', () => {
    for (const v of ['terminal', 'chat', 'preview'] as const) {
      expect(paneVisibility('t2', 't1', v)).toBe('hidden')
    }
  })

  it('paints nothing when no lane is active', () => {
    expect(paneVisibility('t1', null, 'terminal')).toBe('hidden')
  })

  it('answers only visible/hidden — never `display:none`, which would resize the terminal', () => {
    // The invariant this fix had to respect: a hidden box still has layout, so xterm is never
    // told the viewport changed and the ghostty resize/render hang stays unreachable.
    const answers = new Set(
      (['terminal', 'chat', 'preview'] as const).flatMap((v) => [
        paneVisibility('t1', 't1', v), paneVisibility('t2', 't1', v),
      ]),
    )
    expect([...answers].sort()).toEqual(['hidden', 'visible'])
  })
})
