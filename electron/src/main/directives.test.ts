import { describe, it, expect } from 'vitest'
import { parseDispatches, parseReplies, directiveId, stripDirectiveDecoration } from './directives'

describe('parseDispatches — tolerance', () => {
  it('parses a plain directive', () => {
    expect(parseDispatches('OPERATOR-DISPATCH [code] Fix the login button')).toEqual([['code', 'Fix the login button']])
  })

  it('tolerates a colon after the bracket', () => {
    expect(parseDispatches('OPERATOR-DISPATCH [research]: why is the list slow?')).toEqual([['research', 'why is the list slow?']])
  })

  it('tolerates bullets, numbering, bold and backticks — models decorate protocol lines', () => {
    const cases = [
      '- OPERATOR-DISPATCH [code] a',
      '* OPERATOR-DISPATCH [code] a',
      '1. OPERATOR-DISPATCH [code] a',
      '2) OPERATOR-DISPATCH [code] a',
      '`OPERATOR-DISPATCH [code] a`',
      '**OPERATOR-DISPATCH [code] a**',
    ]
    for (const c of cases) expect(parseDispatches(c), c).toEqual([['code', 'a']])
  })

  it('picks directives out of surrounding prose, ignoring non-directive lines', () => {
    const text = 'Here is the plan.\nOPERATOR-DISPATCH [code] Fix it\nnot a directive\nOPERATOR-DISPATCH [design] Tidy it'
    expect(parseDispatches(text)).toEqual([['code', 'Fix it'], ['design', 'Tidy it']])
  })

  it('ignores malformed lines', () => {
    expect(parseDispatches('OPERATOR-DISPATCH no brackets')).toEqual([])
    expect(parseDispatches('OPERATOR-DISPATCH [code]')).toEqual([]) // no task
    expect(parseDispatches('OPERATOR-DISPATCH [] a')).toEqual([])   // no role
  })
})

// The guards are the half that took a real incident to get right: with the tolerance above, a
// directive a lane merely READ parsed identically to one it authored — and a dispatch is
// delivered into another lane's pty, launching an idle lane to receive it.
describe('parseDispatches — quotation guards (a quoted directive must NOT fire)', () => {
  it('ignores a directive inside a ``` fence', () => {
    expect(parseDispatches('see:\n```\nOPERATOR-DISPATCH [code] do it\n```\ndone')).toEqual([])
  })

  it('ignores a directive inside a ~~~ fence', () => {
    expect(parseDispatches('~~~\nOPERATOR-DISPATCH [code] do it\n~~~')).toEqual([])
  })

  it('treats ~~~ inside a ``` block as content, not a closing fence', () => {
    expect(parseDispatches('```\n~~~\nOPERATOR-DISPATCH [code] do it\n```')).toEqual([])
  })

  it('ignores a 4-space-indented directive', () => {
    expect(parseDispatches('    OPERATOR-DISPATCH [code] do it')).toEqual([])
  })

  it('ignores a tab-indented directive', () => {
    expect(parseDispatches('\tOPERATOR-DISPATCH [code] do it')).toEqual([])
  })

  it('ignores a BLOCKQUOTED directive — the one marker that means "not mine"', () => {
    expect(parseDispatches('> OPERATOR-DISPATCH [code] do it')).toEqual([])
  })

  it('still fires an authored directive after a fenced block closes', () => {
    expect(parseDispatches('```\nquoted\n```\nOPERATOR-DISPATCH [code] real')).toEqual([['code', 'real']])
  })
})

describe('parseReplies', () => {
  it('mirrors dispatch exactly', () => {
    expect(parseReplies('OPERATOR-REPLY [operator] done')).toEqual([['operator', 'done']])
    expect(parseReplies('> OPERATOR-REPLY [operator] quoted')).toEqual([])
  })

  it('does not confuse the two sentinels', () => {
    expect(parseDispatches('OPERATOR-REPLY [operator] done')).toEqual([])
    expect(parseReplies('OPERATOR-DISPATCH [code] work')).toEqual([])
  })
})

// The id is what stops a re-read of the same transcript replaying every dispatch into real
// ptys, so it must be deterministic AND stable across the port.
describe('directiveId', () => {
  it('is deterministic', () => {
    expect(directiveId('s', 'code', 'task')).toBe(directiveId('s', 'code', 'task'))
  })

  it('is 16 lowercase hex characters, like the Rust {:016x}', () => {
    expect(directiveId('s', 'code', 'task')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('separates the fields — a shifted boundary must not collide', () => {
    expect(directiveId('a', 'bc', 'd')).not.toBe(directiveId('ab', 'c', 'd'))
  })

  it('matches FNV-1a 64-bit computed independently', () => {
    // Reference value computed here the same way the Rust does, over the same bytes, so this
    // pins the algorithm rather than restating the implementation.
    const ref = (s: string) => {
      let h = 0xcbf29ce484222325n
      for (const b of Buffer.from(s, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
      return h.toString(16).padStart(16, '0')
    }
    expect(directiveId('sess', 'code', 'do the thing')).toBe(ref('sess|code|do the thing'))
  })

  it('handles non-ASCII by bytes, not UTF-16 code units', () => {
    // A body with an em dash must hash the same here as in Rust, which iterates .bytes().
    expect(directiveId('s', 'code', 'fix — now')).toMatch(/^[0-9a-f]{16}$/)
    expect(directiveId('s', 'code', 'fix — now')).not.toBe(directiveId('s', 'code', 'fix - now'))
  })
})

describe('stripDirectiveDecoration', () => {
  it('reports the wrappers it removed so a symmetric tail can be stripped', () => {
    expect(stripDirectiveDecoration('**bold**').wrappers).toEqual(['*', '*'])
  })

  it('does not treat a leading dash without a space as a bullet', () => {
    expect(stripDirectiveDecoration('-not-a-bullet').text).toBe('-not-a-bullet')
  })
})
