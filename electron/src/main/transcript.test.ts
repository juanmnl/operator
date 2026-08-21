import { describe, it, expect } from 'vitest'
import { derivePhase, isInjectedTurn, toolResultText, userPromptText } from './transcript'

describe('derivePhase', () => {
  it('is running while a tool is open', () => {
    expect(derivePhase(true, null, false)).toBe('running')
  })
  it('is running when the last stop was a tool_use — the turn has more to do', () => {
    expect(derivePhase(false, 'tool_use', false)).toBe('running')
  })
  it('is running right after a user prompt, before the response starts', () => {
    expect(derivePhase(false, null, true)).toBe('running')
  })
  it('is waiting once the turn ended and nothing is open', () => {
    expect(derivePhase(false, 'end_turn', false)).toBe('waiting')
  })
})

describe('isInjectedTurn', () => {
  it('recognises the turns Claude Code injects', () => {
    for (const p of ['<local-command-stdout>x', '<command-name>/foo', '<system-reminder>hi', '<task-notification>done', '<synthetic>x']) {
      expect(isInjectedTurn(p), p).toBe(true)
    }
  })
  it('tolerates leading whitespace', () => {
    expect(isInjectedTurn('\n  <system-reminder>x')).toBe(true)
  })
  it('leaves a real prompt alone', () => {
    expect(isInjectedTurn('fix the login button')).toBe(false)
    // A prompt that merely MENTIONS a tag is not injected.
    expect(isInjectedTurn('what does <system-reminder> mean?')).toBe(false)
  })
})

// Storing the raw JSON here kept about a third of real results as `[{"type":"text",...}]`
// instead of the output — the transcript showed the wrapper, not the answer.
describe('toolResultText', () => {
  it('passes a plain string through', () => {
    expect(toolResultText('hello')).toBe('hello')
  })
  it('FLATTENS an array of blocks to their text', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
  it('is empty for null/undefined', () => {
    expect(toolResultText(null)).toBe('')
    expect(toolResultText(undefined)).toBe('')
  })
})

describe('userPromptText', () => {
  it('reads a plain string prompt', () => {
    expect(userPromptText('do the thing')).toBe('do the thing')
  })
  it('joins text blocks', () => {
    expect(userPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
  it('returns null for a tool_result turn — same `user` type, not a prompt', () => {
    expect(userPromptText([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }])).toBeNull()
  })
  it('returns null for whitespace-only content', () => {
    expect(userPromptText([{ type: 'text', text: '   ' }])).toBeNull()
  })
})
