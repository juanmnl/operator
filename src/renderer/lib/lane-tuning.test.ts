import { describe, it, expect } from 'vitest'
import { effortCommand, modelCommand, normalizeModelId } from './lane-tuning'
import { typedSequence } from './submit-queue'
import { EFFORT_LEVELS } from './effort'
import { ROSTER_MODELS } from './roster'

// The failure these guard against is SILENT: a command that arrives as prose changes nothing and
// reports nothing, so the lane keeps running at the old setting while the UI shows the new one.
describe('the command builders produce a LINE, and the transport terminates it', () => {
  it('has NO trailing CR — the transport adds exactly one', () => {
    // The regression QA-2 caught: both halves appended a CR, so the pty received
    // `/model opus\r\r` — a second bare Return straight after the command, into a live lane.
    expect(effortCommand('high')).toBe('/effort high')
    expect(modelCommand('opus')).toBe('/model opus')
  })

  it('carries no control characters at all, so only the transport can submit', () => {
    for (const cmd of [effortCommand('max'), modelCommand('sonnet'), effortCommand('low')]) {
      // eslint-disable-next-line no-control-regex
      expect(cmd).not.toMatch(/[\x00-\x1f\x7f]/)
    }
  })

  it('composes with typedSequence into exactly one submitted line', () => {
    // The property the two halves have to hold TOGETHER, which is what neither test checked
    // before: builder + transport = one command, one terminator.
    const sent = typedSequence(modelCommand('opus'))
    expect(sent).toBe('/model opus\r')
    expect(sent.match(/\r/g)).toHaveLength(1)
    expect(sent).not.toContain('\n')
  })

  it('is never wrapped in the bracketed-paste sequence the queue uses for prose', () => {
    // \x1b[200~ … \x1b[201~ is what makes Claude Code read a block as pasted PROSE. A slash
    // command inside it is just a message that starts with a slash.
    const sent = typedSequence(effortCommand('high'))
    expect(sent).not.toContain('\x1b[200~')
    expect(sent).not.toContain('\x1b[201~')
  })

  it('covers the whole effort ladder, `max` included', () => {
    // `max` is a real `/effort` value even though settings.json's enum drops it — see lib/effort.
    for (const level of EFFORT_LEVELS) {
      expect(typedSequence(effortCommand(level))).toBe(`/effort ${level}\r`)
    }
  })

  it('accepts every preset alias the roster offers', () => {
    for (const m of ROSTER_MODELS) {
      expect(typedSequence(modelCommand(m.id))).toBe(`/model ${m.id}\r`)
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
    expect(typedSequence(modelCommand(id)).match(/\r/g)).toHaveLength(1)
  })
})
