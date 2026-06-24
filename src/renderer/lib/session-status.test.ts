import { describe, it, expect } from 'vitest'
import { sessionWaveStatus } from './session-status'

describe('sessionWaveStatus', () => {
  it('ended status wins over any phase', () => {
    expect(sessionWaveStatus({ status: 'ended', phase: 'running' })).toBe('ended')
  })
  it('maps known phases', () => {
    expect(sessionWaveStatus({ status: 'active', phase: 'running' })).toBe('running')
    expect(sessionWaveStatus({ status: 'active', phase: 'compacting' })).toBe('compacting')
    expect(sessionWaveStatus({ status: 'active', phase: 'waiting' })).toBe('waiting')
  })
  it('falls back to idle for unknown phases', () => {
    expect(sessionWaveStatus({ status: 'active', phase: 'whatever' })).toBe('idle')
    expect(sessionWaveStatus({ status: 'active', phase: '' })).toBe('idle')
  })
})
