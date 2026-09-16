import { describe, it, expect } from 'vitest'
import {
  classify, reapPlanFrom, sourceRepoFromGitFile, type WorktreeFacts,
  backfillRecords, gitdirFromGitFile, needsUnsavedConfirm, parseWorktreeList, provePairing,
  removalDecision, staleSizePaths, unsavedWorkOf, wouldAutoRemove, AUTO_REMOVE_GRACE_MS,
} from './worktree-reap'
import { isTrashEntryName, trashEntryName } from './worktree-trash'

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

// ── stage 1 cleanup: backfill, unsaved work, the report-only rule, manual removal ───────────────

const ROOT = '/Users/j/.operator/worktrees'
const REPO = '/Users/j/Developer/repo'
const WT_DIR = `${REPO}/.git/worktrees`

/** A fake disk: path → file contents. Anything absent reads as null, like a missing file. */
const disk = (files: Record<string, string>) => (p: string) => files[p] ?? null

/** The three files a real, correctly paired worktree has. */
const paired = (name: string) => ({
  [`${ROOT}/${name}/.git`]: `gitdir: ${WT_DIR}/${name}\n`,
  [`${WT_DIR}/${name}/gitdir`]: `${ROOT}/${name}/.git\n`,
})

describe('parseWorktreeList', () => {
  it('reads path and branch per block, and leaves a detached one without a branch', () => {
    const out = parseWorktreeList([
      `worktree ${REPO}`, 'HEAD abc', 'branch refs/heads/main', '',
      `worktree ${ROOT}/repo-1`, 'HEAD def', 'branch refs/heads/operator/1', '',
      `worktree ${ROOT}/repo-2`, 'HEAD 123', 'detached', '',
    ].join('\n'))
    expect(out).toEqual([
      { path: REPO, branch: 'main' },
      { path: `${ROOT}/repo-1`, branch: 'operator/1' },
      { path: `${ROOT}/repo-2`, branch: undefined },
    ])
  })
})

describe('provePairing — git vouches for the pairing from both ends', () => {
  it('accepts a .git file naming a direct admin child whose gitdir points back', () => {
    expect(provePairing(`${ROOT}/repo-1`, WT_DIR, disk(paired('repo-1')))).toBe(true)
  })

  it('accepts a relative gitdir, resolved against the worktree', () => {
    const files = {
      [`${ROOT}/repo-1/.git`]: 'gitdir: ../../../Developer/repo/.git/worktrees/repo-1\n',
      [`${WT_DIR}/repo-1/gitdir`]: `${ROOT}/repo-1/.git\n`,
    }
    expect(gitdirFromGitFile(files[`${ROOT}/repo-1/.git`], `${ROOT}/repo-1`)).toBe(`/Users/j/Developer/repo/.git/worktrees/repo-1`)
    expect(provePairing(`${ROOT}/repo-1`, WT_DIR, disk(files))).toBe(true)
  })

  it('refuses a .git file copied from another worktree — the back-reference names someone else', () => {
    const files = {
      [`${ROOT}/copy/.git`]: `gitdir: ${WT_DIR}/repo-1\n`,
      [`${WT_DIR}/repo-1/gitdir`]: `${ROOT}/repo-1/.git\n`,
    }
    expect(provePairing(`${ROOT}/copy`, WT_DIR, disk(files))).toBe(false)
  })

  it('refuses an admin entry that is not a direct child of the repo worktrees dir', () => {
    const files = {
      [`${ROOT}/repo-1/.git`]: `gitdir: ${WT_DIR}/nested/repo-1\n`,
      [`${WT_DIR}/nested/repo-1/gitdir`]: `${ROOT}/repo-1/.git\n`,
    }
    expect(provePairing(`${ROOT}/repo-1`, WT_DIR, disk(files))).toBe(false)
  })

  it('refuses when .git is not a readable file, or the admin entry is gone', () => {
    expect(provePairing(`${ROOT}/repo-1`, WT_DIR, disk({}))).toBe(false)
    expect(provePairing(`${ROOT}/repo-1`, WT_DIR, disk({ [`${ROOT}/repo-1/.git`]: `gitdir: ${WT_DIR}/repo-1\n` }))).toBe(false)
  })
})

describe('backfillRecords', () => {
  const listed = [
    { path: REPO, branch: 'main' },                          // the repo itself — not under the root
    { path: `${ROOT}/repo-1`, branch: 'operator/1' },        // proven, no record → backfilled
    { path: `${ROOT}/repo-2`, branch: 'operator/2' },        // already has provenance → skipped
    { path: `${ROOT}/repo-3`, branch: 'operator/3' },        // listed but the pairing fails → skipped
    { path: `${ROOT}/sub/repo-4`, branch: 'operator/4' },    // not a direct child of the root → skipped
  ]
  const read = disk({ ...paired('repo-1'), ...paired('repo-2'), [`${ROOT}/repo-3/.git`]: `gitdir: ${WT_DIR}/repo-3\n` })

  it('writes a record only for listed, proven, unrecorded direct children of the root', () => {
    const out = backfillRecords({ sourceRepo: REPO, worktreesDir: WT_DIR, listed }, new Set([`${ROOT}/repo-2`]), ROOT, read, () => 42)
    expect(out).toEqual([{ path: `${ROOT}/repo-1`, createdAt: 42, createdBy: 'backfill', sourceRepo: REPO, branch: 'operator/1' }])
  })

  it('moves a merged, previously unattributed directory into the normal classes', () => {
    const before = safe({ path: `${ROOT}/repo-1`, provenance: undefined })
    expect(classify(before)).toBe('unattributed')
    const [rec] = backfillRecords({ sourceRepo: REPO, worktreesDir: WT_DIR, listed }, new Set(), ROOT, read, () => 42)
    const after = { ...before, provenance: { sourceRepo: rec.sourceRepo, createdAt: rec.createdAt, branch: rec.branch } }
    expect(classify(after)).toBe('merged-clean')
    expect(classify({ ...after, merged: false })).toBe('unmerged')
  })
})

describe('unsavedWorkOf — the user rule: uncommitted files or commits on no other branch/remote', () => {
  it('none when clean and every commit is elsewhere', () => {
    const u = unsavedWorkOf(safe({ uncommittedCount: 0, unsavedCommits: 0 }))
    expect(u).toMatchObject({ known: true, any: false })
    expect(needsUnsavedConfirm(u)).toBe(false)
  })

  it('uncommitted files or unsaved commits each count', () => {
    expect(unsavedWorkOf(safe({ dirty: true, uncommittedCount: 2, unsavedCommits: 0 })).any).toBe(true)
    expect(unsavedWorkOf(safe({ uncommittedCount: 0, unsavedCommits: 1 })).any).toBe(true)
  })

  it('unknown when git cannot read the directory or could not answer — and unknown needs confirmation', () => {
    const invalid = unsavedWorkOf(safe({ gitValid: false }))
    expect(invalid.known).toBe(false)
    expect(needsUnsavedConfirm(invalid)).toBe(true)
    expect(needsUnsavedConfirm(unsavedWorkOf(safe({ uncommittedCount: 0, unsavedCommits: undefined })))).toBe(true)
  })
})

describe('wouldAutoRemove — report only', () => {
  const now = 10 * AUTO_REMOVE_GRACE_MS
  const idle = (over: Partial<WorktreeFacts> = {}) =>
    safe({ uncommittedCount: 0, unsavedCommits: 0, lastActivityAt: now - AUTO_REMOVE_GRACE_MS - 1, ...over })

  it('takes a clean, unclaimed worktree with no unsaved commits past the grace period', () => {
    expect(wouldAutoRemove(idle(), now)).toMatch(/Clean, no unsaved commits/)
  })

  it('does not require merged — nothing exists only here, and the branch is kept', () => {
    expect(wouldAutoRemove(idle({ merged: false }), now)).not.toBeNull()
  })

  it('refuses inside the grace period, with no activity time, or with unsaved or unknown work', () => {
    expect(wouldAutoRemove(idle({ lastActivityAt: now - 1000 }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ lastActivityAt: undefined }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ uncommittedCount: 1, dirty: true }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ unsavedCommits: 3 }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ unsavedCommits: undefined }), now)).toBeNull()
  })

  it('refuses a live lane, a guard refusal, or a directory without provenance', () => {
    expect(wouldAutoRemove(idle({ liveTerminalId: 't3' }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ guardReason: 'path is $HOME' }), now)).toBeNull()
    expect(wouldAutoRemove(idle({ provenance: undefined }), now)).toBeNull()
  })

  it('takes a git-orphaned worktree whose source repo exists, but not one whose repo is gone', () => {
    expect(wouldAutoRemove(safe({ gitValid: false, orphaned: true, lastActivityAt: now }), now)).toMatch(/pruned/)
    expect(wouldAutoRemove(safe({ gitValid: false, orphaned: true, sourceRepoExists: false }), now)).toBeNull()
  })

  it('lists it in the plan without touching the auto tier', () => {
    const plan = reapPlanFrom([idle({ merged: false })], true, now)
    expect(plan.wouldRemove).toHaveLength(1)
    expect(plan.auto).toHaveLength(0)
  })
})

describe('removalDecision — manual removal from Settings', () => {
  it('never removes a live-claimed directory, confirmed or not', () => {
    expect(removalDecision(safe({ liveTerminalId: 't1' }), true)).toMatchObject({ kind: 'refuse' })
  })

  it('needs the unsaved-work confirmation for unsaved or unknown work', () => {
    const dirty = safe({ dirty: true, uncommittedCount: 4, unsavedCommits: 0 })
    expect(removalDecision(dirty, false)).toMatchObject({ kind: 'refuse' })
    expect(removalDecision(dirty, true)).toEqual({ kind: 'git', sourceRepo: '/Users/j/Developer/repo' })
  })

  it('removes through git when a source repo exists, even without provenance (the pointer names it)', () => {
    const f = safe({ provenance: undefined, sourceRepoHint: REPO, uncommittedCount: 0, unsavedCommits: 0 })
    expect(removalDecision(f, false)).toEqual({ kind: 'git', sourceRepo: REPO })
  })

  it('deletes the directory without git when the source repo is gone — after confirmation, since git cannot tell', () => {
    const dead = safe({ gitValid: false, sourceRepoExists: false, provenance: undefined, sourceRepoHint: '/gone' })
    expect(removalDecision(dead, false)).toMatchObject({ kind: 'refuse' })
    expect(removalDecision(dead, true)).toEqual({ kind: 'plain' })
  })

  it('refuses whatever the guard refuses', () => {
    expect(removalDecision(safe({ guardReason: 'path is the repository itself' }), true)).toMatchObject({ kind: 'refuse' })
  })
})

describe('staleSizePaths — du only what the cache cannot answer', () => {
  const cache = { '/a': { bytes: 1, mtimeMs: 10 }, '/b': { bytes: 2, mtimeMs: 20 } }
  it('re-measures new and changed directories only', () => {
    expect(staleSizePaths(cache, new Map([['/a', 10], ['/b', 21], ['/c', 5]]), false)).toEqual(['/b', '/c'])
  })
  it('re-measures everything on refresh', () => {
    expect(staleSizePaths(cache, new Map([['/a', 10], ['/b', 20]]), true)).toEqual(['/a', '/b'])
  })
})

describe('trash entry names', () => {
  it('the sweep recognises only names it generates', () => {
    expect(isTrashEntryName(trashEntryName(1726500000000))).toBe(true)
    for (const bad of ['repo-abc123', 'wt-123-ABCDEF12', 'wt--deadbeef', 'wt-12-deadbee', '.operator-worktree-trash']) {
      expect(isTrashEntryName(bad)).toBe(false)
    }
  })
})
