import { describe, it, expect } from 'vitest'
import { localTime, localDay } from './local-time'

// EVERY test pins a zone explicitly. A test written in the runner's own zone passes against the
// bug this file exists to fix — if the runner is UTC, a string slice and a real conversion agree,
// and the suite would go green over the defect.
const GYE = 'America/Guayaquil' // UTC−5, no DST — the user's machine
const BER = 'Europe/Berlin'     // UTC+1/+2 — east of Greenwich, and it DOES observe DST

describe('localTime', () => {
  it('is the reported bug: 22:10Z reads 17:10 at UTC−5, not 22:10', () => {
    // Menu bar said Thu 30 Jul 5:12 PM while the channel said 22:10 — exactly +5:00.
    expect(localTime('2026-07-30T22:10:00.000Z', GYE)).toBe('17:10')
  })

  it('stays 24-hour, matching the dense mono column it renders into', () => {
    expect(localTime('2026-07-30T22:10:00.000Z', BER)).toBe('00:10') // next day, and not "24:10"
    expect(localTime('2026-07-30T05:00:00.000Z', GYE)).toBe('00:00') // midnight is 00, never 24
  })

  it('follows DST rather than a fixed offset', () => {
    // Berlin is +2 in July and +1 in January. A hardcoded offset gets one of these wrong.
    expect(localTime('2026-07-30T12:00:00.000Z', BER)).toBe('14:00')
    expect(localTime('2026-01-30T12:00:00.000Z', BER)).toBe('13:00')
  })

  it('renders nothing for an unusable timestamp rather than "NaN:NaN"', () => {
    expect(localTime('not a date', GYE)).toBe('')
    expect(localTime('', GYE)).toBe('')
  })
})

describe('localDay', () => {
  it('THE POINT: an instant whose UTC date and local date differ buckets LOCAL', () => {
    // 01:30Z on the 31st is 20:30 on the 30th at UTC−5. The slice said 2026-07-31.
    expect(localDay('2026-07-31T01:30:00.000Z', GYE)).toBe('2026-07-30')
  })

  it('covers the whole evening that used to file under tomorrow', () => {
    // From 19:00 local onward every instant already carries tomorrow's UTC date.
    for (const [utc, local] of [
      ['2026-07-31T00:00:00.000Z', '2026-07-30'], // 19:00 local — where it starts
      ['2026-07-31T03:59:00.000Z', '2026-07-30'], // 22:59 local
      ['2026-07-31T04:59:00.000Z', '2026-07-30'], // 23:59 local — the last minute
      ['2026-07-31T05:00:00.000Z', '2026-07-31'], // 00:00 local — genuinely a new day
    ]) {
      expect(localDay(utc, GYE), utc).toBe(local)
    }
  })

  it('works east of Greenwich too, where the error runs the other way', () => {
    // 23:30Z on the 30th is already 01:30 on the 31st in Berlin.
    expect(localDay('2026-07-30T23:30:00.000Z', BER)).toBe('2026-07-31')
  })

  it('crosses a month and a year boundary', () => {
    expect(localDay('2026-08-01T02:00:00.000Z', GYE)).toBe('2026-07-31')
    expect(localDay('2027-01-01T03:00:00.000Z', GYE)).toBe('2026-12-31')
  })

  it('keeps the key sortable and zero-padded, so grouping can compare it', () => {
    expect(localDay('2026-01-05T18:00:00.000Z', GYE)).toBe('2026-01-05')
    expect(localDay('2026-01-05T18:00:00.000Z', GYE) < localDay('2026-01-06T18:00:00.000Z', GYE)).toBe(true)
  })

  it('returns nothing for an unusable timestamp', () => {
    expect(localDay('nope', GYE)).toBe('')
  })
})
