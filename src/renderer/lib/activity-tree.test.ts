import { describe, it, expect } from 'vitest'
import { buildActivityTree } from './activity-tree'

// Minimal entry shape the tree builder cares about.
const tool = (toolName: string) => ({ toolName, kind: 'tool' as const })
const delegate = (toolName: string) => ({ toolName, kind: 'delegate' as const })
const subStart = () => ({ toolName: 'Subagent started', kind: 'subagent' as const })
const subDone = () => ({ toolName: 'Subagent finished', kind: 'subagent' as const })

describe('buildActivityTree', () => {
  it('returns an empty tree for no activity', () => {
    expect(buildActivityTree([])).toEqual([])
  })

  it('keeps flat tool calls at the root', () => {
    const tree = buildActivityTree([tool('Read'), tool('Edit')])
    expect(tree.map((n) => n.entry.toolName)).toEqual(['Read', 'Edit'])
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('nests a delegation\'s subagent and the tools it runs', () => {
    const tree = buildActivityTree([
      delegate('Task'),
      subStart(),
      tool('Read'),
      tool('Edit'),
      subDone(),
      tool('Write'), // back at root after the group closes
    ])
    expect(tree.length).toBe(2)
    const [task, write] = tree
    expect(task.entry.toolName).toBe('Task')
    expect(write.entry.toolName).toBe('Write')
    // Task -> subagent -> [Read, Edit]
    expect(task.children.length).toBe(1)
    const sub = task.children[0]
    expect(sub.children.map((n) => n.entry.toolName)).toEqual(['Read', 'Edit'])
  })

  it('tolerates a SubagentStop with no open group', () => {
    const tree = buildActivityTree([subDone(), tool('Read')])
    expect(tree.map((n) => n.entry.toolName)).toEqual(['Read'])
  })

  it('opens an ungroup-parented subagent at the root when no delegation precedes it', () => {
    const tree = buildActivityTree([subStart(), tool('Read')])
    expect(tree.length).toBe(1)
    expect(tree[0].children.map((n) => n.entry.toolName)).toEqual(['Read'])
  })
})
