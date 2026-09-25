import { describe, it, expect } from 'vitest'
import { checkoutGoneDetail, checkoutGoneLabel, goneBranch, newlyGone } from './checkout-gone'
import type { GoneCheckout } from '../../shared/types'

const g = (over: Partial<GoneCheckout> = {}): GoneCheckout =>
  ({ terminalId: 't2', cwd: '/Users/x/.operator/worktrees/mantel-55da80', why: 'its .git file is missing', since: 1, ...over })

describe('checkout-gone', () => {
  it('announces only entries that are new by terminal id', () => {
    expect(newlyGone([], [g()]).map((x) => x.terminalId)).toEqual(['t2'])
    expect(newlyGone([g()], [g(), g({ terminalId: 't5' })]).map((x) => x.terminalId)).toEqual(['t5'])
    expect(newlyGone([g()], [g({ why: 'changed wording' })])).toEqual([])
  })

  it('names the branch main last saw, else the one the lane was launched on', () => {
    expect(goneBranch(g({ branch: 'ops/nat-cool-cero' }), 'operator/55da80')).toBe('ops/nat-cool-cero')
    expect(goneBranch(g(), 'operator/55da80')).toBe('operator/55da80')
    expect(checkoutGoneLabel(g({ branch: 'ops/nat-cool-cero' }))).toBe('Checkout was removed outside Operator · ops/nat-cool-cero')
    expect(checkoutGoneLabel(g())).toBe('Checkout was removed outside Operator')
  })

  it('says what was lost and what was not, and that nothing is repaired', () => {
    const d = checkoutGoneDetail(g({ branch: 'feat/puerta-home' }))
    expect(d).toContain('mantel-55da80: its .git file is missing')
    expect(d).toContain('commits on branch feat/puerta-home are not')
    expect(d).toContain('Nothing is repaired automatically')
  })
})
