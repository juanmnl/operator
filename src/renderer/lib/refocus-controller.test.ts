import { describe, it, expect } from 'vitest'
import { createRefocusController } from './refocus-controller'
import type { FocusableLike } from './refocus'

// A fake page: an iframe (the Preview), a lane's terminal input, a text field, a button, the body.
type El = FocusableLike & { id: string }
const make = (id: string, tagName: string, classes: string[] = []): El => ({
  id, tagName, classList: { contains: (c) => classes.includes(c) }, closest: () => null,
})
const iframe = make('preview', 'IFRAME')
const terminal = make('t3-input', 'TEXTAREA', ['xterm-helper-textarea'])
const commitMsg = make('commit-message', 'INPUT')
const toolbarBtn = make('toolbar-button', 'BUTTON')
const body = make('body', 'BODY')

function page(opts: { lane?: string } = {}) {
  const s = { active: body as El, hasFocus: true, clock: 0, focused: [] as string[] }
  const frames: Array<() => void> = []
  const deferred: Array<() => void> = []
  const c = createRefocusController<El>({
    activeElement: () => s.active,
    hasFocus: () => s.hasFocus,
    now: () => s.clock,
    defer: (fn) => deferred.push(fn),
    nextFrame: (fn) => frames.push(fn),
    isUsable: () => true,
    laneOnScreen: () => opts.lane,
    primaryInput: () => null,
    focusElement: (el) => { s.focused.push(el.id); s.active = el },
    focusTerminal: (id) => { s.focused.push(`terminal:${id}`); s.active = terminal },
  })
  const settle = () => { while (deferred.length) deferred.shift()!(); while (frames.length) frames.shift()!() }
  /** A click inside the page: the page's own window events, and the element it lands on. */
  const clickInPage = (el: El) => { s.clock++; c.onUserInput(); s.active = el }
  return { s, c, settle, clickInPage }
}

describe('Review finding 1: a click out of the Preview is never pulled back into it', () => {
  it('iframe focus round-trip with no app switch: nothing is recorded, nothing is refocused', () => {
    const { s, c, settle, clickInPage } = page({ lane: 't3' })
    // Focus enters the Preview. The page gets a window 'blur', but the document keeps focus.
    s.active = iframe
    c.onWindowBlur()
    settle()
    // The user clicks back on the terminal. The page's window 'focus' fires; main sends no activation,
    // because the app never lost focus, and the controller is not driven by the page's own 'focus'.
    clickInPage(terminal)
    settle()
    expect(s.focused).toEqual([])
    expect(s.active).toBe(terminal)
  })

  it('even if an activation arrived right after that click, the click wins', () => {
    const { s, c, settle, clickInPage } = page({ lane: 't3' })
    s.active = iframe
    c.onWindowBlur()
    settle()
    clickInPage(toolbarBtn)
    c.onActivated()
    settle()
    expect(s.focused).toEqual([]) // no iframe.focus(), no terminal
    expect(s.active).toBe(toolbarBtn)
  })

  it('the app lost focus while the Preview had it: the iframe is not recorded to be restored later', () => {
    const { s, c, settle } = page({ lane: 't3' })
    s.active = iframe
    s.hasFocus = false // the app itself went to the background
    c.onWindowBlur()
    settle()
    // Coming back, the platform left focus on the body: the lane on screen gets it, not the iframe.
    s.hasFocus = true
    s.active = body
    s.clock++
    c.onActivated()
    settle()
    expect(s.focused).toEqual(['terminal:t3'])
  })
})

describe('Review finding 2: a remembered field never overrides a click made after returning', () => {
  it('Cmd-Tab away from the commit message, come back by clicking the terminal: the terminal keeps focus', () => {
    const { s, c, settle, clickInPage } = page({ lane: 't3' })
    s.active = commitMsg
    s.hasFocus = false
    c.onWindowBlur()
    settle()
    // Back: main signals activation, then the click lands on the terminal before the next frame.
    s.hasFocus = true
    s.clock++
    c.onActivated()
    clickInPage(terminal)
    settle()
    expect(s.focused).toEqual([])
    expect(s.active).toBe(terminal)
  })

  it("the click arrives before main's activation signal: focus is on what was clicked, so it is kept", () => {
    const { s, c, settle, clickInPage } = page({ lane: 't3' })
    s.active = commitMsg
    s.hasFocus = false
    c.onWindowBlur()
    settle()
    s.hasFocus = true
    clickInPage(terminal) // the activating click is delivered first…
    s.clock++
    c.onActivated() // …then the IPC arrives
    settle()
    expect(s.focused).toEqual([])
    expect(s.active).toBe(terminal)
  })

  it('no click, focus left on the body: the field the user was typing in is restored, once', () => {
    const { s, c, settle } = page({ lane: 't3' })
    s.active = commitMsg
    s.hasFocus = false
    c.onWindowBlur()
    settle()
    s.hasFocus = true
    s.active = body
    s.clock++
    c.onActivated()
    settle()
    expect(s.focused).toEqual(['commit-message'])
    // A later activation with focus on the body again does not resurrect it: the lane gets focus.
    s.active = body
    s.clock++
    c.onActivated()
    settle()
    expect(s.focused).toEqual(['commit-message', 'terminal:t3'])
  })
})

describe('Review finding 3: a focused menu or control keeps focus on return', () => {
  it('a menu item focused when the app came back is left alone', () => {
    const { s, c, settle } = page({ lane: 't3' })
    const menuItem = make('menu-item', 'BUTTON')
    s.active = menuItem
    s.clock++
    c.onActivated()
    settle()
    expect(s.focused).toEqual([])
    expect(c.lastPlan()).toEqual({ kind: 'keep' })
  })
})
