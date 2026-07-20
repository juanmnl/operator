import { describe, it, expect } from 'vitest'
import { summarizeDiff, taskHasDiffSource } from './task-diff'
import type { WorktreeDiff } from '../../shared/types'

const diff: WorktreeDiff = {
  branch: 'operator/abc123',
  files: [
    { path: 'src/a.ts', status: 'M ', added: 10, removed: 2 },
    { path: 'src/b.ts', status: '??', added: 5, removed: 0 },
  ],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y',
}

describe('task-diff', () => {
  it('summarizeDiff collapses files into a files/+/− stat', () => {
    expect(summarizeDiff(diff)).toEqual({ files: 2, added: 15, removed: 2 })
  })

  it('summarizeDiff is undefined for empty/no diff (no misleading 0/0/0 chip)', () => {
    expect(summarizeDiff(null)).toBeUndefined()
    expect(summarizeDiff({ files: [], diff: '' })).toBeUndefined()
  })

  it('taskHasDiffSource: live dir OR full branch provenance', () => {
    expect(taskHasDiffSource({ cwd: '/tmp/wt' })).toBe(true)
    expect(taskHasDiffSource({ sourceCwd: '/repo', worktreeBranch: 'operator/x', worktreeBase: 'main' })).toBe(true)
    // Partial branch info is not resolvable.
    expect(taskHasDiffSource({ sourceCwd: '/repo', worktreeBranch: 'operator/x' })).toBe(false)
    expect(taskHasDiffSource({})).toBe(false)
  })
})
