import type { GoneCheckout } from '../../shared/types'

// A lane whose checkout was removed outside Operator (electron/src/main/checkout-health.ts). Main
// sends the whole list whenever it changes; these decide what the lane header says and which
// entries are new enough to announce. Pure.

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

/** Entries in `next` that were not in `prev`, by terminal id: the ones to announce once. */
export function newlyGone(prev: readonly GoneCheckout[], next: readonly GoneCheckout[]): GoneCheckout[] {
  const before = new Set(prev.map((g) => g.terminalId))
  return next.filter((g) => !before.has(g.terminalId))
}

/** The branch to name: what main last saw checked out there, else the one the tab was launched on. */
export function goneBranch(g: GoneCheckout, launchBranch?: string): string | undefined {
  return g.branch ?? launchBranch
}

/** The lane-header chip. */
export function checkoutGoneLabel(g: GoneCheckout, launchBranch?: string): string {
  const b = goneBranch(g, launchBranch)
  return `Checkout was removed outside Operator${b ? ` · ${b}` : ''}`
}

/** The chip's tooltip and the toast's detail: what happened, and what it does and does not mean. */
export function checkoutGoneDetail(g: GoneCheckout, launchBranch?: string): string {
  const b = goneBranch(g, launchBranch)
  return `${baseName(g.cwd)}: ${g.why}. Something outside Operator removed it, often `
    + '`gh pr merge --delete-branch` for a branch checked out there. '
    + `Files not committed there are gone; commits on ${b ? `branch ${b}` : 'its branch'} are not. Nothing is repaired automatically.`
}
