import { describe, it, expect } from 'vitest'
import type { DispatchRecord, Role } from '../../shared/types'
import {
  CHANNEL_MAX_CHARS, validateChannelMessage, planChannelSend, summariseGroup,
  type ChannelLane,
} from './channel-send'

const role = (id: string): Role => ({ id, name: id[0].toUpperCase() + id.slice(1), model: 'opus' })
const lanes: ChannelLane[] = [
  { role: role('operator'), terminalId: 't0' },
  { role: role('code'), terminalId: 't1' },
  { role: role('design') }, // idle — no terminal
  { role: role('qa') },     // idle
]

describe('validateChannelMessage — the cap refuses, never truncates', () => {
  it('accepts a normal message', () => {
    expect(validateChannelMessage('ship it')).toEqual({ ok: true, over: 0 })
  })

  it('refuses 2001 characters and says by how much', () => {
    const res = validateChannelMessage('x'.repeat(CHANNEL_MAX_CHARS + 1))
    expect(res.ok).toBe(false)
    expect(res.over).toBe(1)
    expect(res.error).toContain('1 over the 2000 limit')
  })

  it('accepts exactly the cap — the boundary is inclusive', () => {
    expect(validateChannelMessage('x'.repeat(CHANNEL_MAX_CHARS)).ok).toBe(true)
  })

  it('measures the TRIMMED length, so trailing whitespace cannot tip it over', () => {
    expect(validateChannelMessage('x'.repeat(CHANNEL_MAX_CHARS) + '\n\n  ').ok).toBe(true)
  })

  it('refuses an empty or whitespace-only message', () => {
    expect(validateChannelMessage('').ok).toBe(false)
    expect(validateChannelMessage('   \n ').ok).toBe(false)
  })
})

describe('planChannelSend — an idle lane is NEVER launched', () => {
  it('sends to one live lane', () => {
    const { records, skipped } = planChannelSend('hello', 'code', lanes, 'g1')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ fromHuman: true, toRoleId: 'code', outcome: 'sent', terminalId: 't1' })
    expect(records[0].groupId).toBeUndefined() // single target → no group row
    expect(skipped).toEqual([])
  })

  it('QUEUES an idle target and reports it — no spawn, ever', () => {
    // Deliberately unlike OPERATOR-DISPATCH, which launches an idle lane because a dispatch is
    // work. A message is not work, and a text box that spawns sessions is unbounded.
    const { records, skipped } = planChannelSend('nice', 'design', lanes, 'g1')
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('queued')
    expect(records[0].terminalId).toBeUndefined() // nothing to write to, nothing launched
    expect(skipped.map((r) => r.id)).toEqual(['design'])
  })

  it('fans out to everyone: one record per lane, shared groupId, idle ones queued', () => {
    const { records, skipped } = planChannelSend('standup', 'everyone', lanes, 'g-fan')
    expect(records).toHaveLength(4) // capped by the roster; no repeats
    expect(new Set(records.map((r) => r.groupId))).toEqual(new Set(['g-fan']))
    expect(records.filter((r) => r.outcome === 'sent').map((r) => r.toRoleId)).toEqual(['operator', 'code'])
    expect(records.filter((r) => r.outcome === 'queued').map((r) => r.toRoleId)).toEqual(['design', 'qa'])
    expect(skipped.map((r) => r.id)).toEqual(['design', 'qa'])
  })

  it('addresses each lane at most once', () => {
    const { records } = planChannelSend('once', 'everyone', lanes, 'g')
    expect(new Set(records.map((r) => r.toRoleId)).size).toBe(records.length)
  })

  it('plans nothing for an unknown target', () => {
    expect(planChannelSend('hi', 'ghost', lanes, 'g').records).toEqual([])
  })

  it('trims the text it records', () => {
    expect(planChannelSend('  padded  ', 'code', lanes, 'g').records[0].task).toBe('padded')
  })

  it('an all-idle roster still records, and still launches nothing', () => {
    const idle: ChannelLane[] = [{ role: role('code') }, { role: role('qa') }]
    const { records, skipped } = planChannelSend('anyone?', 'everyone', idle, 'g')
    expect(records.every((r) => r.outcome === 'queued' && !r.terminalId)).toBe(true)
    expect(skipped).toHaveLength(2)
  })
})

describe('summariseGroup', () => {
  const rec = (outcome: DispatchRecord['outcome']): DispatchRecord =>
    ({ id: crypto.randomUUID(), at: '2026-07-30T10:00:00.000Z', task: 't', outcome })

  it('reports delivered over total, and calls out the queued', () => {
    expect(summariseGroup([rec('sent'), rec('sent'), rec('queued')])).toBe('delivered 2/3 · 1 queued')
  })

  it('omits the queued clause when there are none', () => {
    expect(summariseGroup([rec('sent'), rec('launched')])).toBe('delivered 2/2')
  })

  it('is honest when nothing was delivered', () => {
    expect(summariseGroup([rec('queued'), rec('queued')])).toBe('delivered 0/2 · 2 queued')
  })
})
