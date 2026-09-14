import { describe, it, expect } from 'vitest'
import { announceCutoff, REPORT_ANNOUNCE_MAX_AGE_MS } from './comms'

describe('announceCutoff — reports older than this are not typed into a coordinator', () => {
  it('is twelve hours before now, as an ISO string the store compares against `at`', () => {
    expect(REPORT_ANNOUNCE_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000)
    expect(announceCutoff(Date.parse('2026-09-14T14:00:00.000Z'))).toBe('2026-09-14T02:00:00.000Z')
  })

  it('puts a nine-day-old report before the cutoff and one from this morning after it', () => {
    const cutoff = announceCutoff(Date.parse('2026-09-14T14:09:59.000Z'))
    expect('2026-09-05T19:37:08.673Z' < cutoff).toBe(true)
    expect('2026-09-14T14:14:18.284Z' < cutoff).toBe(false)
  })
})
