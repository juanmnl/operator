import { describe, it, expect } from 'vitest'
import type { NarrationEntry } from '../../shared/types'
import { coalesceTools, runLabel, runDetail, type ToolRun } from './tool-blocks'

const tool = (name: string, target?: string, caller?: string): NarrationEntry =>
  ({ kind: 'tool', text: name, timestamp: 't', tool: { name, target, caller } })
const prose = (text: string): NarrationEntry => ({ kind: 'text', text, timestamp: 't' })

describe('coalesceTools', () => {
  it('folds a run of same-tool calls into one line', () => {
    const out = coalesceTools([tool('Read', 'a.ts'), tool('Read', 'b.ts'), tool('Read', 'c.ts')])
    expect(out).toHaveLength(1)
    expect(runLabel(out[0] as ToolRun)).toBe('Read 3 files')
  })

  it('does not fold across a different tool, or across prose', () => {
    const out = coalesceTools([tool('Read', 'a.ts'), tool('Edit', 'a.ts'), prose('done'), tool('Edit', 'b.ts')])
    expect(out.map((x) => ('kind' in x ? x.kind : '?'))).toEqual(['toolrun', 'toolrun', 'text', 'toolrun'])
  })

  it("never merges a SUBAGENT's calls into the lead's", () => {
    // `caller` is on every real tool_use; folding across it would misattribute the work.
    const out = coalesceTools([tool('Read', 'a.ts'), tool('Read', 'b.ts', 'sub-1'), tool('Read', 'c.ts', 'sub-1')])
    expect(out).toHaveLength(2)
    expect((out[0] as ToolRun).calls).toHaveLength(1)
    expect((out[1] as ToolRun).calls).toHaveLength(2)
    expect((out[1] as ToolRun).caller).toBe('sub-1')
  })

  it('names a single call with its target, and an unknown tool honestly', () => {
    const one = coalesceTools([tool('Read', 'src/app.ts')])[0] as ToolRun
    expect(runLabel(one)).toBe('Read a file')
    expect(runDetail(one)).toBe('src/app.ts')
    const odd = coalesceTools([tool('SomeNewTool'), tool('SomeNewTool')])[0] as ToolRun
    expect(runLabel(odd)).toBe('SomeNewTool ×2')
  })

  it('passes non-tool entries through untouched', () => {
    const out = coalesceTools([prose('a'), prose('b')])
    expect(out).toEqual([prose('a'), prose('b')])
  })
})
