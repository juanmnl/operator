import { describe, it, expect } from 'vitest'
import { classifyFocus, refocusTarget, type FocusableLike } from './refocus'

const el = (tagName: string, over: Partial<FocusableLike> & { classes?: string[]; inDialog?: boolean } = {}): FocusableLike => ({
  tagName,
  type: over.type,
  isContentEditable: over.isContentEditable ?? false,
  classList: { contains: (c: string) => (over.classes ?? []).includes(c) },
  closest: (sel: string) => (over.inDialog && sel.includes('dialog') ? {} : null),
})

describe('classifyFocus', () => {
  it('a terminal\'s helper textarea is the terminal, not a text field', () => {
    expect(classifyFocus(el('TEXTAREA', { classes: ['xterm-helper-textarea'] }))).toBe('terminal')
  })
  it('text inputs, textareas and contenteditable are text fields; checkboxes and buttons are not', () => {
    expect(classifyFocus(el('INPUT', { type: 'text' }))).toBe('text-field')
    expect(classifyFocus(el('INPUT'))).toBe('text-field') // no type = text
    expect(classifyFocus(el('INPUT', { type: 'search' }))).toBe('text-field')
    expect(classifyFocus(el('TEXTAREA'))).toBe('text-field')
    expect(classifyFocus(el('DIV', { isContentEditable: true }))).toBe('text-field')
    expect(classifyFocus(el('INPUT', { type: 'checkbox' }))).toBe('other')
    expect(classifyFocus(el('BUTTON'))).toBe('other')
  })
  it('anything focused inside a dialog is the dialog', () => {
    expect(classifyFocus(el('BUTTON', { inDialog: true }))).toBe('dialog')
    expect(classifyFocus(el('INPUT', { type: 'text', inDialog: true }))).toBe('dialog')
  })
  it('the Preview\'s iframe is an embedded page', () => {
    expect(classifyFocus(el('IFRAME'))).toBe('embedded')
  })
  it('the body or nothing is other', () => {
    expect(classifyFocus(el('BODY'))).toBe('other')
    expect(classifyFocus(null)).toBe('other')
  })
})

describe('refocusTarget — what to focus when the app is activated', () => {
  it('a lane on screen, nothing else in the way: its terminal', () => {
    expect(refocusTarget({ current: 'other', laneOnScreen: 't3', hasPrimaryInput: false })).toEqual({ kind: 'terminal', terminalId: 't3' })
    // Its own input restored by the platform is still "the terminal": focus it again, harmlessly.
    expect(refocusTarget({ current: 'terminal', laneOnScreen: 't3', hasPrimaryInput: false })).toEqual({ kind: 'terminal', terminalId: 't3' })
  })

  it('never takes focus from the Preview\'s page, which may hold a field of the app being previewed', () => {
    expect(refocusTarget({ current: 'embedded', laneOnScreen: 't3', hasPrimaryInput: false })).toEqual({ kind: 'keep' })
    expect(refocusTarget({ current: 'other', remembered: { kind: 'embedded', usable: true }, laneOnScreen: 't3', hasPrimaryInput: false }))
      .toEqual({ kind: 'restore' })
  })

  it('never takes focus from a text field or dialog that already has it', () => {
    expect(refocusTarget({ current: 'text-field', laneOnScreen: 't3', hasPrimaryInput: true })).toEqual({ kind: 'keep' })
    expect(refocusTarget({ current: 'dialog', laneOnScreen: 't3', hasPrimaryInput: true })).toEqual({ kind: 'keep' })
  })

  it('restores the text field or dialog the user was typing in when they switched away', () => {
    expect(refocusTarget({ current: 'other', remembered: { kind: 'text-field', usable: true }, laneOnScreen: 't3', hasPrimaryInput: false }))
      .toEqual({ kind: 'restore' })
    expect(refocusTarget({ current: 'other', remembered: { kind: 'dialog', usable: true }, hasPrimaryInput: true }))
      .toEqual({ kind: 'restore' })
  })

  it('does not restore one that is gone or hidden since; falls through to the view', () => {
    expect(refocusTarget({ current: 'other', remembered: { kind: 'text-field', usable: false }, laneOnScreen: 't3', hasPrimaryInput: false }))
      .toEqual({ kind: 'terminal', terminalId: 't3' })
  })

  it('a remembered terminal or button is not restored over the current view\'s choice', () => {
    expect(refocusTarget({ current: 'other', remembered: { kind: 'terminal', usable: true }, hasPrimaryInput: true })).toEqual({ kind: 'primary-input' })
    expect(refocusTarget({ current: 'other', remembered: { kind: 'other', usable: true }, laneOnScreen: 't1', hasPrimaryInput: false }))
      .toEqual({ kind: 'terminal', terminalId: 't1' })
  })

  it('a non-terminal view: its primary input if it has one, else nothing', () => {
    expect(refocusTarget({ current: 'other', hasPrimaryInput: true })).toEqual({ kind: 'primary-input' })
    expect(refocusTarget({ current: 'other', hasPrimaryInput: false })).toEqual({ kind: 'none' })
  })
})
