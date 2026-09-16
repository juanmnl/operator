import { describe, it, expect } from 'vitest'
import { beaconLevel, BEACON_PERIOD_S, BEACON_ATTACK_S, BEACON_DECAY_S } from './beacon'

describe('beaconLevel — the asking flash', () => {
  it('rises to full at the end of the attack and is dark for the rest gap', () => {
    expect(beaconLevel(0)).toBeCloseTo(0, 6)
    expect(beaconLevel(BEACON_ATTACK_S - 1e-9)).toBeCloseTo(1, 6)
    expect(beaconLevel(BEACON_ATTACK_S + BEACON_DECAY_S)).toBe(0)
    for (let t = BEACON_ATTACK_S + BEACON_DECAY_S; t < BEACON_PERIOD_S; t += 0.01) expect(beaconLevel(t)).toBe(0)
  })

  it('has a rest gap longer than the flash, which is what the twinkle never has', () => {
    const gap = BEACON_PERIOD_S - BEACON_ATTACK_S - BEACON_DECAY_S
    expect(gap).toBeGreaterThan(BEACON_ATTACK_S + BEACON_DECAY_S)
  })

  it('attacks fast and decays slower: a flash, not a breath', () => {
    expect(BEACON_ATTACK_S * 3).toBeLessThan(BEACON_DECAY_S)
  })

  it('repeats on absolute time and never leaves [0,1]', () => {
    expect(beaconLevel(0.07)).toBeCloseTo(beaconLevel(0.07 + BEACON_PERIOD_S * 41), 6)
    expect(beaconLevel(-0.2)).toBeCloseTo(beaconLevel(BEACON_PERIOD_S - 0.2), 6)
    for (let t = -4; t < 9; t += 0.013) {
      const l = beaconLevel(t)
      expect(l).toBeGreaterThanOrEqual(0)
      expect(l).toBeLessThanOrEqual(1)
    }
  })
})
