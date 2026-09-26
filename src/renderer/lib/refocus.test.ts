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
  it('the body or nothing is none', () => {
    expect(classifyFocus(el('BODY'))).toBe('none')
    expect(classifyFocus(null)).toBe('none')
  })
})

describe('refocusTarget — what to focus when the app is activated', () => {
  it('focus on the body with a lane on screen: its terminal', () => {
    expect(refocusTarget({ current: 'none', laneOnScreen: 't3', hasPrimaryInput: false })).toEqual({ kind: 'terminal', terminalId: 't3' })
  })

  it('keeps ANY element other than the body: field, dialog, Preview, menu, button, the terminal itself', () => {
    for (const current of ['text-field', 'dialog', 'embedded', 'other', 'terminal'] as const) {
      expect(refocusTarget({ current, remembered: { kind: 'text-field', usable: true }, laneOnScreen: 't3', hasPrimaryInput: true }), current)
        .toEqual({ kind: 'keep' })
    }
  })

  it('the user clicked or typed after coming back: nothing changes, whatever was remembered (review 2)', () => {
    expect(refocusTarget({ current: 'none', userActedSinceActivation: true, remembered: { kind: 'text-field', usable: true }, laneOnScreen: 't3', hasPrimaryInput: true }))
      .toEqual({ kind: 'keep' })
  })

  it('focus on the body: restores the field, dialog or Preview the user was in when the app lost focus', () => {
    for (const kind of ['text-field', 'dialog', 'embedded'] as const) {
      expect(refocusTarget({ current: 'none', remembered: { kind, usable: true }, laneOnScreen: 't3', hasPrimaryInput: false }), kind)
        .toEqual({ kind: 'restore' })
    }
  })

  it('does not restore one that is gone or hidden since, nor a remembered button or terminal', () => {
    expect(refocusTarget({ current: 'none', remembered: { kind: 'text-field', usable: false }, laneOnScreen: 't3', hasPrimaryInput: false }))
      .toEqual({ kind: 'terminal', terminalId: 't3' })
    expect(refocusTarget({ current: 'none', remembered: { kind: 'other', usable: true }, hasPrimaryInput: true })).toEqual({ kind: 'primary-input' })
  })

  it('a non-terminal view: its primary input if it has one, else nothing', () => {
    expect(refocusTarget({ current: 'none', hasPrimaryInput: true })).toEqual({ kind: 'primary-input' })
    expect(refocusTarget({ current: 'none', hasPrimaryInput: false })).toEqual({ kind: 'keep' })
  })

  it('a hidden lane\'s terminal holding focus while the board shows counts as nothing', () => {
    expect(refocusTarget({ current: 'terminal', hasPrimaryInput: true })).toEqual({ kind: 'primary-input' })
  })
})
