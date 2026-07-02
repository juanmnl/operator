import { describe, it, expect } from 'vitest'
import { parseBlocks, parseInline } from './canvas-md'

describe('parseInline', () => {
  it('splits bold / italic / code runs', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ' }, { text: 'b', bold: true }, { text: ' c' },
    ])
    expect(parseInline('_i_ and `x`')).toEqual([
      { text: 'i', italic: true }, { text: ' and ' }, { text: 'x', code: true },
    ])
  })

  it('parses links to a href span', () => {
    expect(parseInline('see [docs](https://x.dev)')).toEqual([
      { text: 'see ' }, { text: 'docs', href: 'https://x.dev' },
    ])
  })

  it('treats code as opaque (no nested markers)', () => {
    expect(parseInline('`a*b*c`')).toEqual([{ text: 'a*b*c', code: true }])
  })

  it('emits unmatched markers as literal text (streaming-safe)', () => {
    expect(parseInline('half **open')).toEqual([{ text: 'half **open' }])
  })

  it('never returns an empty array', () => {
    expect(parseInline('')).toEqual([{ text: '' }])
  })
})

describe('parseBlocks', () => {
  it('classifies headings, rules, and paragraphs', () => {
    const b = parseBlocks('# Title\n\nbody text\n\n---')
    expect(b[0]).toEqual({ type: 'heading', level: 1, spans: [{ text: 'Title' }] })
    expect(b[1]).toEqual({ type: 'paragraph', spans: [{ text: 'body text' }] })
    expect(b[2]).toEqual({ type: 'hr' })
  })

  it('captures fenced code verbatim with its language, no inline parse', () => {
    const b = parseBlocks('```ts\nconst a = **1**\n```')
    expect(b).toEqual([{ type: 'code', lang: 'ts', text: 'const a = **1**' }])
  })

  it('parses ordered + unordered list items with indent depth', () => {
    const b = parseBlocks('- one\n2. two\n  - nested')
    expect(b[0]).toMatchObject({ type: 'list', ordered: false, depth: 0 })
    expect(b[1]).toMatchObject({ type: 'list', ordered: true, index: 2, depth: 0 })
    expect(b[2]).toMatchObject({ type: 'list', ordered: false, depth: 1 })
  })

  it('joins wrapped paragraph lines and parses inline within', () => {
    const b = parseBlocks('hello **world**\ncontinued')
    expect(b).toEqual([{ type: 'paragraph', spans: [
      { text: 'hello ' }, { text: 'world', bold: true }, { text: ' continued' },
    ] }])
  })

  it('parses blockquotes', () => {
    expect(parseBlocks('> quoted')).toEqual([{ type: 'quote', spans: [{ text: 'quoted' }] }])
  })
})
