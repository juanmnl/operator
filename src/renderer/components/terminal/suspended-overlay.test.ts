import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SuspendedOverlay } from './SuspendedOverlay'

// KEYS TYPED IN THE LAST BURST REACH THE LANE (review N3). The overlay hands its held keys over
// after a 150 ms pause in typing. The resume that focus started usually finishes while the person
// is still typing; that unmounts the overlay, and its cleanup cleared the timer, so everything typed
// since the last pause was lost. This renders the real overlay, types, and unmounts it mid-burst.

let host: HTMLDivElement
let root: Root
const saved: Record<string, unknown> = {}

beforeEach(() => {
  saved.act = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  vi.useRealTimers()
  host.remove()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = saved.act
})

const render = (onResume: (held: string) => void) => act(() => {
  root.render(h(SuspendedOverlay, { active: true, resuming: true, onResume }))
})

const type = (text: string) => act(() => {
  const el = host.querySelector('[role="button"]')!
  for (const key of text) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
})

describe('SuspendedOverlay', () => {
  it('hands over the keys typed since the last pause when it unmounts', async () => {
    const calls: string[] = []
    await render((held) => calls.push(held))
    await type('fix ')
    await act(() => { vi.advanceTimersByTime(200) }) // a pause: handed over
    await type('the tests') // still typing when the resume lands
    await act(() => { root.unmount() })
    expect(calls).toEqual(['fix ', 'fix the tests'])
  })

  it('hands over nothing more on unmount when everything was handed over already', async () => {
    const calls: string[] = []
    await render((held) => calls.push(held))
    await type('ok')
    await act(() => { vi.advanceTimersByTime(200) })
    await act(() => { root.unmount() })
    expect(calls).toEqual(['ok'])
  })

  it('calls the handler of the latest render, not the first', async () => {
    const calls: string[] = []
    await render(() => calls.push('stale'))
    await render((held) => calls.push(`latest ${held}`))
    await type('x')
    await act(() => { root.unmount() })
    expect(calls).toEqual(['latest x'])
  })
})
