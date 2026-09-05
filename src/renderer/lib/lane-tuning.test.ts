import { describe, it, expect } from 'vitest'
import { effortCommand, modelCommand, normalizeModelId } from './lane-tuning'
import { EFFORT_LEVELS } from './effort'
import { ROSTER_MODELS } from './roster'

// The failure these guard against is SILENT: a command that arrives as prose changes nothing and
// reports nothing, so the lane keeps running at the old setting while the UI shows the new one.
describe('the tuning commands are typed lines, not pasted text', () => {
  it('ends every command with a bare CR', () => {
    expect(effortCommand('high')).toBe('/effort high\r')
    expect(modelCommand('opus')).toBe('/model opus\r')
  })

  it('never wraps them in the bracketed-paste sequence the submit queue uses', () => {
    // \x1b[200~ … \x1b[201~ is what makes Claude Code read a block as pasted PROSE. A slash
    // command inside it is just a message that starts with a slash.
    for (const cmd of [effortCommand('max'), modelCommand('sonnet')]) {
      expect(cmd).not.toContain('\x1b[200~')
      expect(cmd).not.toContain('\x1b[201~')
    }
  })

  it('sends exactly one line — a second CR would submit an empty prompt after it', () => {
    for (const cmd of [effortCommand('low'), modelCommand('haiku')]) {
      expect(cmd.match(/\r/g)).toHaveLength(1)
      expect(cmd).not.toContain('\n')
    }
  })

  it('covers the whole effort ladder, `max` included', () => {
    // `max` is a real `/effort` value even though settings.json's enum drops it — see lib/effort.
    for (const level of EFFORT_LEVELS) {
      expect(effortCommand(level)).toBe(`/effort ${level}\r`)
    }
  })

  it('accepts every preset alias the roster offers', () => {
    for (const m of ROSTER_MODELS) {
      expect(modelCommand(m.id)).toBe(`/model ${m.id}\r`)
    }
  })
})

// The "Other…" field is free text with a pty on the other end. This is the only place that
// matters, so it is the only place that checks.
describe('normalizeModelId', () => {
  it('keeps a plain id and trims the edges', () => {
    expect(normalizeModelId('  claude-opus-5  ')).toBe('claude-opus-5')
  })

  it('REFUSES an embedded CR or LF — that is a second command, not a model id', () => {
    expect(normalizeModelId('sonnet\rwhoami')).toBeNull()
    expect(normalizeModelId('sonnet\nwhoami')).toBeNull()
  })

  it('refuses other control characters, including the escape that starts every sequence', () => {
    expect(normalizeModelId('son\x1bet')).toBeNull()
    expect(normalizeModelId('sonnet\x00')).toBeNull()
    expect(normalizeModelId('sonnet\x7f')).toBeNull()
  })

  it('refuses inner whitespace — `/model a b` would pass `b` as a second argument', () => {
    expect(normalizeModelId('opus latest')).toBeNull()
    expect(normalizeModelId('opus\tlatest')).toBeNull()
  })

  it('answers null for nothing typed, so the caller sends no command at all', () => {
    expect(normalizeModelId('')).toBeNull()
    expect(normalizeModelId('   ')).toBeNull()
  })

  it('round-trips into a command that is still a single line', () => {
    const id = normalizeModelId('  claude-fable-5-1 ')!
    expect(modelCommand(id).match(/\r/g)).toHaveLength(1)
  })
})
