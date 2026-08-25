import { describe, it, expect } from 'vitest'
import { classify, reapPlanFrom, sourceRepoFromGitFile, type WorktreeFacts } from './worktree-reap'

/** A directory in the SAFEST-to-remove state. Every test below is this, minus one thing — which
 *  keeps each case about the single fact that moved it. */
const safe = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  path: '/Users/j/.operator/worktrees/repo-abc123',
  sizeBytes: 500 * 1024 * 1024,
  gitValid: true,
  branch: 'operator/abc123',
  dirty: false,
  registered: true,
  merged: true,
  provenance: { sourceRepo: '/Users/j/Developer/repo', createdAt: 1, branch: 'operator/abc123' },
  sourceRepoExists: true,
  liveTerminalId: undefined,
  guardReason: null,
  ...over,
})

describe('classify — the seven states the audit measured, plus corrupt', () => {
  it('merged + clean + attributable + not live is the AUTO tier', () => {
    expect(classify(safe())).toBe('merged-clean')
  })

  it('merged with uncommitted changes is its own class — not a permanent quarantine', () => {
    // 35 directories were in this state, and inspecting the largest showed a single `M CLAUDE.md`.
    // A blunt "any porcelain output = don't touch" rule is what defect #8 is about.
    expect(classify(safe({ dirty: true }))).toBe('merged-dirty')
  })

  it('an unmerged branch is an ask, however clean it is', () => {
    expect(classify(safe({ merged: false }))).toBe('unmerged')
    expect(classify(safe({ merged: false, dirty: false, registered: true }))).toBe('unmerged')
  })

  it('an UNKNOWN merge answer is an ask, never a removal', () => {
    // git could not say. That is not a "no", but it is certainly not grounds to delete — and
    // `unmerged` is the class whose meaning is "ask a human".
    expect(classify(safe({ merged: undefined }))).toBe('unmerged')
  })

  it('no provenance is `unattributed` even when everything else says safe', () => {
    // The codebase's own rule: the reaper removes only what Operator can PROVE it made.
    expect(classify(safe({ provenance: undefined }))).toBe('unattributed')
  })

  it('a live lane wins over EVERY other signal', () => {
    expect(classify(safe({ liveTerminalId: 't3' }))).toBe('live-claimed')
    expect(classify(safe({ liveTerminalId: 't3', gitValid: false, sourceRepoExists: false, sizeBytes: 0 })))
      .toBe('live-claimed')
  })

  it('a dead source repo outranks every git-based class — none of them can be answered', () => {
    expect(classify(safe({ sourceRepoExists: false }))).toBe('dead-source-repo')
    // The real shape: the four uwazi_2026-* dirs, git-invalid AND repo-gone. Calling those
    // "debris" would be wrong twice — they are 471 MB and they need a human decision.
    expect(classify(safe({ sourceRepoExists: false, gitValid: false, sizeBytes: 471 * 1024 * 1024 })))
      .toBe('dead-source-repo')
  })

  it('interrupted-create leftovers are debris: git-invalid, tiny, unregistered, unattributed', () => {
    const debris = safe({ gitValid: false, sizeBytes: 4096, provenance: undefined, registered: false })
    expect(classify(debris)).toBe('debris')
    expect(classify(safe({ gitValid: false, sizeBytes: 0, provenance: undefined, registered: false }))).toBe('debris')
  })

  // Measured: `.tmpIBNq7t-d96ee0` is 8 KB, holds one stray file, and its `.git` points at a repo
  // that is also gone. Both facts are true; only one of them should decide, and the audit is
  // explicit that debris is "zero risk, zero value in asking".
  it('inert debris stays debris even when its source repo is ALSO gone', () => {
    expect(classify(safe({
      gitValid: false, sizeBytes: 8 * 1024, provenance: undefined, registered: false, sourceRepoExists: false,
    }))).toBe('debris')
  })

  it('a git-invalid directory with real CONTENT is corrupt, not debris', () => {
    expect(classify(safe({ gitValid: false, provenance: undefined, registered: false, sizeBytes: 900 * 1024 * 1024 })))
      .toBe('corrupt')
  })

  it('a git-invalid directory that IS attributable or registered is corrupt, not debris', () => {
    expect(classify(safe({ gitValid: false, sizeBytes: 4096, registered: false }))).toBe('corrupt')
    expect(classify(safe({ gitValid: false, sizeBytes: 4096, provenance: undefined, registered: true }))).toBe('corrupt')
  })

  it('attribution is checked BEFORE merge status — a merged, clean, unattributable dir is an ask', () => {
    expect(classify(safe({ provenance: undefined, merged: true, dirty: false })))
      .toBe('unattributed')
  })
})

describe('reapPlanFrom — what the button acts on', () => {
  it('puts merged-clean, merged-dirty and debris in auto, and nothing else', () => {
    const plan = reapPlanFrom([
      safe({ path: '/w/clean' }),
      safe({ path: '/w/dirty', dirty: true }),
      safe({ path: '/w/debris', gitValid: false, sizeBytes: 4096, provenance: undefined, registered: false }),
      safe({ path: '/w/unmerged', merged: false }),
      safe({ path: '/w/unattributed', provenance: undefined }),
      safe({ path: '/w/live', liveTerminalId: 't1' }),
      safe({ path: '/w/dead', sourceRepoExists: false }),
    ])
    expect(plan.auto.map((e) => e.path).sort()).toEqual(['/w/clean', '/w/debris', '/w/dirty'])
    expect(plan.asks.map((e) => e.cls).sort())
      .toEqual(['dead-source-repo', 'live-claimed', 'unattributed', 'unmerged'])
  })

  // THE GUARD IS REUSED UNTOUCHED, and it is consulted for the PLAN, not only at removal time —
  // a button that says "Remove 24" and then removes 23 is worse than one that says 23.
  it('the removal guard pulls an entry out of auto whatever its class says', () => {
    const plan = reapPlanFrom([safe({ guardReason: 'path contains $HOME (/Users/j)' })])
    expect(plan.auto).toEqual([])
    expect(plan.asks[0].cls).toBe('merged-clean')
    expect(plan.asks[0].reason).toBe('Refused: path contains $HOME (/Users/j)')
  })

  it('a live lane is never in auto even if it somehow classified otherwise', () => {
    expect(reapPlanFrom([safe({ liveTerminalId: 't9' })]).auto).toEqual([])
  })

  it('flags the dirty ones as needing a commit first, and only those', () => {
    const plan = reapPlanFrom([safe({ path: '/w/a' }), safe({ path: '/w/b', dirty: true })])
    expect(plan.entries.find((e) => e.path === '/w/a')!.needsCommit).toBe(false)
    expect(plan.entries.find((e) => e.path === '/w/b')!.needsCommit).toBe(true)
  })

  it('totals bytes overall and for the auto tier separately — the button quotes the second', () => {
    const plan = reapPlanFrom([
      safe({ path: '/w/a', sizeBytes: 1000 }),
      safe({ path: '/w/b', sizeBytes: 2000, merged: false }),
    ])
    expect(plan.totalBytes).toBe(3000)
    expect(plan.autoBytes).toBe(1000)
  })

  it('marks sizes as omitted so a caller cannot render 0 GB as a fact', () => {
    expect(reapPlanFrom([safe({ sizeBytes: 0 })], true).sizesOmitted).toBe(true)
    expect(reapPlanFrom([safe()]).sizesOmitted).toBe(false)
  })

  it('is empty for an empty table rather than inventing an entry', () => {
    const plan = reapPlanFrom([])
    expect(plan).toMatchObject({ entries: [], auto: [], asks: [], totalBytes: 0, autoBytes: 0 })
  })

  it('gives every ask a sentence saying what is blocking it', () => {
    const plan = reapPlanFrom([
      safe({ path: '/w/u', merged: false, branch: 'operator/xyz' }),
      safe({ path: '/w/n', provenance: undefined }),
      safe({ path: '/w/l', liveTerminalId: 't4' }),
      safe({ path: '/w/d', sourceRepoExists: false }),
    ])
    expect(plan.asks.map((e) => e.reason)).toEqual([
      'operator/xyz is not merged into the default branch.',
      'No provenance record — Operator cannot prove it created this.',
      'A lane is open here (t4).',
      'Its source repository no longer exists on disk; git cannot reason about it.',
    ])
  })

  it('says so when the merge answer was UNKNOWN rather than claiming it is unmerged', () => {
    const plan = reapPlanFrom([safe({ merged: undefined, branch: 'operator/q' })])
    expect(plan.asks[0].reason).toBe('Could not tell whether operator/q is merged.')
  })
})

describe('the audit snapshot, replayed through the classifier', () => {
  // The four shapes the audit actually found on disk, so the policy is pinned against measured
  // reality rather than against the classes in the abstract.
  const snapshot: WorktreeFacts[] = [
    // 24 dirs / 11.85 GB — "merged AND clean AND not live-flagged", the immediately safe set.
    safe({ path: '/w/merged-clean', sizeBytes: 11.85 * 1024 ** 3 / 24 }),
    // The el-encanto shape: 500 MB, merged, one modified CLAUDE.md.
    safe({ path: '/w/one-line-dirty', dirty: true, sizeBytes: 550 * 1024 ** 2 }),
    // `.tmpIBNq7t-d96ee0` — one stray a.txt, no provenance, unregistered, git-invalid.
    safe({ path: '/w/.tmpIBNq7t-d96ee0', gitValid: false, sizeBytes: 8 * 1024, provenance: undefined, registered: false }),
    // uwazi_2026-* — source repo gone from disk entirely.
    safe({ path: '/w/uwazi_2026-a', gitValid: false, sourceRepoExists: false, sizeBytes: 118 * 1024 ** 2 }),
  ]

  it('auto-removes the safe set and the debris, and asks about the dead repo', () => {
    const plan = reapPlanFrom(snapshot)
    expect(plan.auto.map((e) => e.cls).sort()).toEqual(['debris', 'merged-clean', 'merged-dirty'])
    expect(plan.asks).toHaveLength(1)
    expect(plan.asks[0].cls).toBe('dead-source-repo')
  })

  it('never puts a dead-source-repo directory in the auto tier — no git command can reach it', () => {
    expect(reapPlanFrom(snapshot).auto.some((e) => e.path.includes('uwazi'))).toBe(false)
  })
})

describe('sourceRepoFromGitFile — how a directory with no provenance names its repo', () => {
  it('reads the repo root out of a linked worktree pointer', () => {
    expect(sourceRepoFromGitFile('gitdir: /Users/j/Developer/operator/.git/worktrees/operator-a30080\n'))
      .toBe('/Users/j/Developer/operator')
  })

  // The exact shape of the audit's four dead directories. Without this parse they classify as
  // merely `corrupt`, which hides the one case the audit says a human must decide.
  it('names a repo that no longer exists, which is the whole point', () => {
    expect(sourceRepoFromGitFile('gitdir: /Users/j/Documents/Claude/uwazi_2026/.git/worktrees/uwazi_2026-a5d0i5'))
      .toBe('/Users/j/Documents/Claude/uwazi_2026')
  })

  it('is undefined for a .git that is not a linked-worktree pointer', () => {
    expect(sourceRepoFromGitFile('gitdir: /somewhere/else/.git')).toBeUndefined()
    expect(sourceRepoFromGitFile('ref: refs/heads/main')).toBeUndefined()
    expect(sourceRepoFromGitFile('')).toBeUndefined()
  })

  it('tolerates trailing whitespace and CRLF', () => {
    expect(sourceRepoFromGitFile('gitdir: /r/.git/worktrees/w  \r\n')).toBe('/r')
  })
})
